# Strava

Status: **implemented end to end** (OAuth, initial and incremental sync, token
refresh, webhooks), and tested against an in-memory fake of the documented
API. Using it live needs only a Strava API application.

Code: `apps/backend/src/providers/strava/strava.adapter.ts`,
`packages/activity-model/src/strava.ts`.

## What Fit uses

| Purpose | Endpoint |
|---|---|
| Authorize | `GET https://www.strava.com/oauth/authorize` with `scope=read,activity:read_all`, `approval_prompt=auto` |
| Token exchange / refresh | `POST https://www.strava.com/oauth/token` (`authorization_code`, `refresh_token`) |
| Disconnect | `POST https://www.strava.com/oauth/deauthorize` |
| History | `GET /api/v3/athlete/activities?after&before&page&per_page` |
| One activity | `GET /api/v3/activities/{id}` (on webhook events) |
| Webhooks | Push subscription to `$PUBLIC_BASE_URL/webhooks/strava/$STRAVA_WEBHOOK_SECRET` |

Access tokens last 6 hours; Fit refreshes them shortly before expiry and
always stores the latest refresh token. A connection that grants neither
`activity:read` nor `activity:read_all` is refused and deauthorized.

## Setup

1. Create an application at <https://www.strava.com/settings/api>.
   - **Authorization Callback Domain**: the host of `PUBLIC_BASE_URL`
     (e.g. `fit.example.com`; `localhost` works for local testing).
   - Fit's redirect URI is `$PUBLIC_BASE_URL/connect/strava/callback`.
2. Set `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET` (secrets: use a Secret
   store, never commit them).
3. Generate a webhook secret, `openssl rand -hex 24`, and set `STRAVA_WEBHOOK_SECRET`.
4. Deploy, then create the push subscription **once per application** (Strava
   calls the callback with a validation GET that Fit must answer within 2 s):

   ```bash
   curl -X POST https://www.strava.com/api/v3/push_subscriptions \
     -F client_id="$STRAVA_CLIENT_ID" \
     -F client_secret="$STRAVA_CLIENT_SECRET" \
     -F callback_url="$PUBLIC_BASE_URL/webhooks/strava/$STRAVA_WEBHOOK_SECRET" \
     -F verify_token="$STRAVA_WEBHOOK_SECRET"
   # -> {"id": 123456}
   ```

5. Set `STRAVA_WEBHOOK_SUBSCRIPTION_ID` to the returned `id` and restart. Fit
   then rejects events from any other subscription.

To inspect or delete the subscription:
`GET/DELETE https://www.strava.com/api/v3/push_subscriptions[/{id}]?client_id=…&client_secret=…`.

## Limitations

- **Strava does not sign webhook events.** Fit authenticates them with the
  secret path segment and the subscription ID, routes them only through a
  stored connection, and **re-fetches every activity from the API** with the
  athlete's token, so a forged event can at most trigger a harmless re-read.
- **Rate limits** (per application, by default 200 requests per 15 minutes and
  2,000 per day; read limits are lower) apply to all users together. A 429
  fails the sync run (or retries the webhook later) with `upstream_rate_limited`.
- New Strava applications start in single-player mode (only the owner can
  connect) until Strava approves a higher athlete capacity.
- Strava's API terms restrict how the data may be shown and shared; Fit only
  shows a user their own data.
- Webhook delivery is best effort (Strava retries up to 3 times); `sync_provider`
  closes any gap.
