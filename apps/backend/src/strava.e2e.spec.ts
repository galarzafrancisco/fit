import type { DataSource } from 'typeorm';
import { DataSource as DataSourceToken } from 'typeorm';
import { STRAVA_SUBSCRIPTION_ID, STRAVA_WEBHOOK_SECRET, callTool, connectStrava, createTestApp, drainWebhooks, type TestApp } from './test-support/test-app';

const ATHLETE = '4242';

function event(overrides: Record<string, unknown> = {}) {
  return {
    object_type: 'activity',
    object_id: 900001,
    aspect_type: 'create',
    owner_id: Number(ATHLETE),
    subscription_id: Number(STRAVA_SUBSCRIPTION_ID),
    event_time: Math.floor(Date.now() / 1000),
    updates: {},
    ...overrides,
  };
}

describe('Strava end to end', () => {
  let test: TestApp;
  let token: string;
  let db: DataSource;
  const makeDue = () => db.query(`UPDATE webhook_deliveries SET next_attempt_at = now() WHERE status = 'pending'`);
  const post = (body: unknown, secret = STRAVA_WEBHOOK_SECRET) => test.http.post(`/webhooks/strava/${secret}`).send(body as object);

  beforeAll(async () => {
    test = await createTestApp();
    db = test.app.get(DataSourceToken);
    token = await test.token({ subject: 'athlete-user' });
  });
  afterAll(async () => {
    await test.close();
  });

  describe('connecting', () => {
    it('connect_provider returns a Strava authorize URL with a single-use state', async () => {
      const result = await callTool(test, token, 'connect_provider', { provider: 'strava' });
      expect(result.isError).toBe(false);
      const url = new URL(result.data.authorizationUrl);
      expect(url.origin + url.pathname).toBe('https://strava.test/oauth/authorize');
      expect(url.searchParams.get('client_id')).toBe('12345');
      expect(url.searchParams.get('redirect_uri')).toBe('http://fit.test/connect/strava/callback');
      expect(url.searchParams.get('scope')).toBe('read,activity:read_all');
      expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      // Only the hash of the state is stored
      const rows = await db.query('SELECT state_hash FROM oauth_states');
      expect(rows.some((r: any) => r.state_hash === url.searchParams.get('state'))).toBe(false);
    });

    it('rejects callbacks with unknown, reused or denied states', async () => {
      const unknown = await test.http.get('/connect/strava/callback').query({ state: 'nope', code: 'x' });
      expect(unknown.status).toBe(400);
      expect(unknown.text).toContain('invalid or was already used');

      const started = await callTool(test, token, 'connect_provider', { provider: 'strava' });
      const state = new URL(started.data.authorizationUrl).searchParams.get('state')!;
      const denied = await test.http.get('/connect/strava/callback').query({ state, error: 'access_denied' });
      expect(denied.status).toBe(400);
      expect(denied.text).toContain('did not grant access');
      // The state was consumed by the denied attempt
      const again = await test.http.get('/connect/strava/callback').query({ state, code: test.strava.approve(ATHLETE) });
      expect(again.status).toBe(400);
    });

    it('refuses a grant without activity read permission and revokes it', async () => {
      const res = await connectStrava(test, token, ATHLETE, 'read');
      expect(res.status).toBe(400);
      expect(res.text).toContain('permission to read your activities');
      expect(test.strava.deauthorized).toContain(ATHLETE);
      const connections = await callTool(test, token, 'list_connections');
      expect(connections.data.find((c: any) => c.provider === 'strava').connected).toBe(false);
    });

    it('connects, stores tokens encrypted, and imports history with an initial sync', async () => {
      const recent = new Date(Date.now() - 3 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const older = new Date(Date.now() - 10 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const ancient = new Date(Date.now() - 400 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      test.strava.addActivity(ATHLETE, { id: 1001, name: 'Tempo run', start_date: recent, sport_type: 'Run', distance: 12000, moving_time: 3000 });
      test.strava.addActivity(ATHLETE, {
        id: 1002,
        name: 'Hill ride',
        start_date: older,
        sport_type: 'GravelRide',
        type: 'Ride',
        distance: 60000,
        moving_time: 9000,
      });
      test.strava.addActivity(ATHLETE, { id: 1003, name: 'Too old for the initial window', start_date: ancient });

      const res = await connectStrava(test, token, ATHLETE);
      expect(res.status).toBe(200);
      expect(res.text).toContain('Strava connected');

      const [row] = await db.query(`SELECT access_token_enc, refresh_token_enc, status, display_name FROM provider_connections WHERE provider = 'strava'`);
      expect(row.status).toBe('active');
      expect(row.display_name).toBe('Ada Runner');
      expect(row.access_token_enc).toMatch(/^v1\./);
      expect(row.access_token_enc).not.toContain('strava-access');

      const runs = await callTool(test, token, 'list_sync_runs');
      expect(runs.data[0]).toMatchObject({ provider: 'strava', trigger: 'connect', kind: 'initial', status: 'succeeded', created: 2 });

      const list = await callTool(test, token, 'list_activities');
      expect(list.data.items.map((a: any) => a.name)).toEqual(['Tempo run', 'Hill ride']);
      expect(list.data.items[1]).toMatchObject({ sport: 'gravel_ride', sportGroup: 'cycling', providerSportType: 'GravelRide', distanceKm: 60 });
      expect(list.data.items[0].averagePaceSecondsPerKm).toBe(250);
    });

    it('lists the connection with its status and counts', async () => {
      const connections = await callTool(test, token, 'list_connections');
      expect(connections.data.find((c: any) => c.provider === 'strava')).toMatchObject({
        available: true,
        connected: true,
        status: 'active',
        externalUserId: ATHLETE,
        syncMode: 'pull',
        activityCount: 2,
        scopes: ['read', 'activity:read_all'],
      });
      // Tokens never leave the server
      expect(JSON.stringify(connections.data)).not.toMatch(/strava-(access|refresh)/);
    });
  });

  describe('querying', () => {
    it('filters by sport group, provider, dates and name, and paginates with a cursor', async () => {
      expect((await callTool(test, token, 'list_activities', { sportGroup: 'cycling' })).data.items.map((a: any) => a.name)).toEqual(['Hill ride']);
      expect((await callTool(test, token, 'list_activities', { sport: ['run', 'trail_run'] })).data.items.map((a: any) => a.name)).toEqual(['Tempo run']);
      expect((await callTool(test, token, 'list_activities', { provider: 'garmin' })).data.items).toEqual([]);
      expect((await callTool(test, token, 'list_activities', { search: 'HILL' })).data.items).toHaveLength(1);
      const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
      expect((await callTool(test, token, 'list_activities', { from: fiveDaysAgo })).data.items.map((a: any) => a.name)).toEqual(['Tempo run']);
      expect((await callTool(test, token, 'list_activities', { to: fiveDaysAgo })).data.items.map((a: any) => a.name)).toEqual(['Hill ride']);

      const first = await callTool(test, token, 'list_activities', { limit: 1 });
      expect(first.data.items).toHaveLength(1);
      const second = await callTool(test, token, 'list_activities', { limit: 1, cursor: first.data.nextCursor });
      expect(second.data.items[0].name).toBe('Hill ride');
      expect(second.data.nextCursor).toBeNull();
      const bad = await callTool(test, token, 'list_activities', { cursor: 'garbage' });
      expect(bad.data.error.code).toBe('validation_failed');
    });

    it('rejects invalid filters with a validation error', async () => {
      const result = await callTool(test, token, 'list_activities', { from: '2026-13-45' });
      expect(result.isError).toBe(true);
      const reversed = await callTool(test, token, 'get_activity_summary', { from: '2026-10-10', to: '2026-10-01' });
      expect(reversed.data.error.code).toBe('validation_failed');
    });

    it('summarizes by sport, sport group and month', async () => {
      const bySport = await callTool(test, token, 'get_activity_summary', {});
      expect(bySport.data.totals).toMatchObject({ count: 2, distanceMeters: 72000, distanceKm: 72, movingTimeSeconds: 12000 });
      expect(bySport.data.groups.map((g: any) => [g.key, g.count])).toEqual([
        ['gravel_ride', 1],
        ['run', 1],
      ]);
      const byGroup = await callTool(test, token, 'get_activity_summary', { groupBy: 'sport_group' });
      expect(byGroup.data.groups.map((g: any) => g.key)).toEqual(['cycling', 'running']);
      const byMonth = await callTool(test, token, 'get_activity_summary', { groupBy: 'month' });
      expect(byMonth.data.totals.count).toBe(2);
      expect(byMonth.data.groups[0].key).toMatch(/^\d{4}-\d{2}$/);
      const byWeek = await callTool(test, token, 'get_activity_summary', { groupBy: 'week', sportGroup: 'running' });
      expect(byWeek.data.totals.count).toBe(1);
    });

    it('returns detail with provenance, raw payload and history', async () => {
      const [first] = (await callTool(test, token, 'list_activities', { search: 'Tempo' })).data.items;
      const detail = await callTool(test, token, 'get_activity', { activityId: first.id, includeRaw: true, includeHistory: true });
      expect(detail.data).toMatchObject({
        providerActivityId: '1001',
        providerUrl: 'https://www.strava.com/activities/1001',
        provenance: { firstSource: 'sync', lastSource: 'sync', payloadVersions: 1, deletedAt: null },
      });
      expect(detail.data.raw.id).toBe(1001);
      expect(detail.data.history).toHaveLength(1);
      expect((await callTool(test, token, 'get_activity', { activityId: 'not-a-uuid' })).data.error.code).toBe('not_found');
    });

    it('exposes activities as MCP resources', async () => {
      const [first] = (await callTool(test, token, 'list_activities', { limit: 1 })).data.items;
      const res = await test.http
        .post('/mcp')
        .set('Authorization', `Bearer ${token}`)
        .set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: `fit://activities/${first.id}` } });
      expect(JSON.parse(res.body.result.contents[0].text).id).toBe(first.id);
    });
  });

  describe('sync', () => {
    it('incremental sync is idempotent and picks up new and changed activities', async () => {
      const now = new Date(Date.now() - 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      test.strava.addActivity(ATHLETE, { id: 1004, name: 'Recovery jog', start_date: now, distance: 5000, moving_time: 1800 });
      const run = await callTool(test, token, 'sync_provider', { provider: 'strava' });
      expect(run.data).toMatchObject({ kind: 'incremental', status: 'succeeded', created: 1 });
      const again = await callTool(test, token, 'sync_provider', { provider: 'strava' });
      expect(again.data).toMatchObject({ status: 'succeeded', created: 0, updated: 0, unchanged: 1 });
      const count = await db.query(`SELECT count(*)::int AS n FROM activities WHERE provider_activity_id = '1004'`);
      expect(count[0].n).toBe(1);
    });

    it('re-reads a window on request with since', async () => {
      const run = await callTool(test, token, 'sync_provider', {
        provider: 'strava',
        since: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10),
      });
      expect(run.data).toMatchObject({ status: 'succeeded', fetched: 3, unchanged: 3 });
    });

    it('refreshes an expired access token and stores the rotated refresh token', async () => {
      await db.query(`UPDATE provider_connections SET access_token_expires_at = now() - interval '1 minute' WHERE provider = 'strava'`);
      const before = await db.query(`SELECT refresh_token_enc FROM provider_connections WHERE provider = 'strava'`);
      const tokenCalls = () => test.strava.calls.filter((c) => c.url.pathname === '/oauth/token' && c.body?.get('grant_type') === 'refresh_token').length;
      const refreshes = tokenCalls();
      const run = await callTool(test, token, 'sync_provider', { provider: 'strava' });
      expect(run.data.status).toBe('succeeded');
      expect(tokenCalls()).toBe(refreshes + 1);
      const after = await db.query(`SELECT refresh_token_enc, access_token_expires_at FROM provider_connections WHERE provider = 'strava'`);
      expect(after[0].refresh_token_enc).not.toBe(before[0].refresh_token_enc);
      expect(new Date(after[0].access_token_expires_at).getTime()).toBeGreaterThan(Date.now());
    });

    it('records a rate-limited sync as failed with the error, and recovers', async () => {
      test.strava.failures.push({ path: '/athlete/activities', status: 429, times: 1 });
      const limited = await callTool(test, token, 'sync_provider', { provider: 'strava' });
      expect(limited.data).toMatchObject({ status: 'failed', error: 'Strava rate limit reached; try again later' });
      const connection = (await callTool(test, token, 'list_connections')).data.find((c: any) => c.provider === 'strava');
      expect(connection.lastError).toContain('rate limit');
      const ok = await callTool(test, token, 'sync_provider', { provider: 'strava' });
      expect(ok.data.status).toBe('succeeded');
      expect((await callTool(test, token, 'list_connections')).data.find((c: any) => c.provider === 'strava').lastError).toBeNull();
    });
  });

  describe('webhooks', () => {
    it('answers the subscription validation challenge only with the right secret and token', async () => {
      const ok = await test.http
        .get(`/webhooks/strava/${STRAVA_WEBHOOK_SECRET}`)
        .query({ 'hub.mode': 'subscribe', 'hub.challenge': 'abc123', 'hub.verify_token': STRAVA_WEBHOOK_SECRET });
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ 'hub.challenge': 'abc123' });
      await test.http
        .get('/webhooks/strava/wrong-secret-wrong-secret-wrong')
        .query({ 'hub.mode': 'subscribe', 'hub.challenge': 'x', 'hub.verify_token': 'x' })
        .expect(404);
      await test.http
        .get(`/webhooks/strava/${STRAVA_WEBHOOK_SECRET}`)
        .query({ 'hub.mode': 'subscribe', 'hub.challenge': 'x', 'hub.verify_token': 'nope' })
        .expect(404);
    });

    it('rejects events with the wrong secret or subscription, and malformed events', async () => {
      await post(event(), 'wrong-secret-wrong-secret-wrong').expect(404);
      await post(event({ subscription_id: 1 })).expect(404);
      await post({ hello: 'world' }).expect(400);
      expect((await db.query('SELECT count(*)::int AS n FROM webhook_deliveries'))[0].n).toBe(0);
    });

    it('imports a created activity by re-fetching it from Strava, once per event', async () => {
      test.strava.addActivity(ATHLETE, { id: 900001, name: 'Webhook run', calories: 512, device_name: 'Forerunner' });
      const body = event();
      const first = await post(body).expect(200);
      expect(first.body).toEqual({ received: 1, duplicates: 0 });
      const duplicate = await post(body).expect(200);
      expect(duplicate.body).toEqual({ received: 1, duplicates: 1 });
      expect(await drainWebhooks(test)).toBe(1);

      const [activity] = (await callTool(test, token, 'list_activities', { search: 'Webhook run' })).data.items;
      expect(activity.calories).toBe(512);
      const events = await callTool(test, token, 'list_webhook_events', { provider: 'strava' });
      expect(events.data[0]).toMatchObject({ eventType: 'activity.create', status: 'processed', outcome: 'activity created', attempts: 1 });
    });

    it('does not trust the event body: a forged update for another athlete is ignored', async () => {
      await post(event({ owner_id: 999999, object_id: 1001, aspect_type: 'delete' })).expect(200);
      await drainWebhooks(test);
      const events = await db.query(`SELECT status, outcome FROM webhook_deliveries WHERE external_user_id = '999999'`);
      expect(events[0]).toMatchObject({ status: 'ignored', outcome: 'no Fit user is connected to this provider account' });
      const [activity] = (await callTool(test, token, 'list_activities', { search: 'Tempo' })).data.items;
      expect(activity.deleted).toBe(false);
    });

    it('applies updates and keeps every payload version', async () => {
      test.strava.addActivity(ATHLETE, { id: 900001, name: 'Webhook run (renamed)', calories: 512, device_name: 'Forerunner' });
      await post(event({ aspect_type: 'update', updates: { title: 'Webhook run (renamed)' }, event_time: Math.floor(Date.now() / 1000) + 1 })).expect(200);
      await drainWebhooks(test);
      const [activity] = (await callTool(test, token, 'list_activities', { search: 'renamed' })).data.items;
      const detail = await callTool(test, token, 'get_activity', { activityId: activity.id, includeHistory: true });
      expect(detail.data.provenance).toMatchObject({ firstSource: 'webhook', lastSource: 'webhook', payloadVersions: 2 });
      expect(detail.data.history.map((h: any) => h.payload.name)).toEqual(['Webhook run', 'Webhook run (renamed)']);
    });

    it('a later summary payload does not erase detailed-only metrics', async () => {
      const sync = await callTool(test, token, 'sync_provider', { provider: 'strava' });
      expect(sync.data.status).toBe('succeeded');
      const [activity] = (await callTool(test, token, 'list_activities', { search: 'renamed' })).data.items;
      expect(activity.calories).toBe(512);
    });

    it('marks deleted activities as deleted but keeps them', async () => {
      await post(event({ aspect_type: 'delete', event_time: Math.floor(Date.now() / 1000) + 2 })).expect(200);
      await drainWebhooks(test);
      expect((await callTool(test, token, 'list_activities', { search: 'renamed' })).data.items).toEqual([]);
      const withDeleted = await callTool(test, token, 'list_activities', { search: 'renamed', includeDeleted: true });
      expect(withDeleted.data.items[0].deleted).toBe(true);
    });

    it('retries a failing delivery with backoff and dead-letters it after the last attempt', async () => {
      test.strava.addActivity(ATHLETE, { id: 900002, name: 'Flaky' });
      test.strava.failures.push({ path: '/activities/900002', status: 500, times: 1 });
      await post(event({ object_id: 900002 })).expect(200);
      await drainWebhooks(test);
      let [row] = await db.query(
        `SELECT status, attempts, last_error, next_attempt_at > now() + interval '50 seconds' AS backed_off FROM webhook_deliveries WHERE payload->>'object_id' = '900002'`,
      );
      expect(row).toMatchObject({ status: 'pending', attempts: 1, last_error: 'Strava answered HTTP 500', backed_off: true });
      // Not due yet: nothing happens
      expect(await drainWebhooks(test)).toBe(0);
      await makeDue();
      await drainWebhooks(test);
      [row] = await db.query(`SELECT status, attempts, outcome FROM webhook_deliveries WHERE payload->>'object_id' = '900002'`);
      expect(row).toMatchObject({ status: 'processed', attempts: 2, outcome: 'activity created' });

      test.strava.failures.push({ path: '/activities/900003', status: 503, times: 100 });
      await post(event({ object_id: 900003 })).expect(200);
      for (let i = 0; i < test.config.webhooks.maxAttempts; i++) {
        await makeDue();
        await drainWebhooks(test);
      }
      [row] = await db.query(`SELECT status, attempts, outcome FROM webhook_deliveries WHERE payload->>'object_id' = '900003'`);
      expect(row).toMatchObject({ status: 'failed', attempts: test.config.webhooks.maxAttempts });
      expect(row.outcome).toContain('gave up');
      const health = await test.http.get('/health');
      expect(health.body.webhooks.failed).toBe(1);
      test.strava.failures.length = 0;
    });

    it('reclaims a delivery left in processing by a crashed worker', async () => {
      test.strava.addActivity(ATHLETE, { id: 900004, name: 'Crash survivor' });
      await post(event({ object_id: 900004 })).expect(200);
      await db.query(
        `UPDATE webhook_deliveries SET status = 'processing', locked_at = now() - interval '1 hour', attempts = 1 WHERE payload->>'object_id' = '900004'`,
      );
      await drainWebhooks(test);
      const [row] = await db.query(`SELECT status FROM webhook_deliveries WHERE payload->>'object_id' = '900004'`);
      expect(row.status).toBe('processed');
    });

    it('a deauthorization event revokes the connection; later events are ignored', async () => {
      await post(event({ object_type: 'athlete', object_id: Number(ATHLETE), aspect_type: 'update', updates: { authorized: 'false' } })).expect(200);
      await drainWebhooks(test);
      const connection = (await callTool(test, token, 'list_connections')).data.find((c: any) => c.provider === 'strava');
      expect(connection).toMatchObject({ connected: false, status: 'revoked' });
      const [row] = await db.query(`SELECT access_token_enc, refresh_token_enc FROM provider_connections WHERE provider = 'strava'`);
      expect(row).toEqual({ access_token_enc: null, refresh_token_enc: null });

      const sync = await callTool(test, token, 'sync_provider', { provider: 'strava' });
      expect(sync.data.error.code).toBe('reauthorization_required');
      // Activities stay
      expect((await callTool(test, token, 'list_activities')).data.items.length).toBeGreaterThan(0);
    });

    it('reconnecting restores the connection; disconnect revokes and can delete activities', async () => {
      const res = await connectStrava(test, token, ATHLETE);
      expect(res.status).toBe(200);
      expect((await callTool(test, token, 'list_connections')).data.find((c: any) => c.provider === 'strava').status).toBe('active');

      const result = await callTool(test, token, 'disconnect_provider', { provider: 'strava', deleteActivities: true });
      expect(result.data).toMatchObject({ provider: 'strava', status: 'disconnected' });
      expect(result.data.deletedActivities).toBeGreaterThan(0);
      expect((await callTool(test, token, 'list_activities', { includeDeleted: true })).data.items).toEqual([]);
      expect((await callTool(test, token, 'disconnect_provider', { provider: 'strava' })).data).toMatchObject({ status: 'disconnected' });
    });

    it('refuses to link a Strava athlete already connected to another Fit user', async () => {
      await connectStrava(test, token, ATHLETE);
      const other = await test.token({ subject: 'someone-else' });
      const res = await connectStrava(test, other, ATHLETE);
      expect(res.status).toBe(400);
      expect(res.text).toContain('already connected to another Fit user');
    });

    it('marks the connection needs_reauth when Strava refuses the refresh token', async () => {
      test.strava.revokeRefreshTokens();
      test.strava.expireAccessTokens();
      await db.query(`UPDATE provider_connections SET access_token_expires_at = now() - interval '1 minute' WHERE provider = 'strava'`);
      const sync = await callTool(test, token, 'sync_provider', { provider: 'strava' });
      expect(sync.data).toMatchObject({ status: 'failed', note: 'Connect the provider again with connect_provider.' });
      const connection = (await callTool(test, token, 'list_connections')).data.find((c: any) => c.provider === 'strava');
      expect(connection.status).toBe('needs_reauth');
    });
  });
});
