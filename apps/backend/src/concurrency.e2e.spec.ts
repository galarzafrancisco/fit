import { DataSource } from 'typeorm';
import { ActivityIngestService } from './activities/activity-ingest.service';
import { ConnectionsService } from './connections/connections.service';
import { connectStrava, createTestApp, usingRealPostgres, type TestApp } from './test-support/test-app';

/**
 * Races that matter with several requests or replicas. On PGlite the pool
 * has one connection, so these mostly prove correctness; on Postgres
 * (TEST_POSTGRES_URL, as in CI) they exercise real row locks and unique keys.
 */
describe(`concurrency (${usingRealPostgres ? 'Postgres' : 'PGlite'})`, () => {
  let test: TestApp;
  let db: DataSource;

  beforeAll(async () => {
    test = await createTestApp();
    db = test.app.get(DataSource);
  });
  afterAll(async () => {
    await test.close();
  });

  it('parallel imports of one activity create one row and one payload version', async () => {
    const token = await test.token({ subject: 'racer' });
    await connectStrava(test, token, '8080');
    const [connection] = await db.query(`SELECT id, user_id FROM provider_connections WHERE external_user_id = '8080'`);
    const raw = test.strava.addActivity('8080', { id: 7007, name: 'Raced' });
    const ingest = test.app.get(ActivityIngestService);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => ingest.ingest({ userId: connection.user_id, connectionId: connection.id, provider: 'strava', raw, source: 'webhook' })),
    );
    expect(results.filter((r) => r.outcome === 'created')).toHaveLength(1);
    expect(new Set(results.map((r) => r.activityId)).size).toBe(1);
    const [counts] = await db.query(
      `SELECT (SELECT count(*)::int FROM activities WHERE provider_activity_id = '7007') AS activities, (SELECT count(*)::int FROM activity_payloads p JOIN activities a ON a.id = p.activity_id WHERE a.provider_activity_id = '7007') AS payloads`,
    );
    expect(counts).toEqual({ activities: 1, payloads: 1 });
  });

  it('parallel callers share one token refresh (rotating refresh tokens are spent once)', async () => {
    const [connection] = await db.query(`SELECT id FROM provider_connections WHERE external_user_id = '8080'`);
    await db.query(`UPDATE provider_connections SET access_token_expires_at = now() - interval '1 minute' WHERE id = $1`, [connection.id]);
    const refreshes = () => test.strava.calls.filter((c) => c.body?.get('grant_type') === 'refresh_token').length;
    const before = refreshes();
    const connections = test.app.get(ConnectionsService);
    const tokens = await Promise.all(Array.from({ length: 5 }, () => connections.accessToken(connection.id)));
    expect(refreshes()).toBe(before + 1);
    expect(new Set(tokens).size).toBe(1);
  });
});
