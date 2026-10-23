# @fit/activity-model

Provider-neutral activity model shared by Fit's backend and future clients.

- `PROVIDERS`, `SPORTS`, `SPORT_GROUPS`: the taxonomy every filter and summary uses.
- `mapStravaActivity(raw)`, `mapGarminActivity(raw)`: turn a provider payload into a
  `NormalizedActivity`. Unknown or wrong-typed fields become `null`; only a missing
  ID or start time throws `ActivityMappingError`.
- `contentHash(payload)`: SHA-256 of key-sorted JSON, used to store each distinct
  provider payload version once.

Pure TypeScript: no framework, database or network code. Adding a provider means
adding a mapper here and an adapter in `apps/backend/src/providers/`.

```bash
npx nx run @fit/activity-model:test
```
