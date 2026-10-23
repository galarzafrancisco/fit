# REST API

`/api` is a second door into the same services as the MCP tools, for scripts
and a future web app. Every route needs a Taico access token whose audience is
`$PUBLIC_BASE_URL/api` (a separate Taico registry entry, see [mcp.md](mcp.md)).
Errors use `{ error: { code, message, details? } }`.

| Method and path | MCP equivalent |
|---|---|
| `GET /api/me` | `whoami` |
| `GET /api/connections`, `GET /api/connections/:provider` | `list_connections` |
| `POST /api/connections/:provider/authorize` | `connect_provider` |
| `DELETE /api/connections/:provider?deleteActivities=true` | `disconnect_provider` |
| `POST /api/connections/:provider/sync` body `{ "since"?: "YYYY-MM-DD" }` | `sync_provider` |
| `GET /api/sync-runs?provider&limit` | `list_sync_runs` |
| `GET /api/webhook-events?provider&limit` | `list_webhook_events` |
| `GET /api/activities?from&to&provider&sport&sportGroup&search&minDistanceMeters&includeDeleted&limit&cursor` | `list_activities` |
| `GET /api/activities/summary?from&to&provider&sport&sportGroup&groupBy` | `get_activity_summary` |
| `GET /api/activities/:id?includeRaw&includeHistory` | `get_activity` |

Unauthenticated endpoints, all intentional: `GET /health`,
`/.well-known/oauth-protected-resource/{mcp,api}`, `GET /connect/:provider/callback`
(authenticated by the single-use OAuth state), and `/webhooks/*` (authenticated
per provider, see [webhooks.md](webhooks.md)).

There is no OpenAPI spec yet (technical debt; money generates one with
`@ApiRoute` and `@taico/openapi-sdkgen`).
