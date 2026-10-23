# Review guide: entities and migrations

- Table and column names are snake_case; the primary key is a `uuid`.
- User-owned tables have `user_id` with `ON DELETE CASCADE` from `users` and an index that starts with `user_id`.
- Values from a fixed list have a `CHECK` constraint matching the entity's `as const` list.
- Provider-sourced rows have a unique key on the provider's identity (de-duplication).
- Secrets are stored only encrypted with `TokenVault` and the row ID as associated data.
- Measurements are `double precision`; nothing is stored in mixed units.
- A migration exists, is registered in `src/database/entities.ts` in order, has a working `down`, and runs on Postgres and PGlite.
- Schema synchronization stays disabled.
- `docs/architecture.md#data-model` is updated for new tables and constraints.
