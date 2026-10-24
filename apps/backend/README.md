# @fit/backend

NestJS backend serving Fit's MCP server (`/mcp`), REST API (`/api`), provider
OAuth callbacks (`/connect/:provider/callback`) and webhooks (`/webhooks/*`).

```
src/
  activities/   entities, ingest (single write path), queries and summaries
  connections/  provider connections, OAuth state/PKCE, token vault and refresh, callback page
  providers/    ProviderAdapter port, Strava and Garmin adapters, HTTP helper
  sync/         sync runs (Strava pull, Garmin Personal API polling)
  webhooks/     inbox (authenticate + store), worker (claim, retry, dead-letter), handlers
  mcp/          per-request MCP server and controller
  api/          REST controller
  auth/ users/  @taico/auth resource server and user mapping (as in money)
  database/     data source, migrations, unit of work
  config/       environment (the only reader of process.env)
  test-support/ test app, fake Strava/Garmin servers
```

```bash
npm -w @fit/backend run dev          # watch mode on :4190
npm -w @fit/backend test             # e2e + unit (PGlite; TEST_POSTGRES_URL for Postgres)
npm -w @fit/backend run migration:run
```

See [../../docs/README.md](../../docs/README.md).
