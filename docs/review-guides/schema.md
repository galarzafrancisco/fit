# Review guide: zod schemas

- Schemas live next to their service (`<domain>.schemas.ts` or exported shapes) and are used by both `parseInput` and the MCP `inputSchema`.
- Enumerations come from `as const` arrays (`PROVIDERS`, `SPORTS`, `SPORT_GROUP_NAMES`) used with `z.enum`.
- Every field an MCP client sees has a short `.describe()` that states its unit or format.
- Dates use `dateOrInstant`; IDs are checked with `isUuid` before querying.
- Limits have explicit bounds (`limit` 1-100).
- No field allows choosing the user.
- Responses are plain objects built by a mapper; entities, tokens and encrypted columns are never returned.
