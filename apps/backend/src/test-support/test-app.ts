import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { staticJwks } from '@taico/auth';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from 'jose';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { loadConfig, type AppConfig } from '../config/env.config';
import { configureApp } from '../configure-app';
import { SyncService } from '../sync/sync.service';
import { WebhookWorker } from '../webhooks/webhook-worker.service';
import { FakeGarmin, FakeStrava, FakeTaico, GARMIN_API, STRAVA_API, STRAVA_OAUTH, providerFetch } from './fake-providers';

export const ISSUER = 'https://taico.test';
export const BASE_URL = 'http://fit.test';
export const STRAVA_WEBHOOK_SECRET = 'strava-webhook-secret-0123456789abcdef';
export const STRAVA_SUBSCRIPTION_ID = '777';

export type TestApp = {
  app: INestApplication;
  http: ReturnType<typeof request>;
  config: AppConfig;
  strava: FakeStrava;
  garmin: FakeGarmin;
  /** Taico's authorization server as the Garmin page's browser sign-in sees it */
  taico: FakeTaico;
  /** Signs an access token the way Taico would */
  token: (options?: TokenOptions) => Promise<string>;
  close: () => Promise<void>;
  /**
   * Stops the app and boots a new one on the same database and signing keys,
   * as a pod restart or redeploy would. `app` and `http` are replaced in place.
   */
  restart: () => Promise<void>;
};

export type TokenOptions = {
  subject?: string;
  audience?: string;
  issuer?: string;
  expiresInSeconds?: number;
  /** Sign with a key the app does not trust */
  foreignKey?: boolean;
  claims?: Record<string, unknown>;
};

/**
 * Starts an in-memory PGlite in a child process, reachable over the Postgres
 * protocol. Each test file gets its own empty database.
 */
