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

## Deployment on the Spark (spark-ops, same pattern as money)

Flow on every push to `main`: CI (tests, security, image smoke test, manifest
render) → `publish` pushes `ghcr.io/galarzafrancisco/fit:main-<sha7>` (arm64) →
`deploy` copies `install/manifests` to `spark-ops/k8s/fit`, pins the image and
opens an auto-merged spark-ops PR → Argo CD syncs `k8s/fit/overlays/main` into
namespace `fit`. Host: `https://fit.american-broomstick.com` (Gateway
`public` ListenerSet + cert-manager certificate, HTTP→HTTPS redirect).

Differences from money: port 4190; Postgres host port 15435; no browser
sessions (so no session key); secret `fit-secrets` holds `TOKEN_ENCRYPTION_KEY`;
optional secret `fit-providers` holds Strava/Garmin variables; no Up/market config.

### One-time prerequisites (manual, privileged)

1. On the Spark host, from the spark-ops checkout (see spark-ops `docs/fit-postgres.md`):
   `./bootstrap/fit-secrets.sh && ./bootstrap/fit-postgres.sh`. This creates the
   host-backed database (`/home/fran/prod/storage/fit/postgres`) and the Secrets
   `fit/fit-database` (`DATABASE_URL`) and `fit/fit-secrets` (`TOKEN_ENCRYPTION_KEY`).
   `bootstrap.sh` runs both on cluster recreation. Back up the `fit-secrets.env`
   and `fit-postgres.env` files off-host.
2. GitHub repo secret `SPARK_OPS_TOKEN` on `galarzafrancisco/fit` (same PAT as money).
3. DNS for `fit.american-broomstick.com` (same target as money).
4. Taico registry entry `fit` → `https://fit.american-broomstick.com/mcp`.
5. Optional, when provider apps exist: create the Secret `fit-providers` in
   namespace `fit` from the variables in [configuration.md](configuration.md)
   (`kubectl -n fit create secret generic fit-providers --from-literal=...`; avoid
   shell history), then `kubectl -n fit rollout restart deploy/fit`. Register the
   webhook URLs from the table above.

Merging to `main` before step 1 deploys a pod that cannot start (the previous
state is unaffected on first deploy; the rolling update keeps an old pod, if any).

### Verify

```bash
kubectl -n fit rollout status deploy/fit
kubectl -n fit logs deploy/fit | tail
curl -fsS https://fit.american-broomstick.com/health
curl -fsS https://fit.american-broomstick.com/.well-known/oauth-protected-resource/mcp
```

### Rollback

Revert the spark-ops commit (or its `Deploy fit (main-<sha>)` PR) so Argo CD
re-syncs the previous image tag; or `kubectl -n fit rollout undo deploy/fit`
(Argo CD may revert it; revert in Git for durability). Migrations are forward-only:
roll back only to an image compatible with the current schema. Never rotate
`TOKEN_ENCRYPTION_KEY` as part of a rollback.

## Not validated yet (risks)

- Nothing has been deployed: validated so far by rendering manifests with
  kustomize and running the security/database checks in CI.
- Pod memory request/limit are copied from money; measure after first deploy.
- Strava/Garmin end-to-end needs the manual provider setup above.
