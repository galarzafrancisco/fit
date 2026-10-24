import { DataSource } from 'typeorm';
import { GARMIN_API, garminActivity } from './test-support/fake-providers';
import { GARMIN_WEBHOOK_SECRET, callTool, connectGarmin, createTestApp, drainWebhooks, type TestApp } from './test-support/test-app';

const GARMIN_USER = 'garmin-user-1';

describe('Garmin end to end (Connect Developer Program, OAuth 2.0 PKCE + Push/Ping)', () => {
  let test: TestApp;
  let token: string;
  let db: DataSource;
  const push = (body: unknown, secret = GARMIN_WEBHOOK_SECRET) => test.http.post(`/webhooks/garmin/${secret}`).send(body as object);

  beforeAll(async () => {
    test = await createTestApp();
    db = test.app.get(DataSource);
    token = await test.token({ subject: 'garmin-owner' });
  });
  afterAll(async () => {
    await test.close();
  });

  it('builds a PKCE authorization request', async () => {
    const result = await callTool(test, token, 'connect_provider', { provider: 'garmin' });
    const url = new URL(result.data.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://garmin.test/oauth2Confirm');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('redirect_uri')).toBe('http://fit.test/connect/garmin/callback');
    const [state] = await db.query(`SELECT code_verifier_enc FROM oauth_states WHERE provider = 'garmin'`);
    expect(state.code_verifier_enc).toMatch(/^v1\./);
  });

  it('connects with the stored verifier and requests a history backfill', async () => {
    const res = await connectGarmin(test, token, GARMIN_USER);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Garmin connected');
    const connection = (await callTool(test, token, 'list_connections')).data.find((c: any) => c.provider === 'garmin');
    expect(connection).toMatchObject({ status: 'active', externalUserId: GARMIN_USER, syncMode: 'push', scopes: ['ACTIVITY_EXPORT', 'HEALTH_EXPORT'] });
    // 90 days in 30-day chunks
    expect(test.garmin.backfills).toHaveLength(3);
    const runs = await callTool(test, token, 'list_sync_runs', { provider: 'garmin' });
    expect(runs.data[0]).toMatchObject({ kind: 'backfill_request', status: 'succeeded' });
  });

  it('ingests pushed activity summaries and strips any user access token from storage', async () => {
    const ride = garminActivity({ summaryId: 'g-1', activityName: 'Lunch Ride', userAccessToken: 'legacy-secret-token' });
    const res = await push({ activities: [ride] }).expect(200);
    expect(res.body).toEqual({ received: 1, duplicates: 0 });
    await push({ activities: [ride] }).expect(200);
    await drainWebhooks(test);
    const list = await callTool(test, token, 'list_activities', { provider: 'garmin' });
    expect(list.data.items).toHaveLength(1);
    expect(list.data.items[0]).toMatchObject({ name: 'Lunch Ride', sport: 'ride', distanceKm: 42, calories: 900 });
    const detail = await callTool(test, token, 'get_activity', { activityId: list.data.items[0].id, includeRaw: true });
    expect(detail.data.raw.userAccessToken).toBeUndefined();
    expect(detail.data.providerUrl).toBe(`https://connect.garmin.com/modern/activity/${ride.activityId}`);
    const stored = await db.query(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE payload::text LIKE '%legacy-secret-token%'`);
    expect(stored[0].n).toBe(0);
  });

  it('follows Ping callback URLs only on the Garmin API host', async () => {
    const query = '?uploadStartTimeInSeconds=1761000000&uploadEndTimeInSeconds=1761086400';
    test.garmin.pingData.set(query, [garminActivity({ summaryId: 'g-2', activityName: 'Pinged Run', activityType: 'RUNNING' })]);
    await push({ activities: [{ userId: GARMIN_USER, callbackURL: `${GARMIN_API}/wellness-api/rest/activities${query}` }] }).expect(200);
    await push({ activities: [{ userId: GARMIN_USER, callbackURL: 'https://attacker.test/steal' }] }).expect(200);
    await drainWebhooks(test);
    expect((await callTool(test, token, 'list_activities', { search: 'Pinged' })).data.items).toHaveLength(1);
    const [bad] = await db.query(`SELECT status, last_error FROM webhook_deliveries WHERE payload->>'callbackURL' LIKE 'https://attacker%'`);
    expect(bad).toEqual({ status: 'failed', last_error: 'Garmin ping callback URL is not on the Garmin API host' });
    expect(test.garmin.calls.some((c) => c.url.host === 'attacker.test')).toBe(false);
  });

  it('rejects the wrong secret and ignores unknown Garmin users', async () => {
    await push({ activities: [garminActivity()] }, 'not-the-secret-not-the-secret').expect(404);
    await push({ activities: [garminActivity({ userId: 'stranger', summaryId: 'g-x' })] }).expect(200);
    await drainWebhooks(test);
    const [row] = await db.query(`SELECT status FROM webhook_deliveries WHERE external_user_id = 'stranger'`);
    expect(row.status).toBe('ignored');
  });

  it('dead-letters an unreadable activity immediately', async () => {
    await push({ activities: [{ userId: GARMIN_USER, summaryId: 'g-broken' }] }).expect(200);
    await drainWebhooks(test);
    const [row] = await db.query(`SELECT status, attempts, outcome FROM webhook_deliveries WHERE payload->>'summaryId' = 'g-broken'`);
    expect(row).toMatchObject({ status: 'failed', attempts: 1, outcome: 'not retryable' });
  });

  it('records permission changes and deregistration', async () => {
    await push({ userPermissionsChange: [{ userId: GARMIN_USER, permissions: ['HEALTH_EXPORT'] }] }).expect(200);
    await drainWebhooks(test);
    let connection = (await callTool(test, token, 'list_connections')).data.find((c: any) => c.provider === 'garmin');
    expect(connection.scopes).toEqual(['HEALTH_EXPORT']);
    expect(connection.lastError).toContain('Activity sharing was turned off');

    await push({ deregistrations: [{ userId: GARMIN_USER }] }).expect(200);
    await drainWebhooks(test);
    connection = (await callTool(test, token, 'list_connections')).data.find((c: any) => c.provider === 'garmin');
    expect(connection.status).toBe('revoked');
  });

  it('summaries span both providers', async () => {
    const summary = await callTool(test, token, 'get_activity_summary', { groupBy: 'provider' });
    expect(summary.data.groups.map((g: any) => g.key)).toEqual(['garmin']);
    expect(summary.data.totals.count).toBe(2);
  });
});

describe('providers without credentials', () => {
  let test: TestApp;

  beforeAll(async () => {
    test = await createTestApp({ env: { GARMIN_CLIENT_ID: '', GARMIN_CLIENT_SECRET: '', GARMIN_WEBHOOK_SECRET: '' } });
  });
  afterAll(async () => {
    await test.close();
  });

  it('reports Garmin as unavailable and explains why on connect', async () => {
    const token = await test.token();
    const connections = await callTool(test, token, 'list_connections');
    expect(connections.data.find((c: any) => c.provider === 'garmin')).toMatchObject({ available: false, status: 'not_connected' });
    const result = await callTool(test, token, 'connect_provider', { provider: 'garmin' });
    expect(result.data.error.code).toBe('not_configured');
    expect(result.data.error.message).toContain('Garmin Connect Developer Program');
    await test.http.post(`/webhooks/garmin/${GARMIN_WEBHOOK_SECRET}`).send({ activities: [] }).expect(404);
  });

  it('rejects unknown providers', async () => {
    const result = await callTool(test, await test.token(), 'connect_provider', { provider: 'polar' });
    expect(result.isError).toBe(true);
  });
});
