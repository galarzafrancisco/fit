# Fit

An MCP-first fitness activity platform. Fit imports your workouts from
**Strava** and **Garmin**, keeps them in one durable, normalized store, and
lets AI assistants such as Claude or ChatGPT query them over MCP. Sign-in is
federated to Taico, as in [money](https://github.com/galarzafrancisco/money).

```
Claude / ChatGPT ──MCP (Taico token)──► Fit /mcp ─┐
                                                  ├─► activities (Postgres)
Strava / Garmin ──OAuth, webhooks, sync──► Fit ───┘
```

## Quick start

```bash
npm run build:dev     # npm ci, build everything, verify @taico/auth
npm run dev           # http://localhost:4190 with embedded PGlite
curl localhost:4190/health
```

To connect real providers, set the variables in [.env.example](.env.example)
and follow [docs/providers/strava.md](docs/providers/strava.md). To use Fit
from an AI client, see [docs/mcp.md](docs/mcp.md).

## Layout

```
apps/backend/             NestJS backend: MCP + REST, OAuth, webhooks, sync, persistence
packages/activity-model/  provider-neutral activity model and Strava/Garmin normalizers
docs/                     architecture, configuration, providers, MCP, CI, deployment, review guides
```

## Commands

| Command | What it does |
|---|---|
| `npm run build:dev` | Clean install, build every project, verify `@taico/auth` imports |
| `npm run dev` | Backend in watch mode (port 4190) |
| `npm test` | Every project's tests (PGlite; `TEST_POSTGRES_URL` adds Postgres) |
| `npm run typecheck` / `lint` / `format:check` | Static checks, as CI runs them |
| `npm start` | Run the built backend |

## Documentation

Start with [AGENTS.md](AGENTS.md) (rules and boundaries) and
[docs/README.md](docs/README.md) (index). Provider limitations, especially
Garmin's approval-based program, are in [docs/providers/](docs/providers/).

Requires Node >= 20 (CI and the image use Node 24).
