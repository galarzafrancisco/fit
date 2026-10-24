import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { GarminSyncService } from './sync/garmin-sync.service';
import { garminActivity } from './test-support/fake-providers';
import { callTool, connectGarmin, createTestApp, syncIdle, type TestApp } from './test-support/test-app';

const KEY_A = 'garmin-personal-key-for-user-a-0123456789';
const KEY_B = 'garmin-personal-key-for-user-b-9876543210';

/** An activity that started `hoursAgo` hours ago (inside the incremental poll window) */
function recent(n: number, hoursAgo: number) {
  const gmt = new Date(Date.now() - hoursAgo * 3_600_000);
  const fmt = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');
  return garminActivity(n, { startTimeGMT: fmt(gmt), startTimeLocal: fmt(new Date(gmt.getTime() + 39_600_000)) });
}

describe('Garmin end to end (Personal API: per-user API key, scheduled polling)', () => {
  let test: TestApp;
  let tokenA: string;
  let tokenB: string;
  let db: DataSource;
  const logged: string[] = [];
  const later = (minutes = 60) => new Date(Date.now() + minutes * 60_000);
  const garminConnection = async (token: string) => (await callTool(test, token, 'list_connections')).data.find((c: any) => c.provider === 'garmin');

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
    }
    test = await createTestApp();
    db = test.app.get(DataSource);
    tokenA = await test.token({ subject: 'garmin-owner-a' });
    tokenB = await test.token({ subject: 'garmin-owner-b' });
    // 12 activities, oldest first n=0..11 (Jan 2026)
    test.garmin.addKey(KEY_A, 'account-a');
    test.garmin.addActivities(
      'account-a',
      Array.from({ length: 12 }, (_, n) => garminActivity(n)),
    );
    test.garmin.addKey(KEY_B, 'account-b');
    test.garmin.addActivities('account-b', [garminActivity(100)]);
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    await test.close();
  });

  describe('connecting', () => {
    it('has no OAuth flow: connect_provider points to connect_garmin and the callback route refuses', async () => {
      const result = await callTool(test, tokenA, 'connect_provider', { provider: 'garmin' });
      expect(result.isError).toBe(true);
      expect(result.data.error.message).toMatch(/connect_garmin/);
      const callback = await test.http.get('/connect/garmin/callback').query({ state: 'x', code: 'y' });
      expect(callback.status).toBe(400);
    });

    it('reports Garmin as an API-key provider before anything is connected', async () => {
      expect(await garminConnection(tokenA)).toMatchObject({
        provider: 'garmin',
        available: true,
        authMethod: 'api_key',
        status: 'not_connected',
        syncMode: 'pull',
      });
    });

    it('connect_garmin returns a single-use Fit link without any key or user ID', async () => {
      const result = await callTool(test, tokenA, 'connect_garmin');
      expect(result.isError).toBe(false);
      const url = new URL(result.data.connectUrl);
      expect(url.origin + url.pathname).toBe('http://fit.test/connect/garmin');
      expect([...url.searchParams.keys()]).toEqual(['link']);
      expect(result.data.instructions).toMatch(/never paste the key into this chat/i);
      const [row] = await db.query(`SELECT state_hash, user_id FROM oauth_states WHERE provider = 'garmin'`);
      expect(row.state_hash).not.toContain(url.searchParams.get('link'));
    });

    it('requires a valid Taico token to get a link', async () => {
      expect((await test.http.post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'connect_garmin' } })).status).toBe(401);
    });

    it('shows whose account the link belongs to and refuses a forged or unknown link', async () => {
      const started = await callTool(test, tokenA, 'connect_garmin');
      const link = new URL(started.data.connectUrl).searchParams.get('link')!;
      const page = await test.http.get('/connect/garmin').query({ link });
      expect(page.status).toBe(200);
      expect(page.text).toContain('garmin-owner-a');
      expect(page.text).toContain('type="password"');
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.headers['content-security-policy']).toContain("default-src 'none'");
      // A user ID in the URL has no effect on identity
      const spoof = await test.http.get('/connect/garmin').query({ link: 'nope', user: 'garmin-owner-b', userId: 'x' });
      expect(spoof.status).toBe(400);
      expect((await test.http.get('/connect/garmin')).status).toBe(400);
      const post = await test.http.post('/connect/garmin').type('form').send({ link: 'forged', apiKey: KEY_A });
      expect(post.status).toBe(400);
      expect(post.text).not.toContain(KEY_A);
    });

    it('refuses an expired link and a key Garmin rejects, storing nothing', async () => {
      const expired = await callTool(test, tokenA, 'connect_garmin');
      const expiredLink = new URL(expired.data.connectUrl).searchParams.get('link')!;
      await db.query(`UPDATE oauth_states SET expires_at = now() - interval '1 minute'`);
      expect((await test.http.get('/connect/garmin').query({ link: expiredLink })).status).toBe(400);
      expect((await test.http.post('/connect/garmin').type('form').send({ link: expiredLink, apiKey: KEY_A })).text).toMatch(/expired/);

      const rejected = await connectGarmin(test, tokenA, 'wrong-key-that-garmin-does-not-know');
      expect(rejected.submit.status).toBe(400);
      expect(rejected.submit.text).toMatch(/rejected that key/);
      expect(rejected.submit.text).not.toContain('wrong-key-that-garmin-does-not-know');
      expect((await garminConnection(tokenA)).status).toBe('not_connected');
      expect(await db.query(`SELECT 1 FROM provider_connections WHERE provider = 'garmin'`)).toHaveLength(0);
    });

    it('stores the key encrypted for the authenticated user and starts the history import', async () => {
      const { form, submit, link } = await connectGarmin(test, tokenA, KEY_A);
      expect(form.status).toBe(200);
      expect(submit.status).toBe(200);
      expect(submit.text).toContain('Garmin connected');
      expect(submit.text).not.toContain(KEY_A);
      // The link was single-use
      const again = await test.http.post('/connect/garmin').type('form').send({ link, apiKey: KEY_A });
      expect(again.status).toBe(400);

      const [row] = await db.query(`SELECT c.*, u.subject FROM provider_connections c JOIN users u ON u.id = c.user_id WHERE c.provider = 'garmin'`);
      expect(row.subject).toBe('garmin-owner-a');
      expect(row.api_key_enc).toMatch(/^v1\./);
      expect(JSON.stringify(row)).not.toContain(KEY_A);
      expect(row.access_token_enc).toMatch(/^v1\./);
      expect(row.status).toBe('active');
    });

    it('never exposes the key or tokens through MCP, REST, pages or logs', async () => {
      const connections = await callTool(test, tokenA, 'list_connections');
      const runs = await callTool(test, tokenA, 'list_sync_runs');
      const rest = await test.http
        .get('/api/connections')
        .set('Authorization', `Bearer ${await test.token({ subject: 'garmin-owner-a', audience: test.config.auth.apiResourceUrl })}`);
      const everything = JSON.stringify([connections.data, runs.data, rest.body]) + logged.join('\n');
      expect(everything).not.toContain(KEY_A);
      expect(everything).not.toMatch(/ApiKey /);
      const tokens = (await db.query(`SELECT count(*)::int AS n FROM activity_payloads WHERE payload::text LIKE '%eyJ%'`))[0].n;
      expect(tokens).toBe(0);
      expect(connections.data.find((c: any) => c.provider === 'garmin').externalUserId).toBeNull();
    });
  });

  describe('history import (newest first, resumable)', () => {
    it('imports the first pages, persists progress and reports it as partial', async () => {
      const connection = await garminConnection(tokenA);
      expect(connection.history).toEqual({ complete: false, activitiesWalked: 10 });
      const runs = (await callTool(test, tokenA, 'list_sync_runs', { provider: 'garmin' })).data;
      expect(runs[0]).toMatchObject({ kind: 'initial', trigger: 'connect', status: 'partial', pages: 2, fetched: 10, created: 10 });
      const calls = test.garmin.listCalls().map((c) => `${c.url.searchParams.get('start')}/${c.url.searchParams.get('limit')}`);
      expect(calls).toEqual(['0/1', '0/5', '5/5']);
      // Newest first: activities 11..2 are in, 1 and 0 are not yet
      const list = await callTool(test, tokenA, 'list_activities', { provider: 'garmin', limit: 50 });
      expect(list.data.items).toHaveLength(10);
      expect(list.data.items[0].name).toBe('Activity 11');
      expect(connection.nextSyncAt).not.toBeNull();
    });

    it('does not poll again before the next scheduled time', async () => {
      expect(await test.app.get(GarminSyncService).tick()).toBe(0);
    });

    it('resumes from the stored offset on the next scheduled run and completes', async () => {
      const before = test.garmin.listCalls().length;
      expect(await test.app.get(GarminSyncService).tick(later())).toBe(1);
      const calls = test.garmin
        .listCalls()
        .slice(before)
        .map((c) => `${c.url.searchParams.get('start')}${c.url.searchParams.get('startDate') ? '+date' : ''}`);
      // One poll for new activity (none), then the history walk from offset 10
      expect(calls).toEqual(['0+date', '10']);
      const connection = await garminConnection(tokenA);
      expect(connection.history).toEqual({ complete: true, activitiesWalked: 12 });
      expect((await callTool(test, tokenA, 'list_activities', { provider: 'garmin', limit: 50 })).data.items).toHaveLength(12);
      expect(connection.lastError).toBeNull();
    });
  });

  describe('incremental polling and de-duplication', () => {
    it('imports only new activities as created and re-reads overlap as unchanged', async () => {
      test.garmin.addActivities('account-a', [recent(200, 5), recent(201, 1)]);
      await test.app.get(GarminSyncService).tick(later(120));
      const [run] = (await callTool(test, tokenA, 'list_sync_runs', { provider: 'garmin', limit: 1 })).data;
      expect(run).toMatchObject({ kind: 'incremental', trigger: 'scheduled', status: 'succeeded', created: 2, unchanged: 0 });
      // The same data again: nothing new, nothing duplicated
      await test.app.get(GarminSyncService).tick(later(240));
      const [again] = (await callTool(test, tokenA, 'list_sync_runs', { provider: 'garmin', limit: 1 })).data;
      expect(again).toMatchObject({ status: 'succeeded', created: 0, updated: 0, unchanged: 2 });
      const list = await callTool(test, tokenA, 'list_activities', { provider: 'garmin', limit: 50 });
      expect(list.data.items).toHaveLength(14);
      expect(new Set(list.data.items.map((i: any) => i.id)).size).toBe(14);
    });

    it('stores changes as a new payload version without losing the old one', async () => {
      test.garmin.activities.get('account-a')!.find((a) => a.activityId === 9_000_000_201)!.activityName = 'Renamed';
      await test.app.get(GarminSyncService).tick(later(360));
      const list = await callTool(test, tokenA, 'list_activities', { provider: 'garmin', search: 'Renamed' });
      expect(list.data.items).toHaveLength(1);
      const versions = await db.query(
        `SELECT count(*)::int AS n FROM activity_payloads p JOIN activities a ON a.id = p.activity_id WHERE a.provider_activity_id = '9000000201'`,
      );
      expect(versions[0].n).toBe(2);
    });

    it('skips unreadable items and keeps the rest', async () => {
      test.garmin.addActivities('account-a', [{ activityName: 'no id', startTimeGMT: 'soon' }, recent(202, 0.5)]);
      await test.app.get(GarminSyncService).tick(later(480));
      const [run] = (await callTool(test, tokenA, 'list_sync_runs', { provider: 'garmin', limit: 1 })).data;
      expect(run).toMatchObject({ created: 1, skipped: 1 });
      expect(run.error).toMatch(/Skipped unreadable activity/);
      test.garmin.activities.set(
        'account-a',
        test.garmin.activities.get('account-a')!.filter((a) => a.activityId),
      );
    });

    it('catches up on more new activity than one page budget in a single run, without re-walking history', async () => {
      test.garmin.addActivities(
        'account-a',
        Array.from({ length: 11 }, (_, i) => recent(300 + i, 0.1 + i / 100)),
      );
      const before = test.garmin.listCalls().length;
      await test.app.get(GarminSyncService).tick(later(600));
      const [run] = (await callTool(test, tokenA, 'list_sync_runs', { provider: 'garmin', limit: 1 })).data;
      expect(run).toMatchObject({ status: 'succeeded', created: 11, pages: 3 });
      expect(test.garmin.listCalls().length - before).toBe(3);
      expect((await garminConnection(tokenA)).history.complete).toBe(true);
      expect((await callTool(test, tokenA, 'list_activities', { provider: 'garmin', limit: 100 })).data.items).toHaveLength(26);
    });
  });

  describe('refresh_garmin (sync now)', () => {
    it('syncs on demand and returns status, never credentials', async () => {
      test.garmin.addActivities('account-a', [recent(400, 0.01)]);
      const result = await callTool(test, tokenA, 'refresh_garmin');
      expect(result.isError).toBe(false);
      expect(result.data).toMatchObject({ provider: 'garmin', trigger: 'manual', status: 'succeeded', created: 1 });
      expect(JSON.stringify(result.data)).not.toContain(KEY_A);
    });

    it('is safe to call repeatedly: a recent run is returned instead of calling Garmin again', async () => {
      const original = test.config.garmin.manualMinIntervalSeconds;
      (test.config.garmin as any).manualMinIntervalSeconds = 300;
      const before = test.garmin.calls.length;
      const result = await callTool(test, tokenA, 'refresh_garmin');
      (test.config.garmin as any).manualMinIntervalSeconds = original;
      expect(result.data.note).toMatch(/less than 300 seconds ago/);
      expect(test.garmin.calls.length).toBe(before);
      // sync_provider is the same operation
      expect((await callTool(test, tokenA, 'sync_provider', { provider: 'garmin' })).isError).toBe(false);
    });

    it('requires a connected Garmin account', async () => {
      const result = await callTool(test, tokenB, 'refresh_garmin');
      expect(result.isError).toBe(true);
      expect(result.data.error.code).toBe('not_found');
    });
  });

  describe('failures, rate limits and credentials', () => {
    it('retries transient errors and rate limits with backoff and succeeds', async () => {
      test.garmin.failNext.push({ status: 503 }, { status: 429, headers: { 'retry-after': '1' } });
      const retryBase = test.config.garmin.retryBaseMs;
      (test.config.garmin as any).retryBaseMs = 1;
      const started = Date.now();
      const result = await callTool(test, tokenA, 'refresh_garmin');
      (test.config.garmin as any).retryBaseMs = retryBase;
      expect(result.data.status).toBe('succeeded');
      // The 429 asked for one second
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
      expect(test.garmin.failNext).toHaveLength(0);
    });

    it('gives up after the retries, backs the connection off and reports it', async () => {
      test.garmin.failNext.push(...Array.from({ length: 4 }, () => ({ status: 429 })));
      const result = await callTool(test, tokenA, 'refresh_garmin');
      expect(result.data).toMatchObject({ status: 'failed' });
      expect(result.data.error).toMatch(/rate limit/i);
      const connection = await garminConnection(tokenA);
      expect(connection.status).toBe('active');
      expect(new Date(connection.backoffUntil).getTime()).toBeGreaterThan(Date.now());
      expect(connection.lastError).toMatch(/rate limit/i);

      // Neither the scheduler nor refresh_garmin hammer Garmin during the backoff
      const calls = test.garmin.calls.length;
      expect(await test.app.get(GarminSyncService).tick()).toBe(0);
      const refreshed = await callTool(test, tokenA, 'refresh_garmin');
      expect(refreshed.data.note).toMatch(/given time to recover/);
      expect(test.garmin.calls.length).toBe(calls);

      // After the backoff the next scheduled run recovers and clears the state
      await db.query(
        `UPDATE provider_connections SET backoff_until = now() - interval '1 second', next_sync_at = now() - interval '1 second' WHERE provider = 'garmin'`,
      );
      expect(await test.app.get(GarminSyncService).tick()).toBe(1);
      const recovered = await garminConnection(tokenA);
      expect(recovered.backoffUntil).toBeNull();
      expect(recovered.lastError).toBeNull();
      expect((await db.query(`SELECT failure_count FROM provider_connections WHERE provider = 'garmin'`))[0].failure_count).toBe(0);
    });

    it('grows the backoff with repeated failures', async () => {
      const failures = async () => {
        await db.query(`UPDATE provider_connections SET backoff_until = NULL, next_sync_at = NULL WHERE provider = 'garmin'`);
        test.garmin.failNext.push(...Array.from({ length: 4 }, () => ({ status: 500 })));
        await test.app.get(GarminSyncService).tick();
        return (await db.query(`SELECT failure_count, backoff_until FROM provider_connections WHERE provider = 'garmin'`))[0];
      };
      const first = await failures();
      const second = await failures();
      expect(second.failure_count).toBe(first.failure_count + 1);
      expect(new Date(second.backoff_until).getTime()).toBeGreaterThan(new Date(first.backoff_until).getTime());
      await db.query(`UPDATE provider_connections SET backoff_until = NULL, next_sync_at = NULL, failure_count = 0 WHERE provider = 'garmin'`);
    });

    it('gets a new access token from the key when the old one expired', async () => {
      const tokensBefore = test.garmin.tokenRequests;
      test.garmin.expireTokens();
      const result = await callTool(test, tokenA, 'refresh_garmin');
      expect(result.data.status).toBe('succeeded');
      expect(test.garmin.tokenRequests).toBe(tokensBefore + 1);
    });

    it('rejects a key that Garmin says is shared with another Fit user', async () => {
      test.garmin.addKey(KEY_B, 'account-b');
      const shared = await connectGarmin(test, tokenB, KEY_A);
      expect(shared.submit.status).toBe(400);
      expect(shared.submit.text).toMatch(/already connected to another Fit user/);
    });

    it('asks the user to reconnect when the key is deleted or expired at Garmin', async () => {
      test.garmin.keys.delete(KEY_A);
      test.garmin.expireTokens();
      const result = await callTool(test, tokenA, 'refresh_garmin');
      expect(result.data.status).toBe('failed');
      expect(result.data.note).toMatch(/connect_garmin/);
      const connection = await garminConnection(tokenA);
      expect(connection).toMatchObject({ status: 'needs_reauth', connected: false });
      expect(connection.lastError).toMatch(/connect_garmin/);
      const [row] = await db.query(`SELECT api_key_enc, access_token_enc FROM provider_connections WHERE provider = 'garmin'`);
      expect(row).toEqual({ api_key_enc: null, access_token_enc: null });
      expect((await callTool(test, tokenA, 'refresh_garmin')).data.error.code).toBe('reauthorization_required');
      // Already-imported activities remain
      expect((await callTool(test, tokenA, 'list_activities', { provider: 'garmin', limit: 100 })).data.items.length).toBeGreaterThan(20);
    });

    it('reconnects with a new key, keeping the history progress', async () => {
      test.garmin.addKey('garmin-new-personal-key-for-a-1122334455', 'account-a');
      const { submit } = await connectGarmin(test, tokenA, 'garmin-new-personal-key-for-a-1122334455');
      expect(submit.status).toBe(200);
      const connection = await garminConnection(tokenA);
      expect(connection).toMatchObject({ status: 'active', lastError: null });
      expect(connection.history.complete).toBe(true);
      expect(
        (
          await db.query(
            `SELECT count(*)::int AS n FROM provider_connections WHERE provider = 'garmin' AND user_id = (SELECT id FROM users WHERE subject = 'garmin-owner-a')`,
          )
        )[0].n,
      ).toBe(1);
    });
  });

  describe('per-user isolation', () => {
    it('keeps each user key and data separate', async () => {
      const { submit } = await connectGarmin(test, tokenB, KEY_B);
      expect(submit.status).toBe(200);
      const b = await callTool(test, tokenB, 'list_activities', { provider: 'garmin', limit: 100 });
      expect(b.data.items).toHaveLength(1);
      expect(b.data.items[0].name).toBe('Activity 100');
      const a = await callTool(test, tokenA, 'list_activities', { provider: 'garmin', limit: 100 });
      expect(a.data.items.some((i: any) => i.name === 'Activity 100')).toBe(false);
      const rows = await db.query(`SELECT user_id, api_key_enc FROM provider_connections WHERE provider = 'garmin'`);
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r: any) => r.api_key_enc)).size).toBe(2);
      // B's sync runs are B's alone
      const runsB = (await callTool(test, tokenB, 'list_sync_runs', { provider: 'garmin' })).data;
      expect(runsB.every((r: any) => r.fetched <= 1)).toBe(true);
    });

    it('lets one user disconnect without touching the other', async () => {
      const result = await callTool(test, tokenB, 'disconnect_provider', { provider: 'garmin', deleteActivities: true });
      expect(result.data).toMatchObject({ status: 'disconnected', deletedActivities: 1 });
      const [row] = await db.query(
        `SELECT api_key_enc, history_offset, history_complete FROM provider_connections c JOIN users u ON u.id = c.user_id WHERE u.subject = 'garmin-owner-b'`,
      );
      expect(row).toEqual({ api_key_enc: null, history_offset: 0, history_complete: false });
      expect((await garminConnection(tokenA)).status).toBe('active');
      await syncIdle(test);
    });
  });
});
