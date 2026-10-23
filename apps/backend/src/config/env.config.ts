import { randomBytes } from 'node:crypto';

/**
 * All environment variables are read here, once, and validated. Nothing
 * else reads process.env. Every variable is documented in docs/configuration.md.
 */
export type AppConfig = {
  nodeEnv: 'development' | 'production' | 'test';
  port: number;
  /** Public URL of this backend, without trailing slash. Token audiences, OAuth redirect and webhook URLs are built from it. */
  publicBaseUrl: string;
  database:
    | { driver: 'postgres'; url: string; ssl: boolean; poolMax: number }
    /** Embedded PGlite on disk, in process. Development only */
    | { driver: 'pglite'; dataDir: string }
    /** Embedded PGlite held in process memory (database/in-memory-database.ts). NON-DURABLE */
    | { driver: 'memory' };
  auth: {
    /** The `iss` Taico access tokens carry */
    issuer: string;
    jwksUrl: string;
    /** Authorization servers advertised in protected-resource metadata */
    authorizationServers: string[];
    /** Protected resources: the MCP endpoint and the REST API */
    mcpResourceUrl: string;
    apiResourceUrl: string;
  };
  /** AES-256-GCM key for provider tokens and PKCE verifiers at rest */
  tokenEncryptionKey: Buffer;
  /** True when the key was generated for this process (development only): stored tokens stop decrypting on restart */
  tokenEncryptionKeyEphemeral: boolean;
  strava: StravaConfig;
  garmin: GarminConfig;
  oauth: {
    /** How long a started provider connection may take before its callback is refused */
    stateTtlSeconds: number;
  };
  sync: {
    /** How far back the first sync after connecting reads */
    initialDays: number;
    /** An incremental sync re-reads this many hours before its cursor, to catch late uploads and edits */
    overlapHours: number;
    /** Upper bound on pages followed in one sync, a guard against a paging loop and rate limits */
    maxPages: number;
    /** Activities per page requested from providers that page (Strava caps at 200) */
    pageSize: number;
    /** Per-request timeout towards providers */
    requestTimeoutMs: number;
  };
  webhooks: {
    /** Run the delivery worker in this process */
    workerEnabled: boolean;
    /** How often the worker looks for due deliveries (it is also woken on every new delivery) */
    pollIntervalMs: number;
    /** Attempts before a delivery is marked failed (dead-lettered) */
    maxAttempts: number;
    /** First retry delay; doubles per attempt */
    retryBaseMs: number;
    /** A delivery stuck in "processing" this long (crashed worker) is picked up again */
    staleAfterMs: number;
  };
};

export type StravaConfig = {
  /** Null: Strava is not configured and connect answers not_configured */
  clientId: string | null;
  clientSecret: string | null;
  oauthBaseUrl: string;
  apiBaseUrl: string;
  /** OAuth scopes requested. activity:read_all includes private activities */
  scopes: string[];
  redirectUri: string;
  /**
   * Shared secret for the webhook: Strava echoes it as hub.verify_token when
   * the subscription is created, and it is the last path segment of the
   * callback URL. Strava does not sign events, so this is what authenticates them.
   */
  webhookSecret: string | null;
  /** The push subscription ID Strava returned; events for any other subscription are rejected */
  webhookSubscriptionId: string | null;
  webhookUrl: string | null;
};

export type GarminConfig = {
  clientId: string | null;
  clientSecret: string | null;
  authorizeUrl: string;
  tokenUrl: string;
  apiBaseUrl: string;
  redirectUri: string;
  /** Last path segment of the Push/Ping endpoint URLs registered in the Garmin developer portal */
  webhookSecret: string | null;
  webhookUrl: string | null;
  /** Request a history backfill on connect (needs a Garmin tier that grants historical data) */
  backfillOnConnect: boolean;
};

