# Garmin

Status: **implemented to Garmin's published specification behind the provider
adapter, disabled until credentials are configured, and not yet verified
against the live API.** Fit uses only the official program; there is no
scraping and no use of Garmin Connect passwords.

Code: `apps/backend/src/providers/garmin/garmin.adapter.ts`,
`packages/activity-model/src/garmin.ts`.

## The official path and its restriction

Garmin exposes activity data to third parties only through the **Garmin
Connect Developer Program** (Activity API, alongside the Health API):

- **Access is approval-based.** You apply as a business through the Garmin
  developer portal and receive a consumer key/secret only after Garmin
  approves the application. There is no self-serve personal API key.
- Garmin's program has business tiers. As described by integrators: **Starter**
  is push-only, has no historical data and allows up to 1,000 connected users;
  **Enterprise** adds Ping/Pull and history backfill. Integrators have also
  reported that new applications were paused or slow to be answered. **This
  could not be confirmed from an official public source while building Fit;
  check the portal for the current status.**
- Consequently the Garmin integration could not be exercised against
  Garmin's servers. It is covered by tests against a fake that follows the
  documented contract (`garmin.e2e.spec.ts`).

## What Fit implements

| Purpose | Endpoint (configurable) |
|---|---|
| Authorize (OAuth 2.0 + PKCE S256) | `GET https://connect.garmin.com/oauth2Confirm` |
| Token exchange / refresh | `POST https://diauth.garmin.com/di-oauth2-service/oauth/token` |
| User ID | `GET https://apis.garmin.com/wellness-api/rest/user/id` |
| Data permissions | `GET …/wellness-api/rest/user/permissions` (needs `ACTIVITY_EXPORT`) |
| Disconnect | `DELETE …/wellness-api/rest/user/registration` |
| History | `GET …/wellness-api/rest/backfill/activities?summaryStartTimeInSeconds&summaryEndTimeInSeconds` (30-day chunks; data arrives by Push) |
| Push / Ping | `POST $PUBLIC_BASE_URL/webhooks/garmin/$GARMIN_WEBHOOK_SECRET` |

Webhook handling:

- **Push** (`activities`, `manuallyUpdatedActivities`): the summary itself is
  imported. Any `userAccessToken` field is stripped before storage.
- **Ping** (items with `callbackURL`): Fit fetches the URL with the user's
  token, **only** if it is on `GARMIN_API_BASE_URL`'s host; anything else is a
  permanent failure, so a forged ping cannot exfiltrate a token.
- `deregistrations` mark the connection `revoked`; `userPermissionsChange`
  updates scopes and flags a missing `ACTIVITY_EXPORT`.
- The activity ID is Garmin's `summaryId`; `activityId` builds the Garmin
  Connect link.

## Next steps to enable it

1. Apply to the Garmin Connect Developer Program (Activity API) and get an
   app approved. Ask for the tier that includes history backfill if you want
   past activities.
2. In the developer portal, set the OAuth redirect URI to
   `$PUBLIC_BASE_URL/connect/garmin/callback`, enable the Activity summary
   endpoint in **Push** mode (or Ping) and point it at
   `$PUBLIC_BASE_URL/webhooks/garmin/$GARMIN_WEBHOOK_SECRET`.
3. Set `GARMIN_CLIENT_ID`, `GARMIN_CLIENT_SECRET`, `GARMIN_WEBHOOK_SECRET`.
4. Verify against Garmin's current specification documents (from the portal):
   the endpoint URLs above, the token response fields, and the backfill
   window limits. Adjust `GARMIN_*_URL` or the adapter if they differ, then
   connect a test account and check `list_webhook_events` and `list_sync_runs`.

## Limitations

- Garmin does not sign Push/Ping notifications; Fit relies on the secret URL
  path and on routing only to stored connections. Push bodies are trusted as
  data (they are the data), which is the main residual risk if the secret
  leaks; rotate `GARMIN_WEBHOOK_SECRET` (and the portal URL) if it does.
- History depends on the tier; Starter apps receive only new activities.
- Only activity summaries are imported (no FIT files, laps or samples).
