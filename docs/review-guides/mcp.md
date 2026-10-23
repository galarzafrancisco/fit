# Review guide: MCP tools

- Tools represent user journeys ("how much did I ride this month") rather than tables.
- Each tool calls the same service method as the matching REST route and holds no business rules.
- Input schemas reuse the service's zod shapes.
- Descriptions are short and say what is returned.
- Annotations are correct: `readOnlyHint` for reads, `destructiveHint` for deletes.
- Results go through `toResult`; `DomainError`s become `isError: true` with the REST error JSON.
- The user is bound when the per-request server is built; no tool accepts a user ID.
- New tools are listed in `docs/mcp.md` and in `mcp.e2e.spec.ts`.
