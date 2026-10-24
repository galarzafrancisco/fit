# Garmin

Status: **implemented against Garmin's official Personal API materials, tested
against a fake that follows them, not yet exercised against Garmin's live
service.** Fit uses only the official API: no scraping, no Garmin passwords, no
undocumented endpoints.

Code: `apps/backend/src/providers/garmin/garmin.adapter.ts`,
`apps/backend/src/sync/garmin-sync.service.ts`, `packages/activity-model/src/garmin.ts`.

Sources (the only ones used):

- [Personal API](https://developer.garmin.com/gc-developer-program/personal/personal-api/)
- [Personal API FAQ](https://developer.garmin.com/gc-developer-program/personal/personal-faq/)
- [Swagger docs](https://developer.garmin.com/gc-developer-program/personal/swagger-docs/) (rendered client-side; not machine-readable here)
- [garmin/connect-personal-api-python](https://github.com/garmin/connect-personal-api-python) (Garmin's own client; the source of endpoint paths and parameters)

## The personal-use restriction

The Personal API is for **an individual user accessing their own Garmin
Connect data**. Garmin says it is "not intended for commercial applications
serving multiple end users"; multi-user integrations belong to the Garmin
Connect Developer Program (a different, approval-based program that Fit no
longer uses). Consequently:

- Every Fit user supplies **their own** key. Keys are never shared: Fit refuses
  to attach one key to two Fit users.
- Fit never shows, returns or transmits a key to MCP clients, browsers (after
  submission) or logs. Only the server holds it, encrypted.
- Use Fit's Garmin support only for your own data. If you want to serve other
  people, apply to the Developer Program instead.

## What the Personal API provides (and what Fit does with it)

| Capability | Official documentation says | Fit |
|---|---|---|
| Authentication | Key created in Garmin Connect web (expiry 30/90/180/365 days, shown once). `POST /personalapitoken-service/personal-api/personal-api-key/token` with `Authorization: ApiKey <key>` returns a bearer JWT; data calls use `Authorization: Bearer` | Implemented. **No OAuth flow** |
| Token lifetime | 24 hours or until the key expires; **no refresh tokens** (call the token endpoint again). Deleting the key disables its tokens | New token obtained from the stored key when missing/expired/rejected |
| Activity list | `GET /activitylist-service/activities/search/activities?start&limit&startDate&endDate&activityType` (client source). Offset paging | Implemented: offset paging, newest first, `startDate` for incremental polls |
| Activity detail / file download | `/activity-service/activity/{id}`, `/download-service/files/activity/{id}` (zip) | Not used. List summaries only (no laps, streams or FIT files) |
| History depth | Not documented | Walked until a short page or `GARMIN_HISTORY_MAX_ACTIVITIES` |
| Rate limits | **Not documented** in any linked page | Conservative self-imposed limits (below) |
| Webhooks / push | **Not documented**; nothing like Developer Program Push/Ping | **None. Scheduled polling is the supported mechanism** |
| Key revocation | Delete the key in Garmin Connect | Detected as a rejected key → `needs_reauth` |
| Multi-user use | Not allowed (above) | Per-user keys only |

Response field names in activity lists (`activityId`, `startTimeGMT`,
`activityType.typeKey`, `distance`, ...) follow the Garmin Connect activity
summary format used by Garmin's client; they are read defensively (a missing or
mistyped field becomes `null`; an item without `activityId` or `startTimeGMT`
is skipped and counted). The latest raw item is stored losslessly, so fields
Fit does not model yet remain available.

### Fields unavailable from the Personal API list

Fit stores summaries only. Not provided or not mapped: timezone name (only the
UTC offset is derived from `startTimeLocal − startTimeGMT`), laps, splits,
GPS tracks and sensor streams, private flag semantics. Stored as `null`.

## Connecting (per user)

1. In **Garmin Connect on the web** (Account → Personal API Key) create a key.
   Pick an expiry; copy it (shown once).
2. Ask your AI assistant to connect Garmin. It calls the `connect_garmin` MCP
   tool, which returns a link like
   `https://fit.american-broomstick.com/connect/garmin?link=…`.
   **Never paste the key into the chat.**
3. Open the link. The page shows which Fit account it is for. Paste the key and
   submit. Fit validates it with Garmin, stores it encrypted, and starts
   importing.

How identity is bound: `connect_garmin` is called with the user's Taico access
token, so the server knows the Fit user (`iss`, `sub`) when it creates the
link. The link carries only a random single-use token (stored as a SHA-256),
valid `OAUTH_STATE_TTL_SECONDS` (15 min), consumed on submission. No user ID in
the URL is ever trusted. The page sends `no-store`, `no-referrer`, a strict CSP,
and the key is posted over HTTPS (`PUBLIC_BASE_URL` must be https in production).
Known limitation: the link is a capability — see [architecture.md](../architecture.md#technical-debt).

## Sync behavior

- **History** (recent → older): offset-paged walk of the list; the offset is
  persisted after each page, so rate limits, restarts or errors resume exactly
  there. Per run at most `GARMIN_MAX_PAGES_PER_RUN` pages; remaining history is
  continued by the scheduler every `GARMIN_TICK_INTERVAL_MS`. Ends on a short
  page or at `GARMIN_HISTORY_MAX_ACTIVITIES`. If activities arrive during the
  walk, offsets shift and a few are re-read as "unchanged"; nothing is missed.
- **Polling**: each connection is polled every `GARMIN_POLL_INTERVAL_MINUTES`
  (default 30) with `startDate = cursor − SYNC_OVERLAP_HOURS` (default 48 h) to
  catch late device syncs and edits. At most `GARMIN_SYNC_CONCURRENCY` (2)
  users run at once; there is a `GARMIN_MIN_REQUEST_INTERVAL_MS` (1 s) pause
  between requests.
- **Idempotency**: all imports go through the single write path, unique on
  `(user, provider, activityId)`; identical payloads are `unchanged`, changed
  ones add a payload version.
- **Retries and backoff**: network errors, 5xx and 429 retry up to
  `GARMIN_MAX_RETRIES` times with exponential delay (`GARMIN_RETRY_BASE_MS`,
  doubling; `Retry-After` honored; capped at `GARMIN_MAX_BACKOFF_MINUTES`). If a
  run still fails, the connection backs off exponentially
  (`failure_count`, `backoff_until`) and recovers on the next successful run.
- **`refresh_garmin`** (also `sync_provider garmin`): sync now. Idempotent and
  rate-limit aware: while a run is active, within
  `GARMIN_MANUAL_MIN_INTERVAL_SECONDS` of the last run, or during a backoff, it
  returns that status with a note and does not call Garmin.
- **Observability**: `list_connections` shows `history` progress, `nextSyncAt`,
  `backoffUntil`, `lastError`; `list_sync_runs` shows each run's pages, counts
  and error (`trigger`: `connect`, `scheduled`, `manual`). Server logs carry run
  summaries only: never keys, tokens, URLs with credentials, or Garmin bodies.

## Key rotation, expiry and revocation

- Garmin emails about a week before a key expires. Create a new key and run
  `connect_garmin` again: the link replaces the stored key on the same
  connection, keeping imported activities and sync progress.
- If Garmin rejects the key (deleted or expired), the connection becomes
  `needs_reauth`, the stored key and tokens are deleted, and syncs stop with a
  message telling the user to run `connect_garmin`. Already-imported activities
  stay.
- To revoke: delete the key in Garmin Connect (disables all tokens), and/or
  `disconnect_provider garmin` (Fit deletes its copy; `deleteActivities: true`
  also removes imported activities and resets history progress).
- Rotating `TOKEN_ENCRYPTION_KEY` makes stored keys unreadable: those
  connections become `needs_reauth`.

## Operator notes

- No cluster/deployment secret exists for Garmin; do not create one.
- Migration `1761300000000-GarminPersonalApi` marks any old Developer Program
  Garmin connections `needs_reauth`.
- The old Developer Program webhook endpoint (`/webhooks/garmin/…`) and
  `GARMIN_CLIENT_ID/SECRET/WEBHOOK_SECRET` variables were removed.
