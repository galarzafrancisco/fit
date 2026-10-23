## What and why

## How it was verified

- [ ] `npm run build:dev`
- [ ] `npm run lint && npm run format:check`
- [ ] `npm test` (PGlite) and, for database changes, with `TEST_POSTGRES_URL`
- [ ] `npm run dev`: `/health` OK, unauthenticated `/mcp` and `/api` answer 401

## Checklist

- [ ] Reviewed against the matching [review guides](../docs/review-guides/)
- [ ] Docs updated (tools in `docs/mcp.md`, env vars in `docs/configuration.md`, tables in `docs/architecture.md`)
- [ ] No secrets, tokens or real user data committed
- [ ] Technical debt introduced is listed below

## Technical debt
