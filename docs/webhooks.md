# Webhooks

Providers notify Fit of new, changed and deleted activities and of revoked
access. Endpoints:

| Provider | Method and path |
|---|---|
| Strava | `GET /webhooks/strava/:secret` (subscription validation), `POST /webhooks/strava/:secret` (events) |

Garmin has no webhooks: the Personal API documents no push mechanism, so Garmin is polled ([providers/garmin.md](providers/garmin.md)).

They are **not** behind Taico auth (providers have no Taico token).

## Pipeline

```
provider ─POST─► WebhooksController ─► WebhookInboxService
                                         1. constant-time check of the :secret segment (404 if wrong or unset)
                                         2. schema check (400 if not an event)
                                         3. Strava: subscription_id must equal STRAVA_WEBHOOK_SUBSCRIPTION_ID (404)
                                         4. INSERT webhook_deliveries ... ON CONFLICT (event_key) DO NOTHING
                                         5. answer 200 {received, duplicates}  (Strava requires < 2 s)
                                                     │ wakes
                                                     ▼
                                     WebhookWorker (in process, every WEBHOOK_POLL_INTERVAL_MS and on each delivery)
                                         claim: UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)
                                         WebhookHandlers: route by (provider, external user) → connection → user
                                         processed | ignored | retry with backoff | failed (dead letter)
```

- **Idempotency.** `event_key` is unique: Strava
  `subscription:object_type:object_id:aspect_type:event_time`. Redeliveries are stored once and counted as
  duplicates. Processing is idempotent too (ingest by provider ID and payload hash).
- **Durability.** Events are stored before the 200, so a crash after
  acknowledging loses nothing; `processing` claims older than
  `WEBHOOK_STALE_AFTER_MS` are retried.
- **Retries.** Provider errors, timeouts and rate limits are retried with
  exponential backoff (`WEBHOOK_RETRY_BASE_MS × 2^(attempt−1)`, capped at 6 h,
  at least the provider's `Retry-After`). After `WEBHOOK_MAX_ATTEMPTS` the
  delivery is `failed` and kept. Unreadable payloads, forged ping URLs and
  revoked grants fail immediately.
- **Routing and trust.** A delivery reaches a user only via
  `provider_connections (provider, external_user_id)` with status `active`;
  otherwise it is `ignored` with the reason. Strava events are never trusted
  as data: the activity is re-fetched. See the provider pages for the
  per-provider trust model.

## Observability

- `GET /health` reports `webhooks.pending`, `processing` and `failed` counts
  (no user data). Alert on `failed > 0` or a growing `pending`.
- Users (and their AI client) see their own events with
  `list_webhook_events` / `GET /api/webhook-events`: type, status, outcome,
  attempts, last error, next attempt.
- Operators can inspect dead letters directly:
  `SELECT provider, event_type, attempts, last_error, received_at FROM webhook_deliveries WHERE status = 'failed' ORDER BY received_at DESC;`
  To retry one: `UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = now() WHERE id = '…';`
- Logs never include payload bodies or tokens.
