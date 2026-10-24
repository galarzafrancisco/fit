# AGENTS.md

Guidance for coding agents (Claude Code, Codex and others) and human contributors
working in this repository. `CLAUDE.md` imports this file, so keep the rules here.

## What Fit is

Fit is an **MCP-first fitness activity platform**. It imports a user's workouts
from **Strava** and **Garmin**, stores them durably in one normalized model,
and lets authorized AI clients (Claude, ChatGPT, any MCP client) list, filter
and summarize them. The same services sit behind an MCP server (`/mcp`) and a
REST API (`/api`).

### Product boundaries (non-negotiable)

- Fit **only reads** from providers. It never creates, edits or deletes
  anything on Strava or Garmin. The only write-like calls are OAuth token
  exchange/refresh and deauthorization when the user disconnects.
- Providers are reached **only through official APIs** with the user's own
  grant (Strava OAuth; Garmin: the user's own Personal API key, never shared): no scraping, no stored passwords, no unofficial endpoints. A new
  provider needs an adapter behind `ProviderAdapter` and explicit approval.
- Authentication is **federated to Taico** through the published
  `@taico/auth` package, as in money. Fit has no local login, passwords or sign-up.
- **Strict user isolation** on every transport. The user comes only from the
  validated token's `(iss, sub)`. Another user's resource answers `404`, never
  `403`. Webhooks are routed to a user only through a stored provider
  connection, never through anything in the request.
- Provider tokens are **encrypted at rest** (`TOKEN_ENCRYPTION_KEY`) and are
  never returned, logged or stored in payload tables.
- Imported data is **never destructively overwritten**: every distinct
  provider payload is kept in `activity_payloads`; provider deletions set
  `deleted_at`.
- Fit is not medical advice. Do not make health or training claims in code,
  docs, tool descriptions or UI copy.

## Development

```bash
npm run build:dev   # cloned -> ready: npm ci, build every project, verify @taico/auth imports
npm run dev         # backend in watch mode (http://localhost:4190), embedded PGlite in apps/backend/.data
npm test            # every project's tests (PGlite; set TEST_POSTGRES_URL to also cover Postgres)
npm run typecheck   # every project
npm run lint        # ESLint
npm run format      # Prettier (CI runs format:check)
```

Copy `.env.example` to configure providers locally; nothing is required to boot.
Without provider credentials the app runs and reports Strava/Garmin as unavailable.

### After making changes

1. `npm run build:dev`: everything compiles.
2. `npm run lint && npm run format:check && npm test`: all green. Say so if you
   did not run the backend suite against Postgres (`TEST_POSTGRES_URL`).
3. `npm run dev`: the app starts, `/health` answers, unauthenticated `/api`
   and `/mcp` answer `401`.

CI (`.github/workflows/ci.yml`) runs formatting, lint, build, typecheck, the
tests on Postgres **and** PGlite, dependency audit, a secret scan and a
hardened container smoke test. See [docs/ci.md](docs/ci.md).

## Repository layout

```
apps/
└── backend/           @fit/backend: NestJS 11, TypeORM, Postgres/PGlite, MCP SDK, zod, Jest
packages/
└── activity-model/    @fit/activity-model: provider-neutral activity model, sport taxonomy,
                       Strava/Garmin normalizers (pure TypeScript, no I/O)
docs/                  architecture, configuration, providers, MCP, CI, deployment, review guides
```

## Architecture in one paragraph

```
MCP tools ─────┐
REST routes ───┼─► services (zod parsing, rules) ─► repositories (user-scoped) ─► Postgres
OAuth callback ┘        │                    ▲
Provider webhooks ─► inbox (durable) ─► worker ┘
                        └─► ProviderAdapter (Strava | Garmin) ─► provider APIs
```

Adapters (MCP tools, controllers) are thin. Services own validation and rules.
`ActivityIngestService` is the **only** write path for activities (syncs and
webhooks both use it). Provider specifics live **only** in
`apps/backend/src/providers/<name>/` and `packages/activity-model`. Details:
[docs/architecture.md](docs/architecture.md).

## Guides

| Area | Design guide | Review checklist |
|---|---|---|
| Layering, services, data model | [architecture.md](docs/architecture.md) | [controller](docs/review-guides/controller.md), [service](docs/review-guides/service.md) |
| Input schemas | [architecture.md](docs/architecture.md#schemas-and-errors) | [schema](docs/review-guides/schema.md) |
| Entities and migrations | [architecture.md](docs/architecture.md#data-model) | [entity](docs/review-guides/entity.md) |
| Errors | [architecture.md](docs/architecture.md#schemas-and-errors) | [error](docs/review-guides/error.md) |
| MCP tools | [mcp.md](docs/mcp.md) | [mcp](docs/review-guides/mcp.md) |
| Providers and webhooks | [providers/](docs/providers/), [webhooks.md](docs/webhooks.md) | [provider](docs/review-guides/provider.md) |
| Design (output conventions, future UI) | [design/guidelines.md](docs/design/guidelines.md) | |
| Node project setup | [best-practices/node.md](docs/best-practices/node.md) | |
| Writing review guides | | [review-guide](docs/review-guides/review-guide.md) |

## Database migrations

- The schema changes **only through migrations** in
  `apps/backend/src/database/migrations`. Schema synchronization is never enabled.
- Register every new migration and entity in `apps/backend/src/database/entities.ts`,
  migrations in chronological order. Migrations run on startup.
- Each migration has a working `down` (`persistence.e2e.spec.ts` runs down/up).
- The SQL runs on both Postgres and PGlite: one dialect, one migration set.
- Check constraints mirror the `as const` lists in entity files; change both together.

## `@taico/auth`

Taico federated auth comes from the published
[`@taico/auth`](https://www.npmjs.com/package/@taico/auth) npm package, a regular
dependency of `@fit/backend`, wired the same way as money (`src/auth/`). Do not
copy or patch it here: fix it upstream in ai-monorepo, publish, bump.
`npm run verify:auth` checks that every public subpath of the installed package loads.

## Secrets

Never commit credentials, tokens or real user data. `.env*` files are ignored
(except `.env.example`, which holds placeholders only), and CI scans history
with gitleaks. Tests use the in-memory fake providers in
`apps/backend/src/test-support/fake-providers.ts`, never live APIs.
