# Review guide: errors

- New failures reuse an existing `DomainError` subclass when its `code` fits; a new subclass is added only for a new client-visible `code`.
- Every `DomainError` has a stable snake_case `code`, a human-readable message and an `httpStatus`.
- Messages tell the user the next step when there is one.
- `details` carries recovery facts (e.g. `retryAfterSeconds`), not stack traces.
- New codes are listed in `docs/architecture.md#schemas-and-errors`.
- Logs and error payloads contain no tokens, secrets or provider response bodies.
