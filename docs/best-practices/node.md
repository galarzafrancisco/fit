# Best practices for Node projects

- Use TypeScript and `npm` workspaces; no `bun`, `deno`, `yarn` or `pnpm`.
- Target Node >= 20 (CI and the image use 24).
- Extend `tsconfig.base.json`; Node projects use `nodenext` module resolution.
- Register the project with Nx so `npm run build`, `test` and `typecheck` include it.
- Provide `build`, `test` and `typecheck` scripts (and `dev`/`start` for apps).
- Configuration comes from environment variables with safe development defaults; production refuses to start without required values.
- Pure logic that does not need Nest or a database goes in a package under `packages/` with its own unit tests.
