# Configuration

All configuration is environment variables, read and validated once in
`apps/backend/src/config/env.config.ts` (nothing else reads `process.env`; ESLint
enforces it). Invalid values stop startup with a message naming the variable.
The app does not load `.env` files; see [.env.example](../.env.example).

## Core

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `production` enables the strict checks below |
| `PORT` | `4190` | |
| `PUBLIC_BASE_URL` | `http://localhost:$PORT` | Public origin. Token audiences (`/mcp`, `/api`), OAuth redirect URIs and webhook URLs are built from it |
| `TAICO_ISSUER` | `http://localhost:3000` | **Required in production.** The `iss` of Taico access tokens |
| `TAICO_JWKS_URL` | `$TAICO_ISSUER/.well-known/jwks.json` | |
| `TAICO_AUTHORIZATION_SERVERS` | `$TAICO_ISSUER` | Comma-separated; advertised in protected-resource metadata. In production use the `fit` registry entry's server, e.g. `https://taico.app/mcp/fit/0.0.0` ([mcp.md](mcp.md)) |
| `TOKEN_ENCRYPTION_KEY` | random per process (dev) | **Required in production.** 32 bytes base64 (`openssl rand -base64 32`). Encrypts provider tokens and PKCE verifiers. Changing it forces every user to reconnect |

## Database

Same rules as money.

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | unset | Postgres connection string. **Required in production** |
| `DATABASE_MODE` | derived | `postgres`, `pglite` (dev only) or `memory` (non-durable) |
| `DATABASE_SSL` | `false` | `true` verifies the server certificate |
| `DATABASE_POOL_MAX` | `10` | |
| `PGLITE_DATA_DIR` | `.data/pglite` | Relative to `apps/backend` when run with `npm run dev` |

## Strava ([providers/strava.md](providers/strava.md))

| Variable | Default | Notes |
|---|---|---|
| `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` | unset | Both or neither. Unset: Strava is reported unavailable |
| `STRAVA_WEBHOOK_SECRET` | unset | 24-128 URL-safe chars. Last path segment of the webhook URL and the subscription `verify_token`. Unset: the webhook endpoint answers 404 |
| `STRAVA_WEBHOOK_SUBSCRIPTION_ID` | unset | Strongly recommended: events for other subscriptions are rejected |
| `STRAVA_OAUTH_BASE_URL` | `https://www.strava.com/oauth` | Override for tests only |
| `STRAVA_API_BASE_URL` | `https://www.strava.com/api/v3` | Override for tests only |

## Garmin ([providers/garmin.md](providers/garmin.md))

| Variable | Default | Notes |
|---|---|---|
| `GARMIN_CLIENT_ID` / `GARMIN_CLIENT_SECRET` | unset | From an approved Connect Developer Program app. Both or neither |
| `GARMIN_WEBHOOK_SECRET` | unset | Last path segment of the Push/Ping URL registered with Garmin |
| `GARMIN_AUTHORIZE_URL` | `https://connect.garmin.com/oauth2Confirm` | From Garmin's OAuth2 PKCE spec; configurable in case Garmin moves it |
| `GARMIN_TOKEN_URL` | `https://diauth.garmin.com/di-oauth2-service/oauth/token` | Same |
| `GARMIN_API_BASE_URL` | `https://apis.garmin.com` | Ping callback URLs must be on this host |
| `GARMIN_BACKFILL_ON_CONNECT` | `true` | Request history when a user connects. Set `false` on a tier without historical data (Starter) |

## Sync, OAuth and webhooks

| Variable | Default | Notes |
|---|---|---|
| `SYNC_INITIAL_DAYS` | `90` | History window of the first sync |
| `SYNC_OVERLAP_HOURS` | `48` | Incremental syncs re-read this much before the cursor |
| `SYNC_MAX_PAGES` / `SYNC_PAGE_SIZE` | `50` / `100` | Per sync run (Strava caps pages at 200) |
| `PROVIDER_REQUEST_TIMEOUT_MS` | `15000` | |
| `OAUTH_STATE_TTL_SECONDS` | `900` | How long a connect link works |
| `WEBHOOK_WORKER_ENABLED` | `true` (`false` in tests) | |
| `WEBHOOK_POLL_INTERVAL_MS` | `5000` | The worker is also woken on each new delivery |
| `WEBHOOK_MAX_ATTEMPTS` | `8` | Then the delivery is `failed` (dead letter) |
| `WEBHOOK_RETRY_BASE_MS` | `30000` | Doubles per attempt, capped at 6 h; a provider `Retry-After` wins if longer |
| `WEBHOOK_STALE_AFTER_MS` | `300000` | A `processing` claim older than this is retried |
