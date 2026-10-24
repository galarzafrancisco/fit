import { loadConfig } from './env.config';

const PRODUCTION = { NODE_ENV: 'production', TAICO_ISSUER: 'https://taico.app', TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };

describe('loadConfig database selection', () => {
  it('uses Postgres when DATABASE_URL is set', () => {
    expect(loadConfig({ ...PRODUCTION, DATABASE_URL: 'postgresql://u:p@db:5432/fit' }).database).toEqual({
      driver: 'postgres',
      url: 'postgresql://u:p@db:5432/fit',
      ssl: false,
      poolMax: 10,
    });
  });

  it('refuses to start in production without DATABASE_URL or an explicit mode', () => {
    expect(() => loadConfig(PRODUCTION)).toThrow(/DATABASE_URL is required in production/);
  });

  it('allows the explicit non-durable in-memory mode in production', () => {
    expect(loadConfig({ ...PRODUCTION, DATABASE_MODE: 'memory' }).database).toEqual({ driver: 'memory' });
  });

  it('rejects DATABASE_MODE=memory together with DATABASE_URL', () => {
    expect(() => loadConfig({ ...PRODUCTION, DATABASE_MODE: 'memory', DATABASE_URL: 'postgresql://db/fit' })).toThrow(/both set/);
  });

  it('never runs on-disk PGlite in production', () => {
    expect(() => loadConfig({ ...PRODUCTION, DATABASE_MODE: 'pglite' })).toThrow(/not allowed in production/);
  });

  it('requires DATABASE_URL for DATABASE_MODE=postgres', () => {
    expect(() => loadConfig({ NODE_ENV: 'development', DATABASE_MODE: 'postgres' })).toThrow(/requires DATABASE_URL/);
  });

  it('rejects unknown modes', () => {
    expect(() => loadConfig({ NODE_ENV: 'development', DATABASE_MODE: 'sqlite' })).toThrow(/DATABASE_MODE must be one of/);
  });

  it('defaults to on-disk PGlite outside production', () => {
    expect(loadConfig({ NODE_ENV: 'development' }).database).toEqual({ driver: 'pglite', dataDir: '.data/pglite' });
    expect(loadConfig({ NODE_ENV: 'development', PGLITE_DATA_DIR: '/tmp/x' }).database).toEqual({ driver: 'pglite', dataDir: '/tmp/x' });
  });

  it('keeps JWT validation configured in memory mode', () => {
    const config = loadConfig({ ...PRODUCTION, DATABASE_MODE: 'memory', PUBLIC_BASE_URL: 'https://fit.example.com' });
    expect(config.auth.issuer).toBe('https://taico.app');
    expect(config.auth.mcpResourceUrl).toBe('https://fit.example.com/mcp');
    expect(config.auth.apiResourceUrl).toBe('https://fit.example.com/api');
    expect(() => loadConfig({ ...PRODUCTION, TAICO_ISSUER: undefined, DATABASE_MODE: 'memory' })).toThrow(/TAICO_ISSUER is required/);
  });
});

describe('loadConfig secrets and providers', () => {
  it('requires TOKEN_ENCRYPTION_KEY in production and validates its length', () => {
    const { TOKEN_ENCRYPTION_KEY: _key, ...withoutKey } = PRODUCTION;
    expect(() => loadConfig({ ...withoutKey, DATABASE_MODE: 'memory' })).toThrow(/TOKEN_ENCRYPTION_KEY is required/);
    expect(() => loadConfig({ ...PRODUCTION, DATABASE_MODE: 'memory', TOKEN_ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow(/32 bytes/);
    const dev = loadConfig({ NODE_ENV: 'development' });
    expect(dev.tokenEncryptionKeyEphemeral).toBe(true);
  });

  it('leaves providers disabled without credentials and requires id and secret together', () => {
    const config = loadConfig({ NODE_ENV: 'development' });
    expect(config.strava.clientId).toBeNull();
    expect(config.garmin.apiBaseUrl).toBe('https://personal.connectapi.garmin.com');
    expect(() => loadConfig({ NODE_ENV: 'development', STRAVA_CLIENT_ID: '1' })).toThrow(/both STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET/);
    expect(() => loadConfig({ NODE_ENV: 'development', STRAVA_CLIENT_ID: 'abc', STRAVA_CLIENT_SECRET: 's' })).toThrow(/numeric/);
  });

  it('builds callback and webhook URLs from PUBLIC_BASE_URL', () => {
    const secret = 'a'.repeat(32);
    const config = loadConfig({
      NODE_ENV: 'development',
      PUBLIC_BASE_URL: 'https://fit.example.com/',
      STRAVA_WEBHOOK_SECRET: secret,
    });
    expect(config.strava.redirectUri).toBe('https://fit.example.com/connect/strava/callback');
    expect(config.strava.webhookUrl).toBe(`https://fit.example.com/webhooks/strava/${secret}`);
  });

  it('rejects weak or malformed webhook secrets', () => {
    expect(() => loadConfig({ NODE_ENV: 'development', STRAVA_WEBHOOK_SECRET: 'short' })).toThrow(/24-128 URL-safe/);
  });

  it('configures Garmin polling with conservative defaults and validates overrides', () => {
    const garmin = loadConfig({ NODE_ENV: 'development' }).garmin;
    expect(garmin).toMatchObject({ pollerEnabled: true, pollIntervalMs: 30 * 60_000, concurrency: 2, pageSize: 20, minRequestIntervalMs: 1000, maxRetries: 3 });
    expect(loadConfig({ NODE_ENV: 'test' }).garmin.pollerEnabled).toBe(false);
    expect(() => loadConfig({ NODE_ENV: 'development', GARMIN_POLL_INTERVAL_MINUTES: '0' })).toThrow(/GARMIN_POLL_INTERVAL_MINUTES/);
    expect(() => loadConfig({ NODE_ENV: 'development', GARMIN_API_BASE_URL: 'ftp://x' })).toThrow(/GARMIN_API_BASE_URL/);
  });

  it('runs the webhook worker by default except in tests', () => {
    expect(loadConfig({ NODE_ENV: 'development' }).webhooks.workerEnabled).toBe(true);
    expect(loadConfig({ NODE_ENV: 'test' }).webhooks.workerEnabled).toBe(false);
    expect(() => loadConfig({ NODE_ENV: 'development', WEBHOOK_MAX_ATTEMPTS: '0' })).toThrow(/WEBHOOK_MAX_ATTEMPTS/);
  });
});
