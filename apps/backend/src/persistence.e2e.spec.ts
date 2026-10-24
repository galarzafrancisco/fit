import { DataSource } from 'typeorm';
import { callTool, connectStrava, createTestApp, undoMigrationsThrough, type TestApp } from './test-support/test-app';

describe('persistence', () => {
  let test: TestApp;

  beforeAll(async () => {
    test = await createTestApp();
  });
  afterAll(async () => {
    await test.close();
  });

  it('keeps activities, connections and audit across a restart, and migrations are a no-op the second time', async () => {
    const token = await test.token({ subject: 'durable' });
    test.strava.addActivity('31337', { id: 4001, name: 'Survives restarts', start_date: new Date(Date.now() - 86_400_000).toISOString() });
    await connectStrava(test, token, '31337');
    const migrations = await test.app.get(DataSource).query('SELECT count(*)::int AS n FROM migrations');

    await test.restart();

    const again = await test.app.get(DataSource).query('SELECT count(*)::int AS n FROM migrations');
    expect(again[0].n).toBe(migrations[0].n);
    const list = await callTool(test, token, 'list_activities');
    expect(list.data.items.map((a: any) => a.name)).toEqual(['Survives restarts']);
    // The same encryption key decrypts the stored tokens after the restart
    const sync = await callTool(test, token, 'sync_provider', { provider: 'strava' });
    expect(sync.data.status).toBe('succeeded');
    expect((await callTool(test, token, 'list_sync_runs')).data).toHaveLength(2);
  });

  it('enforces the de-duplication key and check constraints in the database', async () => {
    const ds = test.app.get(DataSource);
    const [activity] = await ds.query('SELECT * FROM activities LIMIT 1');
    await expect(
      ds.query(
        `INSERT INTO activities (id, user_id, provider, provider_activity_id, sport, start_time, raw, raw_hash, first_source, last_source, first_imported_at, last_imported_at)
         VALUES (gen_random_uuid(), $1, 'strava', $2, 'run', now(), '{}', repeat('0', 64), 'sync', 'sync', now(), now())`,
        [activity.user_id, activity.provider_activity_id],
      ),
    ).rejects.toThrow(/UQ_activities_user_provider_external|duplicate key/);
    await expect(ds.query(`UPDATE activities SET distance_meters = -1 WHERE id = $1`, [activity.id])).rejects.toThrow(/check constraint/);
    await expect(ds.query(`UPDATE provider_connections SET status = 'bogus'`)).rejects.toThrow(/check constraint/);
    await expect(ds.query(`UPDATE provider_connections SET status = 'disconnected'`)).rejects.toThrow(/CHK_provider_connections_tokens/);
  });

  it('migrations go down and up again', async () => {
    const ds = test.app.get(DataSource);
    await undoMigrationsThrough(ds, 'InitialSchema1761200000000');
    const tables = await ds.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'activities'`);
    expect(tables[0].n).toBe(0);
    await ds.runMigrations();
    const after = await ds.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('users', 'provider_connections', 'oauth_states', 'activities', 'activity_payloads', 'webhook_deliveries', 'sync_runs')`,
    );
    expect(after[0].n).toBe(7);
  });
});
