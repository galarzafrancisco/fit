# MCP interface

Fit's primary interface is an MCP server at `POST $PUBLIC_BASE_URL/mcp`
(Streamable HTTP, stateless, JSON responses). Each request builds a fresh
server bound to the user of its access token, exactly as money does.

## Authentication (federated to Taico)

`/mcp` is an OAuth 2.0 protected resource (RFC 9728), verified by
`@taico/auth`:

1. An unauthenticated request gets `401` with
   `WWW-Authenticate: Bearer resource_metadata="$PUBLIC_BASE_URL/.well-known/oauth-protected-resource/mcp"`.
2. That metadata names the Taico authorization server(s) from
   `TAICO_AUTHORIZATION_SERVERS`.
3. The client registers with Taico (dynamic registration or a client ID
   metadata document), signs the user in with Authorization Code + PKCE and
   gets an access token whose `aud` is `$PUBLIC_BASE_URL/mcp`.
4. Fit verifies signature (Taico JWKS), `iss`, `exp` and `aud`, and maps
   `(iss, sub)` to a Fit user. Tokens for `/api` are refused on `/mcp` and
   vice versa.

### Taico setup (once per deployment)

Like money's `money` entry, create a Taico registry entry (an "MCP server")
for Fit:

- **id** `fit`, **URL** exactly `$PUBLIC_BASE_URL/mcp`, HTTP transport.
- Set `TAICO_ISSUER=https://taico.app` and
  `TAICO_AUTHORIZATION_SERVERS=https://taico.app/mcp/fit/0.0.0` (the entry's
  authorization server).
- For REST clients, a second entry (e.g. `fit-api`) with URL
  `$PUBLIC_BASE_URL/api`.

## Connecting clients

- **Claude** (claude.ai / Claude Desktop): Settings → Connectors → *Add custom
  connector* → URL `$PUBLIC_BASE_URL/mcp`. Claude follows the 401 to Taico and
  opens the sign-in page.
- **ChatGPT**: Settings → Connectors (developer mode) → *Create* → MCP server
  URL `$PUBLIC_BASE_URL/mcp`, authentication **OAuth**.
- **Claude Code**: `claude mcp add --transport http fit $PUBLIC_BASE_URL/mcp`,
  then `/mcp` to authenticate.
- **MCP Inspector**: `npx @modelcontextprotocol/inspector`, transport
  Streamable HTTP, URL `$PUBLIC_BASE_URL/mcp`.

Clients' exact menu names change over time; what matters is a remote MCP
server URL with OAuth. The server must be reachable over https from the client
(for ChatGPT and claude.ai, from the public internet).

## Tools

| Tool | Kind | Purpose |
|---|---|---|
| `whoami` | read | The Fit user behind the token |
| `list_connections` | read | Per provider: available, status, last sync, last error, activity count |
| `connect_provider` | write | Strava: returns a one-time authorization URL for the user to open |
| `connect_garmin` | write | Returns a single-use Fit link (`/connect/garmin?link=…`) where the user pastes their own Garmin Personal API key. The key never travels through MCP |
| `refresh_garmin` | write | Sync Garmin now (new activities + continue history). Idempotent and rate-limit aware: returns the running/most recent run with a note instead of calling Garmin again |
| `disconnect_provider` | destructive | Revoke access; optionally delete imported activities |
| `sync_provider` | write | Catch up now (Strava since the last sync; Garmin: same as `refresh_garmin`) |
| `list_sync_runs` | read | Sync audit trail |
| `list_webhook_events` | read | The user's recent provider events and their processing status |
| `list_activities` | read | Filter by `from`/`to`, `provider`, `sport`/`sportGroup`, `search`, `minDistanceMeters`; cursor pagination |
| `get_activity` | read | Full detail, provenance, provider link; `includeRaw`, `includeHistory` |
| `get_activity_summary` | read | Totals grouped by sport, sport_group, provider, day, week, month, year |

Resource template: `fit://activities/{activityId}` (lists the 50 most recent).

Typical conversation: "How far did I run last month?" →
`get_activity_summary {from: "2026-09-01", to: "2026-09-30", sportGroup: "running", groupBy: "none"}`.
"Connect my Strava" → `connect_provider {provider: "strava"}` → the user opens
the link → activities appear within seconds.

## Conventions

Dates are ISO 8601 UTC; date-only filters are whole UTC days. Distances are
meters (plus `distanceKm`), durations seconds, speeds km/h, pace seconds per
km. Errors are `isError: true` with `{ error: { code, message } }` (codes in
[architecture.md](architecture.md#schemas-and-errors)).
