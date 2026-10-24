# Architecture

Fit follows money's structure: an Nx + npm-workspaces monorepo, a NestJS
backend with thin adapters over transport-independent services, TypeORM on
Postgres (PGlite for development and tests, one SQL dialect), zod input
schemas, and Taico federated auth through `@taico/auth`.

## Components

```
                ┌────────────────────────── apps/backend ──────────────────────────┐
AI client ─MCP─►│ McpController ─► FitMcpServerFactory (tools, resources)          │
REST client ───►│ ApiController                                    │               │
                │        │ both call the same services             ▼               │
                │  ConnectionsService  SyncService  ActivitiesService (read side)  │
Browser ───────►│  ConnectCallbackController (OAuth return)                        │
                │        │                │                                        │
                │        ▼                ▼                                        │
                │  ProviderRegistry ─► StravaAdapter | GarminAdapter ─► provider APIs
                │                         ▲                                        │
Strava ─────────►│ WebhooksController ─► WebhookInbox (store, 200) ─► WebhookWorker │
                │                                             └─► WebhookHandlers  │
                │  ActivityIngestService: the single activity write path           │
                └───────────────────────────────┬──────────────────────────────────┘
                                                ▼
                                     Postgres / PGlite (migrations)
packages/activity-model: Provider/Sport taxonomy + mapStravaActivity / mapGarminActivity (pure)
```

### Layering rules

1. **One implementation of each rule.** MCP tools and REST routes call the same
   service methods; a rule in only one adapter is a bug.
2. **Adapters are thin.** They take the user from the token (`@AuthenticatedUser()`,
   or bound when the per-request MCP server is built) and pass raw input through.
3. **Services parse input** with zod (`parseInput`) and throw only `DomainError`s.
4. **User scoping everywhere.** Every user-facing query filters on `user_id`;
   malformed or foreign IDs are `not_found`.
5. **Provider knowledge is isolated.** URLs, payload shapes, scopes and quirks
   live in `providers/<name>/` and `@fit/activity-model`. Everything else works
   on `NormalizedActivity` and `ProviderAdapter`.
6. **One write path.** `ActivityIngestService.ingest` is used by syncs and
   webhooks; nothing else inserts or updates activities.

## Data model

All tables are created by `database/migrations/1761200000000-InitialSchema.ts`.

| Table | Purpose | Key constraints |
|---|---|---|
| `users` | A Taico identity, created on first call | unique `(issuer, subject)` |
| `provider_connections` | A user's link to one provider account; encrypted tokens, scopes, status, sync cursor, last error | unique `(user_id, provider)`, unique `(provider, external_user_id)`, tokens only while `active`/`needs_reauth` |
| `oauth_states` | Pending connections: SHA-256 of `state`, encrypted PKCE verifier, expiry | unique `state_hash`; deleted when used |
| `activities` | One activity per `(user, provider, provider_activity_id)`: normalized columns, latest raw payload, provenance, `deleted_at` | unique de-duplication key, non-negative metric checks, indexes on `(user_id, start_time)` and `(user_id, sport, start_time)` |
| `activity_payloads` | Every distinct payload version received (hash, source, time) | unique `(activity_id, payload_hash)` |
| `webhook_deliveries` | Durable webhook inbox: event key, payload, status, attempts, next attempt, error, outcome | unique `event_key`, index `(status, next_attempt_at)` |
| `sync_runs` | Audit of every sync: trigger, kind, window, counts, status, error | index `(user_id, started_at)` |

Decisions:

- **Identity and idempotency.** An activity is identified by the provider's own
  ID (Strava activity ID, Garmin `activityId`). Re-imports hit the unique key
  and become `updated` or `unchanged` (same payload hash). Concurrent imports
  serialize on the key and a row lock (`concurrency.e2e.spec.ts`).
