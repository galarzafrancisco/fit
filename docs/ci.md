# CI

`.github/workflows/ci.yml` runs on pull requests to `main` and `feature/**`,
and on pushes to `main`. All three jobs must pass.

| Job | Checks |
|---|---|
| **Lint, build and test** | `npm ci`; `format:check` (Prettier); `lint` (ESLint, including "no `process.env` outside config"); `build` (Nx); `verify:auth` (every `@taico/auth` subpath loads); `typecheck`; `@fit/activity-model` unit tests; backend suite **twice in parallel**: on a Postgres 16 service (each test file creates its own database) and on PGlite |
| **Security checks** | `npm audit --omit=dev --audit-level=high` (blocking: what ships in the image); full `npm audit` (warning only: dev tooling advisories); gitleaks over the full git history (blocking) |
| **Build and smoke-test container image** | Builds the Dockerfile, runs it like a hardened deployment (uid 1000, read-only root, no capabilities) against Postgres: migrations run, `/health` OK, unauthenticated `/api` and `/mcp` answer 401, a restart keeps data and re-runs no migrations; the image refuses to start without `TOKEN_ENCRYPTION_KEY` or a database |

Runners are `ubuntu-24.04-arm` (free for public repositories). The container
image is built for `linux/arm64`, the DGX Spark target, and the smoke test runs
that arm64 image natively; CI asserts the image architecture is `arm64`. Nothing is published or deployed
yet; see [deployment.md](deployment.md).

Run the same checks locally:

```bash
npm ci && npm run format:check && npm run lint && npm run build && npm run verify:auth && npm run typecheck && npm test
docker run -d --name fit-pg -e POSTGRES_PASSWORD=fit -e POSTGRES_USER=fit -p 55432:5432 postgres:16-alpine
TEST_POSTGRES_URL=postgresql://fit:fit@127.0.0.1:55432/postgres npm -w @fit/backend test
```
