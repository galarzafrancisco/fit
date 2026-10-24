# Deployment

Fit ships as one container image (`Dockerfile`): Node 24 Alpine, production
dependencies only, runs `node dist/main.js` as uid/gid 1000 with a read-only
root filesystem (only `/tmp` needs to be writable). Port `4190`.

## Runtime requirements

| Need | Notes |
|---|---|
| PostgreSQL 16+ | `DATABASE_URL`. Migrations run on startup. Back it up: it is the only copy of webhook-delivered data that the provider may not resend |
| `TOKEN_ENCRYPTION_KEY` | Secret. Losing or changing it forces every user to reconnect |
| `TAICO_ISSUER`, `TAICO_AUTHORIZATION_SERVERS` | Taico registry entries `fit` (`/mcp`) and optionally `fit-api` (`/api`), see [mcp.md](mcp.md) |
| `PUBLIC_BASE_URL` | https origin reachable by AI clients and providers |
| Provider credentials | Secrets: `STRAVA_CLIENT_SECRET`, `STRAVA_WEBHOOK_SECRET`, `GARMIN_CLIENT_SECRET`, `GARMIN_WEBHOOK_SECRET` |

Store secrets in the platform's secret store (e.g. a Kubernetes Secret
managed in spark-ops, as money does); never in the repo or the image.

## URLs to register with providers

| Where | Value |
|---|---|
| Strava app, Authorization Callback Domain | host of `PUBLIC_BASE_URL` |
| Strava push subscription callback | `$PUBLIC_BASE_URL/webhooks/strava/$STRAVA_WEBHOOK_SECRET` |
| Garmin app, OAuth redirect URI | `$PUBLIC_BASE_URL/connect/garmin/callback` |
| Garmin Push/Ping endpoint | `$PUBLIC_BASE_URL/webhooks/garmin/$GARMIN_WEBHOOK_SECRET` |
| Taico registry entry `fit` | `$PUBLIC_BASE_URL/mcp` |

## Operations

- Health: `GET /health` (database + webhook backlog). Use it for liveness and readiness.
- Scaling: several replicas are safe (webhook claims use `SKIP LOCKED`, token
  refresh locks the connection row). Each replica runs a webhook worker.
- Graceful shutdown: the worker stops claiming and finishes its batch.
- Rotating a webhook secret: set the new secret, redeploy, then update the
  provider (Strava: delete and recreate the push subscription).

## Not automated yet (technical debt)

money's CI also pushes the image to GHCR and opens a spark-ops PR with
Kustomize manifests (`install/manifests`). Fit does not yet: before the first
deployment, add manifests (Deployment with the hardening above, Service,
Route/Certificate, ConfigMap, Secret references, Postgres), a publish job and
the spark-ops deploy job, following money's `docs/deployment.md`.