- **No destructive loss.** `activities.raw` holds the latest payload; every
  distinct version is in `activity_payloads`. Measurements a newer payload
  omits keep their previous value (a Strava summary payload lacks the detailed
  representation's `calories`). Provider deletions set `deleted_at`.
- **Measurements are `double precision`.** They are sensor readings, not money.
- **Units.** Stored in SI (meters, seconds, m/s); the read side adds km, km/h
  and pace for convenience.
- **Sports.** A coarse taxonomy (`SPORTS`, `SPORT_GROUPS`) for filtering across
  providers; the provider's exact type is kept in `provider_sport_type`.
- **Cross-provider duplicates are not merged.** A run recorded on a Garmin
  watch and auto-uploaded to Strava appears once per provider. See
  [Technical debt](#technical-debt).
- **Streams, laps and GPS tracks are not stored** in v1, only summaries and
  start coordinates. The raw payloads are kept, so they can be added later.

## Flows

**Connect.** `connect_provider` creates a random `state` (stored hashed,
single-use, 15-minute TTL) and returns Strava's authorization URL. The provider
redirects to `/connect/:provider/callback`, which consumes the state, exchanges
the code, checks the granted scopes, stores the encrypted tokens and starts
the initial sync in the background. The callback answers a small HTML page;
there is no web app in v1.

**Sync.** Strava (pull): page through `/athlete/activities` for
`[cursor − overlap, now)` (first time: the last `SYNC_INITIAL_DAYS`). Every run is a
`sync_runs` row. The cursor moves only on a complete run.

**Garmin (Personal API, no OAuth, no push).** `connect_garmin` creates a
single-use link (stored hashed in `oauth_states`, bound to the authenticated
Fit user's id) and returns `/connect/garmin?link=…`. The page shows which Fit
account it belongs to; submitting the user's own API key consumes the link,
validates the key with Garmin (token exchange + one list call), and stores it
encrypted (`provider_connections.api_key_enc`, AES-256-GCM bound to the row).
`GarminSyncService` then walks `activitylist-service` newest-first with the
offset persisted per page (`history_offset`), and a periodic job polls with
`startDate = cursor − overlap`. Access tokens (24 h) are re-obtained from the
key; there are no refresh tokens. Details and limits: [providers/garmin.md](providers/garmin.md).

**Tokens.** `ConnectionsService.accessToken` refreshes shortly before expiry
with the connection row locked, so concurrent callers never both spend a
rotating refresh token. A refused refresh marks the connection `needs_reauth`.

**Webhooks.** See [webhooks.md](webhooks.md): authenticate, store in the
inbox, answer 200, process asynchronously with retries and dead-lettering.

## Schemas and errors

Zod schemas live next to their service (`activities.schemas.ts`, shapes
exported from services) and are shared by `parseInput` and MCP `inputSchema`.
Errors are `DomainError` subclasses in `common/errors.ts`, rendered by
`DomainErrorFilter` as `{ error: { code, message, details? } }` and by MCP as
the same JSON with `isError: true`.

| Code | HTTP | Meaning |
|---|---|---|
| `validation_failed` | 400 | Input failed its schema |
| `not_found` | 404 | Missing, malformed or another user's resource |
| `conflict` | 409 | E.g. a sync is already running |
| `reauthorization_required` | 409 | The provider grant is gone; connect again |
| `upstream_unavailable` | 502 | Provider error or timeout |
| `upstream_rate_limited` | 503 | Provider rate limit (`details.retryAfterSeconds`) |
| `not_configured` | 503 | Provider credentials not set on this server |

## Technical debt

Known gaps, deliberately left out of v1:

- **No web UI.** Connection is started from MCP/REST and completed on a plain
  callback page. A web app would follow money's BFF pattern (`/auth/*`, cookie
  sessions) and [design/guidelines.md](design/guidelines.md).
- **No OpenAPI spec or generated client** (money uses `@taico/openapi-sdkgen`).
  Add `@ApiRoute` metadata and a `@fit/client` package before building a UI.
- **No cross-provider de-duplication** of the same workout.
- **No streams/laps/routes**; only summaries.
- **Garmin is verified only against a fake** that follows the official
  Personal API client; response field names for activity lists come from that
  client's usage and Garmin Connect's list format, not from a published schema
  ([providers/garmin.md](providers/garmin.md)).
- **The Garmin key link is a capability, not a browser login.** Fit has no web
  login; `connect_garmin` is called with a Taico bearer token and returns a
  short-lived single-use link. Anyone holding an unused link could attach *their
  own* key to that user's account until it expires (they can read nothing).
  A real Taico browser login (OIDC code flow from the page) would remove this.
- **Scheduled re-sync exists only for Garmin** (Strava is webhook-driven).
- **No Kubernetes manifests or image publishing yet** ([deployment.md](deployment.md)).
- **Webhook worker is in-process**; claims use `SKIP LOCKED`, so several
  replicas are safe, but there is no separate worker deployment.
- **Strava rate limits** (default 200 requests/15 min, 2,000/day per app) are
  respected only reactively (429 → retry later). There is no shared budget.
