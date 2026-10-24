# Review guide: services

- No imports of Express types, `@Req()`/`@Res()` or MCP SDK types.
- Every public method takes `CurrentUser` (or the owning user ID) explicitly and never reads a user ID from input.
- Input is parsed with `parseInput(schema, input)`.
- Throws only `DomainError` subclasses from `src/common/errors.ts`.
- Another user's resource and a malformed ID produce `NotFoundError`.
- Activities are written only through `ActivityIngestService.ingest` / `markDeleted`.
- Provider calls go through a `ProviderAdapter`; no provider URL or payload field appears outside `src/providers/` and `@fit/activity-model`.
- Provider access tokens are obtained with `ConnectionsService.accessToken`, never decrypted elsewhere.
- A transaction that must persist a state change does not throw after making it (the change would roll back); it returns a result and the caller throws.
- Work that can take more than a few seconds or call a provider repeatedly is recorded (sync run or webhook delivery) with its outcome.
