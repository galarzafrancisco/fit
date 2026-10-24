# Fit docs

Agent and contributor rules live in [AGENTS.md](../AGENTS.md) (`CLAUDE.md` imports it).

| Path | What it is |
|---|---|
| [architecture.md](architecture.md) | Components, layering rules, data model, flows, errors, technical debt |
| [configuration.md](configuration.md) | Every environment variable, defaults and production requirements |
| [mcp.md](mcp.md) | MCP tools, Taico auth and how to connect Claude, ChatGPT and other clients |
| [api.md](api.md) | REST endpoints (same services as MCP) |
| [webhooks.md](webhooks.md) | Webhook endpoints, durable inbox, retries, dead letters, observability |
| [providers/strava.md](providers/strava.md) | Strava setup (app, callback domain, push subscription) and limits |
| [providers/garmin.md](providers/garmin.md) | Garmin Connect Personal API: per-user key, capabilities, limits, rotation |
| [ci.md](ci.md) | CI jobs and what each checks |
| [deployment.md](deployment.md) | Image, runtime requirements, secrets, URLs to register, what is not automated yet |
| [design/guidelines.md](design/guidelines.md) | Output conventions for MCP/REST and design rules for a future UI |
| [review-guides/](review-guides/) | Objective checklists: controller, service, schema, entity, error, mcp, provider |
| [best-practices/node.md](best-practices/node.md) | Project setup conventions |

These follow money's documentation structure; money's review guides were
adapted where Fit's domain differs (measurements are floats, not decimal
strings; providers instead of a ledger).
