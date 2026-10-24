# Review guide: providers and webhooks

- Provider-specific code is confined to `apps/backend/src/providers/<name>/` (HTTP) and `packages/activity-model/src/<name>.ts` (mapping).
- Only official, documented provider APIs are called, with the user's own OAuth grant.
- All provider HTTP goes through `providerRequest` (timeout, 429/5xx mapping) and the injected `fetch`.
- The mapper turns unknown or wrongly typed fields into `null` and throws `ActivityMappingError` only for a missing ID or start time.
- Webhook endpoints authenticate before storing anything and answer 404 for unknown secrets.
- Webhook events are stored in `webhook_deliveries` with a unique `event_key` before the 200 response.
- Event bodies that only reference data are not trusted as data: the activity is re-fetched with the user's token.
- URLs taken from provider payloads are restricted to the provider's API host before a token is sent.
- Token fields in provider payloads are stripped before storage.
- The fake provider in `test-support/fake-providers.ts` implements every new call, and an e2e test covers it.
- The provider's page in `docs/providers/` lists setup steps, limits and anything not verified against the live API.