export const STRAVA_WEBHOOK_PATH = '/webhooks/strava';
export const GARMIN_WEBHOOK_PATH = '/webhooks/garmin';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = parseNodeEnv(env.NODE_ENV);
  const port = parseInt(env.PORT ?? '4190', 10);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`PORT must be a positive integer, got ${env.PORT}`);
  const publicBaseUrl = stripSlash(env.PUBLIC_BASE_URL ?? `http://localhost:${port}`);
  if (!/^https?:\/\//.test(publicBaseUrl)) throw new Error(`PUBLIC_BASE_URL must be an http(s) URL, got ${publicBaseUrl}`);

  if (nodeEnv === 'production' && !env.TAICO_ISSUER) throw new Error('TAICO_ISSUER is required in production');
  const issuer = stripSlash(env.TAICO_ISSUER ?? 'http://localhost:3000');
  const authorizationServers = (env.TAICO_AUTHORIZATION_SERVERS ?? issuer)
    .split(',')
    .map((value) => stripSlash(value.trim()))
    .filter(Boolean);

  const { key: tokenEncryptionKey, ephemeral: tokenEncryptionKeyEphemeral } = loadKey(env, nodeEnv);

  return {
    nodeEnv,
    port,
    publicBaseUrl,
    database: loadDatabaseConfig(env, nodeEnv),
    auth: {
      issuer,
      jwksUrl: env.TAICO_JWKS_URL ?? `${issuer}/.well-known/jwks.json`,
      authorizationServers,
      mcpResourceUrl: `${publicBaseUrl}/mcp`,
      apiResourceUrl: `${publicBaseUrl}/api`,
    },
    tokenEncryptionKey,
    tokenEncryptionKeyEphemeral,
    strava: loadStravaConfig(env, publicBaseUrl),
    garmin: loadGarminConfig(env, publicBaseUrl),
    oauth: { stateTtlSeconds: intEnv(env, 'OAUTH_STATE_TTL_SECONDS', 900, 60, 3600) },
    sync: {
      initialDays: intEnv(env, 'SYNC_INITIAL_DAYS', 90, 1, 3660),
      overlapHours: intEnv(env, 'SYNC_OVERLAP_HOURS', 48, 0, 24 * 30),
      maxPages: intEnv(env, 'SYNC_MAX_PAGES', 50, 1, 1000),
      pageSize: intEnv(env, 'SYNC_PAGE_SIZE', 100, 1, 200),
      requestTimeoutMs: intEnv(env, 'PROVIDER_REQUEST_TIMEOUT_MS', 15_000, 100, 120_000),
    },
    webhooks: {
      workerEnabled: (env.WEBHOOK_WORKER_ENABLED ?? (nodeEnv === 'test' ? 'false' : 'true')) === 'true',
      pollIntervalMs: intEnv(env, 'WEBHOOK_POLL_INTERVAL_MS', 5000, 100, 600_000),
      maxAttempts: intEnv(env, 'WEBHOOK_MAX_ATTEMPTS', 8, 1, 50),
      retryBaseMs: intEnv(env, 'WEBHOOK_RETRY_BASE_MS', 30_000, 0, 3_600_000),
      staleAfterMs: intEnv(env, 'WEBHOOK_STALE_AFTER_MS', 300_000, 1000, 86_400_000),
    },
  };
}

function loadStravaConfig(env: NodeJS.ProcessEnv, publicBaseUrl: string): StravaConfig {
  const clientId = blank(env.STRAVA_CLIENT_ID);
  const clientSecret = blank(env.STRAVA_CLIENT_SECRET);
  if (Boolean(clientId) !== Boolean(clientSecret)) throw new Error('Set both STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET, or neither');
  if (clientId && !/^\d+$/.test(clientId)) throw new Error('STRAVA_CLIENT_ID must be the numeric client ID from https://www.strava.com/settings/api');
  const webhookSecret = webhookSecretEnv(env, 'STRAVA_WEBHOOK_SECRET');
  const webhookSubscriptionId = blank(env.STRAVA_WEBHOOK_SUBSCRIPTION_ID);
  if (webhookSubscriptionId && !/^\d+$/.test(webhookSubscriptionId)) throw new Error('STRAVA_WEBHOOK_SUBSCRIPTION_ID must be numeric');
  return {
    clientId,
    clientSecret,
    oauthBaseUrl: urlEnv(env, 'STRAVA_OAUTH_BASE_URL', 'https://www.strava.com/oauth'),
    apiBaseUrl: urlEnv(env, 'STRAVA_API_BASE_URL', 'https://www.strava.com/api/v3'),
    scopes: ['read', 'activity:read_all'],
    redirectUri: `${publicBaseUrl}/connect/strava/callback`,
    webhookSecret,
    webhookSubscriptionId,
    webhookUrl: webhookSecret ? `${publicBaseUrl}${STRAVA_WEBHOOK_PATH}/${webhookSecret}` : null,
  };
}

