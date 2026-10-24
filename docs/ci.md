# CI

`.github/workflows/ci.yml` runs on pull requests to `main` and `feature/**`,
and on pushes to `main` (and on `merge_group`, see below). All jobs must pass;
the single required check is **CI gate**, which fails unless all of them succeeded.

| Job | Checks |
|---|---|
| **Merge result is current** (PRs only) | The commit under test is the PR merged into the *current* tip of the base branch; fails if the base moved since GitHub built the merge ref |
| **Lint, build and test** | `npm ci`; `format:check` (Prettier); `lint` (ESLint, including "no `process.env` outside config"); `build` (Nx); `verify:auth` (every `@taico/auth` subpath loads); `verify:ci-policy` (this workflow still has the merge-result guards); `typecheck`; `@fit/activity-model` unit tests; backend suite **twice in parallel**: on a Postgres 16 service (each test file creates its own database) and on PGlite |
| **Security checks** | `npm audit --omit=dev --audit-level=high` (blocking: what ships in the image); full `npm audit` (warning only: dev tooling advisories); gitleaks over the full git history (blocking) |
| **Build and smoke-test container image** | Builds the Dockerfile, runs it like a hardened deployment (uid 1000, read-only root, no capabilities) against Postgres: migrations run, `/health` OK, unauthenticated `/api` and `/mcp` answer 401, a restart keeps data and re-runs no migrations; the image refuses to start without `TOKEN_ENCRYPTION_KEY` or a database |

Runners are `ubuntu-24.04-arm` (free for public repositories). The container
image is built for `linux/arm64`, the DGX Spark target, and the smoke test runs
that arm64 image natively; CI asserts the image architecture is `arm64`. Nothing is published or deployed
yet; see [deployment.md](deployment.md).

Run the same checks locally:

```bash
npm ci && npm run format:check && npm run lint && npm run build && npm run verify:auth && npm run typecheck && npm test
docker run -d --name fit-pg -e POSTGRES_PASSWORD=fit -e POSTGRES_USER=fit -p 55432:5432 postgres:16-alpine
TEST_POSTGRES_URL=postgresql://fit:fit@127.0.0.1:55432/postgres npm -w @fit/backend test
```

## Merge policy: why a green PR can still break `main`

`pull_request` workflows check out `refs/pull/N/merge` (the PR merged into the
base *at the time GitHub last built it*), not the bare feature head. That is
good, but the ref is only rebuilt when the PR or base changes, and nothing
forces a PR to be re-tested after *another* PR lands. Two PRs that each pass
alone can then fail together on `main`. Guards, in layers:

1. **Branch protection on `main`** (applied; see below): required check
   `CI gate`, **strict** ("require branches to be up to date before merging"),
   no force-push or deletion, conversations resolved, admins included. Strict
   mode blocks the merge button until the branch contains the latest `main`, so
   the merge result CI validated is the real one.
2. **`Merge result is current`** fails a run whose tested merge commit does not
   contain the current base tip, so a stale or re-run green cannot stand.
3. **`CI gate`** is the one required name; adding or renaming jobs cannot drop a
   requirement, and `verify:ci-policy` fails if a job is not in the gate.
4. **Post-merge:** CI runs on every push to `main`; a red `main` is fixed or
   reverted first.
5. **Merge queue:** the workflow already handles `merge_group`, but GitHub merge
   queue is only offered on organisation-owned repositories. `fit` is
   user-owned, so it is **not enabled**; strict required checks are the
   equivalent (they serialise merges by making each PR re-test after `main`
   moves). Limitation: with strict mode a maintainer must update the branch and
   wait for CI after each other merge; there is no automatic batching.

### Branch protection (as configured)

```bash
gh api -X PUT repos/galarzafrancisco/fit/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "checks": [{ "context": "CI gate" }] },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "required_conversation_resolution": true,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

Manual UI path: Settings → Branches → Add rule for `main` → *Require status
checks to pass* (add `CI gate`) → *Require branches to be up to date* → *Do not
allow bypassing*. Also enable *Automatically delete head branches* and, if you
use auto-merge, *Allow auto-merge*. Required reviews are left off because this
is a single-maintainer repository; add them if more people merge.

### Maintainer checklist before merging

- [ ] `CI gate` is green **on the latest commit** and the branch shows "up to date with main".
- [ ] If `main` moved: update the branch (rebase or merge) and wait for CI again.
- [ ] No `Merge result is current` failure; if it fails, update the branch, do not re-run.
- [ ] After merging, watch the `push` run on `main`; if red, fix forward or revert immediately.
- [ ] Changing `ci.yml`? Keep `CI gate` as the only required check and run `npm run verify:ci-policy`.