async function startDatabase(): Promise<{ url: string; stop: () => Promise<void> }> {
  const child: ChildProcess = fork(join(__dirname, '..', '..', 'test', 'pglite-server.mjs'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const address = await new Promise<string>((resolve, reject) => {
    child.once('message', (message: { address: string }) => resolve(message.address));
    child.once('exit', (code) => reject(new Error(`PGlite test server exited with ${code}`)));
  });
  return {
    url: `postgres://postgres:postgres@${address}/postgres`,
    stop: () =>
      new Promise((resolve) => {
        child.once('exit', () => resolve());
        child.send('stop');
      }),
  };
}

/**
 * With TEST_POSTGRES_URL (an admin connection to a real Postgres server),
 * each test file creates and later drops its own database instead.
 */
async function startPostgresDatabase(adminUrl: string): Promise<{ url: string; stop: () => Promise<void>; poolMax: number }> {
  const { Client } = await import('pg');
  const name = `fit_test_${randomUUID().replace(/-/g, '')}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    poolMax: 5,
    stop: async () => {
      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

/**
 * The PGlite socket server serves one connection at a time and releases a
 * closed one asynchronously, so a connection opened right after the app
 * closes can be dropped. Wait until a fresh client gets an answer.
 */
async function waitForDatabase(url: string): Promise<void> {
  const { Client } = await import('pg');
  for (let attempt = 1; ; attempt++) {
    const client = new Client({ connectionString: url });
    client.on('error', () => undefined);
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (error) {
      await client.end().catch(() => undefined);
      if (attempt >= 50) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/** True when tests run against a real Postgres server with a connection pool */
export const usingRealPostgres = Boolean(process.env.TEST_POSTGRES_URL);

export type TestAppOptions = {
  /** Extra environment variables */
  env?: Record<string, string>;
};

/** Boots the real app on its own database, trusting a key pair generated for the test */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const database = process.env.TEST_POSTGRES_URL ? await startPostgresDatabase(process.env.TEST_POSTGRES_URL) : { ...(await startDatabase()), poolMax: 1 };
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const foreign = await generateKeyPair('RS256');
  const kid = 'test-key';
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };

  const config = loadConfig({
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: BASE_URL,
    DATABASE_URL: database.url,
    // PGlite: one connection, as it is single-session; this also catches any query issued outside its transaction
    DATABASE_POOL_MAX: String(database.poolMax),
    TAICO_ISSUER: ISSUER,
    STRAVA_CLIENT_ID: '12345',
    STRAVA_CLIENT_SECRET: 'strava-secret',
    STRAVA_OAUTH_BASE_URL: STRAVA_OAUTH,
    STRAVA_API_BASE_URL: STRAVA_API,
    STRAVA_WEBHOOK_SECRET,
    STRAVA_WEBHOOK_SUBSCRIPTION_ID: STRAVA_SUBSCRIPTION_ID,
    GARMIN_API_BASE_URL: GARMIN_API,
    GARMIN_PAGE_SIZE: '5',
    GARMIN_MAX_PAGES_PER_RUN: '2',
    GARMIN_MANUAL_MIN_INTERVAL_SECONDS: '0',
    WEBHOOK_RETRY_BASE_MS: '60000',
    ...options.env,
  } as NodeJS.ProcessEnv);
  const strava = new FakeStrava();
  const garmin = new FakeGarmin();
  const taico = new FakeTaico(ISSUER, (subject) => sign(privateKey, { subject }));

  const boot = async (): Promise<INestApplication> => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.forRoot({
          config,
          jwks: staticJwks([jwk]),
          providerFetch: providerFetch(strava, garmin),
          authFetch: ((input, init) => taico.fetch(input, init)) as typeof fetch,
        }),
      ],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false, bodyParser: false });
    configureApp(app);
    await app.init();
    return app;
  };
  const app = await boot();

  const sign = async (key: CryptoKey, options: TokenOptions) =>
    new SignJWT({ client_id: 'test-client', scope: '', ...options.claims })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer(options.issuer ?? ISSUER)
      .setSubject(options.subject ?? 'user-a')
      .setAudience(options.audience ?? config.auth.mcpResourceUrl)
      .setIssuedAt()
      .setJti(randomUUID())
      .setExpirationTime(Math.floor(Date.now() / 1000) + (options.expiresInSeconds ?? 600))
      .sign(key);

  const test: TestApp = {
    app,
    http: request(app.getHttpServer()),
    config,
    strava,
    garmin,
    taico,
    token: (options = {}) => sign(options.foreignKey ? foreign.privateKey : privateKey, options),
    close: async () => {
      await test.app.close();
      await database.stop();
    },
    restart: async () => {
      await test.app.close();
      await waitForDatabase(database.url);
      test.app = await boot();
      test.http = request(test.app.getHttpServer());
    },
  };
  return test;
}

/** Calls an MCP tool over the Streamable HTTP endpoint and returns the parsed result */
export async function callTool(
  test: TestApp,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; data: any; status: number }> {
  const response = await test.http
    .post('/mcp')
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json')
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  if (response.status !== 200) return { isError: true, data: response.body, status: response.status };
  const result = response.body.result;
  if (!result) return { isError: true, data: response.body.error, status: response.status };
  const text = result.content?.[0]?.text;
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // Not JSON: SDK-level validation messages are plain text
  }
  return { isError: Boolean(result.isError), data, status: response.status };
}

/**
 * Reverts migrations, newest first, until the named one (e.g.
 * 'PriceHistoryCache1761700000000') is reverted too, so down/up tests keep
 * working when later migrations are added.
 */
export async function undoMigrationsThrough(ds: DataSource, name: string): Promise<void> {
  const applied = async () => ((await ds.query(`SELECT name FROM migrations WHERE name = $1`, [name])) as unknown[]).length > 0;
  for (let guard = 0; (await applied()) && guard < 100; guard++) await ds.undoLastMigration();
}

/** Sends any MCP JSON-RPC request (tools/list, resources/read, ...) and returns the JSON-RPC response body */
export async function mcpRequest(test: TestApp, token: string, method: string, params: Record<string, unknown> = {}) {
  const response = await test.http
    .post('/mcp')
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json')
    .send({ jsonrpc: '2.0', id: 1, method, params });
  return { status: response.status, body: response.body };
}

/**
 * Runs the whole Strava connection flow as a user would: connect_provider
 * over MCP, approval at (fake) Strava, the browser hitting the callback, and
 * the initial sync finishing. Returns the callback response.
 */
export async function connectStrava(test: TestApp, token: string, athleteId: string, scope = 'read,activity:read_all') {
  const started = await callTool(test, token, 'connect_provider', { provider: 'strava' });
  if (started.isError) throw new Error(`connect_provider failed: ${JSON.stringify(started.data)}`);
  const state = new URL(started.data.authorizationUrl).searchParams.get('state')!;
  const code = test.strava.approve(athleteId);
  const callback = await test.http.get('/connect/strava/callback').query({ state, code, scope });
  await syncIdle(test);
  return callback;
}

/**
 * Runs the whole Garmin connection as a user would: connect_garmin over MCP,
 * the browser opening the link and submitting the user's own API key, and the
 * initial sync finishing. Returns the page responses.
 */
export async function connectGarmin(test: TestApp, token: string, apiKey: string, options: { browserSubject?: string } = {}) {
  const started = await callTool(test, token, 'connect_garmin');
  if (started.isError) throw new Error(`connect_garmin failed: ${JSON.stringify(started.data)}`);
  const url = new URL(started.data.connectUrl as string);
  const link = url.searchParams.get('link')!;
  const browser = await browserSignIn(test, link, options.browserSubject ?? tokenSubject(token));
  const submit = await test.http.post('/connect/garmin').set('Cookie', browser.cookies).type('form').send({ link, apiKey });
  await syncIdle(test);
  return { started: started.data, form: browser.form, submit, link };
}

/** The `sub` of a test access token */
export function tokenSubject(token: string): string {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
}

const cookieHeader = (response: { headers: Record<string, unknown> }, existing = ''): string => {
  const jar = new Map(
    existing
      .split('; ')
      .filter(Boolean)
      .map((c) => [c.split('=')[0], c] as const),
  );
  for (const set of (response.headers['set-cookie'] as string[] | undefined) ?? []) {
    const pair = set.split(';')[0];
    if (/=$/.test(pair) || /Expires=Thu, 01 Jan 1970/i.test(set)) jar.delete(pair.split('=')[0]);
    else jar.set(pair.split('=')[0], pair);
  }
  return [...jar.values()].join('; ');
};

/**
 * What a browser does with a connect link: opens it, is sent to Taico, signs
 * in as `subject`, comes back to Fit and gets the key form. Returns the
 * cookie jar and the final form response (or the first non-redirect answer).
 */
export async function browserSignIn(test: TestApp, link: string, subject: string) {
  const first = await test.http.get('/connect/garmin').query({ link });
  if (first.status !== 302) return { first, callback: undefined, form: first, cookies: cookieHeader(first) };
  const authorize = new URL(first.headers.location);
  let cookies = cookieHeader(first);
  const code = test.taico.approve(subject);
  const callback = await test.http
    .get('/connect/garmin/auth')
    .set('Cookie', cookies)
    .query({ code, state: authorize.searchParams.get('state')! });
  cookies = cookieHeader(callback, cookies);
  const form = callback.status === 302 ? await test.http.get(callback.headers.location).set('Cookie', cookies) : callback;
  return { first, authorize, callback, form, cookies };
}

/** Waits for background syncs started by OAuth callbacks */
export async function syncIdle(test: TestApp): Promise<void> {
  await test.app.get(SyncService).idle();
}

/** Processes every due webhook delivery now */
export async function drainWebhooks(test: TestApp): Promise<number> {
  return test.app.get(WebhookWorker).drain();
}
