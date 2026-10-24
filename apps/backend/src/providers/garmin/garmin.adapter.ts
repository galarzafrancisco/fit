import { mapGarminActivity, type NormalizedActivity } from '@fit/activity-model';
import { UpstreamError, ValidationError } from '../../common/errors';
import type { AppConfig, GarminConfig } from '../../config/env.config';
import { ProviderAuthError, providerRequest } from '../http';
import type { ProviderAdapter, TokenGrant } from '../provider.port';

/** Path of the key-to-token exchange, from Garmin's official Personal API documentation and client */
export const GARMIN_TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';
export const GARMIN_ACTIVITY_SEARCH_PATH = '/activitylist-service/activities/search/activities';

export type GarminListQuery = {
  /** Offset into the newest-first list */
  start: number;
  limit: number;
  /** Inclusive lower bound (YYYY-MM-DD) on the activity start date */
  startDate?: string;
};

/**
 * Garmin Connect Personal API (https://developer.garmin.com/gc-developer-program/personal/).
 *
 * - Authentication: the user's personal API key (`Authorization: ApiKey <key>`)
 *   is exchanged at the token endpoint for a JWT bearer token valid 24 hours
 *   (or until the key expires). There are no refresh tokens: a new token is
 *   obtained from the key. There is NO OAuth flow.
 * - Data: `GET /activitylist-service/activities/search/activities` with
 *   offset paging (`start`, `limit`), newest first, optional `startDate`.
 * - The key is personal: it belongs to one Garmin account and one Fit user,
 *   and is only ever sent to Garmin from the server.
 *
 * Nothing here logs request or response bodies or the key. Errors carry
 * only the HTTP status.
 */
export class GarminAdapter implements ProviderAdapter {
  readonly provider = 'garmin' as const;
  readonly syncMode = 'pull' as const;
  readonly authKind = 'api_key' as const;
  readonly usesPkce = false;
  readonly requiredScopes: string[] = [];
  /** No server-side credentials are needed: every user brings their own key */
  readonly configured = true;
  private readonly config: GarminConfig;
  private readonly timeoutMs: number;

  constructor(
    appConfig: AppConfig,
    private readonly fetchImpl: typeof fetch,
  ) {
    this.config = appConfig.garmin;
    this.timeoutMs = appConfig.sync.requestTimeoutMs;
  }

  assertConfigured(): void {
    // Nothing to configure server-side
  }

  authorizationUrl(): string {
    throw new ValidationError('Garmin does not use an OAuth flow. Use connect_garmin to supply your personal API key');
  }

  exchangeCode(): never {
    throw new ValidationError('Garmin does not use an OAuth flow. Use connect_garmin to supply your personal API key');
  }

  refresh(): never {
    throw new ValidationError('Garmin tokens are obtained from the personal API key, not refreshed');
  }

  /** Garmin has no API to revoke a key: the user deletes it in Garmin Connect. Fit just forgets it */
  async revoke(): Promise<void> {
    // Intentionally empty
  }

  normalize(raw: unknown): NormalizedActivity {
    return mapGarminActivity(raw);
  }

  /**
   * Exchanges the personal API key for a bearer token. Rejected keys (wrong,
   * deleted or expired) raise ProviderAuthError; rate limits and outages raise
   * the usual retryable upstream errors.
   */
  async obtainToken(apiKey: string): Promise<TokenGrant> {
    const response = await providerRequest(this.fetchImpl, 'Garmin', `${this.config.apiBaseUrl}${GARMIN_TOKEN_PATH}`, {
      method: 'POST',
      headers: { Authorization: `ApiKey ${apiKey}`, Accept: '*/*' },
      timeoutMs: this.timeoutMs,
    });
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new ProviderAuthError('garmin', 'Garmin rejected the personal API key (wrong, deleted or expired)');
    }
    const accessToken = response.text.trim();
    if (response.status !== 200 || !accessToken) throw new UpstreamError(`Garmin token endpoint answered HTTP ${response.status}`);
    return { accessToken, refreshToken: null, accessTokenExpiresAt: jwtExpiry(accessToken), refreshTokenExpiresAt: null, scopes: null };
  }

  /** One page of the user's activities, newest first */
  async listPage(accessToken: string, query: GarminListQuery): Promise<unknown[]> {
    const url = new URL(`${this.config.apiBaseUrl}${GARMIN_ACTIVITY_SEARCH_PATH}`);
    url.searchParams.set('start', String(query.start));
    url.searchParams.set('limit', String(query.limit));
    if (query.startDate) url.searchParams.set('startDate', query.startDate);
    const response = await providerRequest(this.fetchImpl, 'Garmin', url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      timeoutMs: this.timeoutMs,
    });
    if (response.status === 401 || response.status === 403) throw new ProviderAuthError('garmin', 'Garmin rejected the access token');
    if (response.status !== 200) throw new UpstreamError(`Garmin activity list answered HTTP ${response.status}`);
    return activityItems(response.body);
  }
}

/** The list is a JSON array; tolerate it wrapped in an object (`activities` / `activityList`) */
function activityItems(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (typeof body === 'object' && body !== null) {
    const wrapped = (body as Record<string, unknown>).activities ?? (body as Record<string, unknown>).activityList;
    if (Array.isArray(wrapped)) return wrapped;
  }
  if (body === null) return [];
  throw new UpstreamError('Garmin activity list had an unexpected shape');
}

/** Expiry from the JWT's `exp` claim (signature is not verified; it is only used to know when to ask for a new token) */
export function jwtExpiry(token: string): Date | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? new Date(payload.exp * 1000) : null;
  } catch {
    return null;
  }
}