function loadGarminConfig(env: NodeJS.ProcessEnv, publicBaseUrl: string): GarminConfig {
  const clientId = blank(env.GARMIN_CLIENT_ID);
  const clientSecret = blank(env.GARMIN_CLIENT_SECRET);
  if (Boolean(clientId) !== Boolean(clientSecret)) throw new Error('Set both GARMIN_CLIENT_ID and GARMIN_CLIENT_SECRET, or neither');
  const webhookSecret = webhookSecretEnv(env, 'GARMIN_WEBHOOK_SECRET');
  return {
    clientId,
    clientSecret,
    authorizeUrl: urlEnv(env, 'GARMIN_AUTHORIZE_URL', 'https://connect.garmin.com/oauth2Confirm'),
    tokenUrl: urlEnv(env, 'GARMIN_TOKEN_URL', 'https://diauth.garmin.com/di-oauth2-service/oauth/token'),
    apiBaseUrl: urlEnv(env, 'GARMIN_API_BASE_URL', 'https://apis.garmin.com'),
    redirectUri: `${publicBaseUrl}/connect/garmin/callback`,
    webhookSecret,
    webhookUrl: webhookSecret ? `${publicBaseUrl}${GARMIN_WEBHOOK_PATH}/${webhookSecret}` : null,
    backfillOnConnect: (env.GARMIN_BACKFILL_ON_CONNECT ?? 'true') === 'true',
  };
}

function loadKey(env: NodeJS.ProcessEnv, nodeEnv: AppConfig['nodeEnv']): { key: Buffer; ephemeral: boolean } {
  if (env.TOKEN_ENCRYPTION_KEY) {
    const key = Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'base64');
    if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)');
    return { key, ephemeral: false };
  }
  if (nodeEnv === 'production') throw new Error('TOKEN_ENCRYPTION_KEY is required in production (openssl rand -base64 32)');
  return { key: randomBytes(32), ephemeral: true };
}

function webhookSecretEnv(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = blank(env[name]);
  if (value && !/^[A-Za-z0-9_-]{24,128}$/.test(value)) {
    throw new Error(`${name} must be 24-128 URL-safe characters (openssl rand -hex 24)`);
  }
  return value;
}

export const DATABASE_MODES = ['postgres', 'pglite', 'memory'] as const;
export type DatabaseMode = (typeof DATABASE_MODES)[number];

/**
 * DATABASE_MODE picks the database explicitly (same rules as money):
 * - `postgres`: DATABASE_URL (required). The only durable production option.
 * - `pglite`: embedded PGlite on disk at PGLITE_DATA_DIR. Development and tests only.
 * - `memory`: embedded PGlite in process memory. NON-DURABLE.
 * Unset means `postgres` when DATABASE_URL is set, else `pglite` outside
 * production. Production never falls back to an embedded database on its own.
 */
function loadDatabaseConfig(env: NodeJS.ProcessEnv, nodeEnv: AppConfig['nodeEnv']): AppConfig['database'] {
  const rawMode = env.DATABASE_MODE?.trim();
  if (rawMode && !(DATABASE_MODES as readonly string[]).includes(rawMode)) {
    throw new Error(`DATABASE_MODE must be one of ${DATABASE_MODES.join(', ')}, got ${rawMode}`);
  }
  const mode = rawMode as DatabaseMode | undefined;
  if (mode === 'memory' || mode === 'pglite') {
    if (env.DATABASE_URL) throw new Error(`DATABASE_MODE=${mode} and DATABASE_URL are both set; unset one so the database in use is unambiguous`);
    if (mode === 'memory') return { driver: 'memory' };
    if (nodeEnv === 'production') throw new Error('DATABASE_MODE=pglite is not allowed in production; use DATABASE_URL');
    return { driver: 'pglite', dataDir: env.PGLITE_DATA_DIR ?? '.data/pglite' };
  }
  if (env.DATABASE_URL) {
    return { driver: 'postgres', url: env.DATABASE_URL, ssl: env.DATABASE_SSL === 'true', poolMax: intEnv(env, 'DATABASE_POOL_MAX', 10, 1, 100) };
  }
  if (mode === 'postgres') throw new Error('DATABASE_MODE=postgres requires DATABASE_URL');
  if (nodeEnv === 'production') {
    throw new Error('DATABASE_URL is required in production. Set DATABASE_MODE=memory only for a temporary deployment whose data may be lost on every restart');
  }
  return { driver: 'pglite', dataDir: env.PGLITE_DATA_DIR ?? '.data/pglite' };
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}, got ${raw}`);
  return value;
}

function urlEnv(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = stripSlash(env[name] ?? fallback);
  if (!/^https?:\/\//.test(value)) throw new Error(`${name} must be an http(s) URL, got ${value}`);
  return value;
}

function blank(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parseNodeEnv(value: string | undefined): AppConfig['nodeEnv'] {
  if (value === 'production' || value === 'test') return value;
  return 'development';
}

function stripSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export const APP_CONFIG = Symbol('APP_CONFIG');
