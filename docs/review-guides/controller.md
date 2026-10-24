# Review guide: controllers (REST, callback, webhooks)

- Contains no business logic: no repository access, no provider calls, no branching on domain state.
- Every `/api` route is protected with `@Protected()`; an unauthenticated route (health, callback, webhooks) is intentional and listed in `docs/api.md`.
- The user comes from `@AuthenticatedUser()` only; no user ID is read from params, query, body or headers.
- Input is passed to the service, which parses it with zod; the controller does at most trivial reshaping (`'true'` → `true`).
- Errors are `DomainError`s thrown by services; the controller does not throw `HttpException`s.
- Every `/api` route has a matching MCP tool, or the PR states why not.
- Webhook controllers return within the provider's deadline and do no provider calls.
