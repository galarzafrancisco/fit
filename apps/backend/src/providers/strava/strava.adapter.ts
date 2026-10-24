import { mapStravaActivity, type NormalizedActivity } from '@fit/activity-model';
import { Logger } from '@nestjs/common';
import { NotConfiguredError, UpstreamError } from '../../common/errors';
import type { AppConfig, StravaConfig } from '../../config/env.config';
import { ProviderAuthError, formBody, providerRequest } from '../http';
import type { ActivityPage, ProviderAccount, ProviderAdapter, TokenGrant } from '../provider.port';

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Strava API v3 (https://developers.strava.com/docs/). OAuth 2.0 authorization
 * code flow; access tokens last 6 hours and refresh tokens may rotate.
 * Activities are pulled with GET /athlete/activities and re-read on webhook
 * events with GET /activities/{id}.
 */
export class StravaAdapter implements ProviderAdapter {
  readonly provider = 'strava' as const;
  readonly syncMode = 'pull' as const;
  readonly authKind = 'oauth' as const;
  readonly usesPkce = false;
  /** activity:read_all also covers "Only You" activities; activity:read alone is accepted too */
  readonly requiredScopes = ['activity:read'];
  private readonly config: StravaConfig;
  private readonly timeoutMs: number;
  private readonly logger = new Logger('StravaAdapter');

  constructor(
    appConfig: AppConfig,
    private readonly fetchImpl: typeof fetch,
  ) {
    this.config = appConfig.strava;
    this.timeoutMs = appConfig.sync.requestTimeoutMs;
  }

  get configured(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  authorizationUrl({ state }: { state: string }): string {
    const url = new URL(`${this.config.oauthBaseUrl}/authorize`);
    url.search = new URLSearchParams({
      client_id: this.credentials().clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      approval_prompt: 'auto',
      scope: this.config.scopes.join(','),
      state,
    }).toString();
    return url.toString();
  }

  async exchangeCode({ code, grantedScopes }: { code: string; grantedScopes: string[] | null }): Promise<{ grant: TokenGrant; account: ProviderAccount }> {
    const body = await this.token({ grant_type: 'authorization_code', code });
    const athlete = isObj(body.athlete) ? body.athlete : null;
    const athleteId = athlete && (typeof athlete.id === 'number' || typeof athlete.id === 'string') ? String(athlete.id) : null;
    if (!athleteId) throw new UpstreamError('Strava token response has no athlete');
    const name = [athlete?.firstname, athlete?.lastname].filter((part) => typeof part === 'string' && part.trim()).join(' ');
    return {
      grant: { ...this.grantFrom(body), scopes: grantedScopes },
      account: { externalUserId: athleteId, displayName: name || (typeof athlete?.username === 'string' ? athlete.username : null) },
    };
  }

  async refresh(refreshToken: string): Promise<TokenGrant> {
    return { ...this.grantFrom(await this.token({ grant_type: 'refresh_token', refresh_token: refreshToken })), scopes: null };
  }

  async revoke(accessToken: string): Promise<void> {
    try {
      await providerRequest(this.fetchImpl, 'Strava', `${this.config.oauthBaseUrl}/deauthorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({ access_token: accessToken }),
        timeoutMs: this.timeoutMs,
      });
    } catch (error) {
      this.logger.warn(`Strava deauthorize failed: ${(error as Error).message}`);
    }
  }

  normalize(raw: unknown): NormalizedActivity {
    return mapStravaActivity(raw);
  }

  async listActivities(accessToken: string, input: { after: Date; before: Date; page: number; pageSize: number }): Promise<ActivityPage> {
    const url = new URL(`${this.config.apiBaseUrl}/athlete/activities`);
    url.search = new URLSearchParams({
      after: String(Math.floor(input.after.getTime() / 1000)),
      before: String(Math.ceil(input.before.getTime() / 1000)),
      page: String(input.page),
      per_page: String(input.pageSize),
    }).toString();
    const response = await this.api(accessToken, url.toString());
    if (response.status !== 200 || !Array.isArray(response.body)) throw new UpstreamError(`Strava activity list answered HTTP ${response.status}`);
    return { items: response.body, hasMore: response.body.length >= input.pageSize };
  }

  async fetchActivity(accessToken: string, providerActivityId: string): Promise<unknown | null> {
    if (!/^\d{1,20}$/.test(providerActivityId)) return null;
    const response = await this.api(accessToken, `${this.config.apiBaseUrl}/activities/${providerActivityId}`);
    // 404: deleted. 403: no longer visible to this grant (e.g. made private without activity:read_all)
    if (response.status === 404 || response.status === 403) return null;
    if (response.status !== 200 || !isObj(response.body)) throw new UpstreamError(`Strava activity answered HTTP ${response.status}`);
    return response.body;
  }

  private async api(accessToken: string, url: string) {
    const response = await providerRequest(this.fetchImpl, 'Strava', url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      timeoutMs: this.timeoutMs,
    });
    if (response.status === 401) throw new ProviderAuthError('strava', 'Strava rejected the access token');
    return response;
  }

  private async token(params: Record<string, string>): Promise<Obj> {
    const { clientId, clientSecret } = this.credentials();
    const response = await providerRequest(this.fetchImpl, 'Strava', `${this.config.oauthBaseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: formBody({ client_id: clientId, client_secret: clientSecret, ...params }),
      timeoutMs: this.timeoutMs,
    });
    if (response.status === 400 || response.status === 401) throw new ProviderAuthError('strava', 'Strava refused the authorization grant');
    if (response.status !== 200 || !isObj(response.body) || typeof response.body.access_token !== 'string') {
      throw new UpstreamError(`Strava token endpoint answered HTTP ${response.status}`);
    }
    return response.body;
  }

  private grantFrom(body: Obj): Omit<TokenGrant, 'scopes'> {
    const expiresAt = typeof body.expires_at === 'number' ? new Date(body.expires_at * 1000) : null;
    return {
      accessToken: body.access_token as string,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
      accessTokenExpiresAt: expiresAt,
      refreshTokenExpiresAt: null,
    };
  }

  assertConfigured(): void {
    this.credentials();
  }

  private credentials(): { clientId: string; clientSecret: string } {
    if (!this.config.clientId || !this.config.clientSecret) {
      throw new NotConfiguredError('Strava is not configured on this server (set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET, see docs/providers/strava.md)');
    }
    return { clientId: this.config.clientId, clientSecret: this.config.clientSecret };
  }
}
