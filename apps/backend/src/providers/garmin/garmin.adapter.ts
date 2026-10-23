import { mapGarminActivity, type NormalizedActivity } from '@fit/activity-model';
import { Logger } from '@nestjs/common';
import { NotConfiguredError, UpstreamError } from '../../common/errors';
import type { AppConfig, GarminConfig } from '../../config/env.config';
import { ProviderAuthError, expiresIn, formBody, providerRequest } from '../http';
import type { ProviderAccount, ProviderAdapter, TokenGrant } from '../provider.port';

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Garmin caps one backfill request's window; longer ranges are requested in chunks */
export const GARMIN_BACKFILL_CHUNK_DAYS = 30;

/**
 * Garmin Connect Developer Program, Activity API (OAuth 2.0 with PKCE, Push
 * or Ping/Pull delivery). Access to this API is approval-based and requires
 * a Garmin developer-program account: see docs/providers/garmin.md for the
 * exact prerequisites. There is no pull-on-demand listing; activities arrive
 * by webhook, and history arrives by webhook after a backfill request.
 *
 * Endpoint paths follow Garmin's published OAuth2 PKCE and Activity API
 * specifications; every URL is configurable in case Garmin moves them.
 */
export class GarminAdapter implements ProviderAdapter {
  readonly provider = 'garmin' as const;
  readonly syncMode = 'push' as const;
  readonly usesPkce = true;
  readonly requiredScopes = ['ACTIVITY_EXPORT'];
  private readonly config: GarminConfig;
  private readonly timeoutMs: number;
  private readonly logger = new Logger('GarminAdapter');

  constructor(
    appConfig: AppConfig,
    private readonly fetchImpl: typeof fetch,
  ) {
    this.config = appConfig.garmin;
    this.timeoutMs = appConfig.sync.requestTimeoutMs;
  }

  get configured(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  /** Host that Ping notification callback URLs must point to */
  get apiHost(): string {
    return new URL(this.config.apiBaseUrl).host;
  }

  authorizationUrl({ state, codeChallenge }: { state: string; codeChallenge: string | null }): string {
    if (!codeChallenge) throw new Error('Garmin requires PKCE');
    const url = new URL(this.config.authorizeUrl);
    url.search = new URLSearchParams({
      client_id: this.credentials().clientId,
      response_type: 'code',
      redirect_uri: this.config.redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  async exchangeCode({ code, codeVerifier }: { code: string; codeVerifier: string | null }): Promise<{ grant: TokenGrant; account: ProviderAccount }> {
    if (!codeVerifier) throw new Error('Garmin requires PKCE');
    const grant = await this.token({ grant_type: 'authorization_code', code, code_verifier: codeVerifier, redirect_uri: this.config.redirectUri });
    const idResponse = await this.api(grant.accessToken, `${this.config.apiBaseUrl}/wellness-api/rest/user/id`);
    const userId = isObj(idResponse.body) && typeof idResponse.body.userId === 'string' ? idResponse.body.userId : null;
    if (idResponse.status !== 200 || !userId) throw new UpstreamError(`Garmin user ID lookup answered HTTP ${idResponse.status}`);
    // The token's OAuth scopes are coarse; the per-user data permissions (ACTIVITY_EXPORT, ...) come from this endpoint
    const scopes = (await this.permissions(grant.accessToken)) ?? grant.scopes;
    return { grant: { ...grant, scopes }, account: { externalUserId: userId, displayName: null } };
  }

  async refresh(refreshToken: string): Promise<TokenGrant> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  /** Deregisters the user from Fit's Garmin app, which stops pushes */
  async revoke(accessToken: string): Promise<void> {
    try {
      await providerRequest(this.fetchImpl, 'Garmin', `${this.config.apiBaseUrl}/wellness-api/rest/user/registration`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
        timeoutMs: this.timeoutMs,
      });
    } catch (error) {
      this.logger.warn(`Garmin deregistration failed: ${(error as Error).message}`);
    }
  }

  normalize(raw: unknown): NormalizedActivity {
    return mapGarminActivity(raw);
  }

  /** Asks Garmin to push activity summaries for [after, before), in chunks Garmin accepts. 409 = already requested */
  async requestBackfill(accessToken: string, input: { after: Date; before: Date }): Promise<void> {
    const chunk = GARMIN_BACKFILL_CHUNK_DAYS * 86_400;
    const end = Math.floor(input.before.getTime() / 1000);
    for (let start = Math.floor(input.after.getTime() / 1000); start < end; start += chunk) {
      const url = new URL(`${this.config.apiBaseUrl}/wellness-api/rest/backfill/activities`);
      url.search = new URLSearchParams({ summaryStartTimeInSeconds: String(start), summaryEndTimeInSeconds: String(Math.min(start + chunk, end)) }).toString();
      const response = await this.api(accessToken, url.toString());
      if (response.status !== 202 && response.status !== 200 && response.status !== 409) {
        throw new UpstreamError(`Garmin backfill request answered HTTP ${response.status}`);
      }
    }
  }

  /**
   * Ping/Pull: fetches the activity summaries a Ping notification points to.
   * Only URLs on Garmin's API host are followed, so a forged ping cannot make
   * Fit send a user's token elsewhere.
   */
  async fetchCallback(accessToken: string, callbackUrl: string): Promise<unknown[]> {
    let url: URL;
    try {
      url = new URL(callbackUrl);
    } catch {
      throw new UpstreamError('Garmin ping callback URL is not a URL');
    }
    const expected = new URL(this.config.apiBaseUrl);
    if (url.protocol !== expected.protocol || url.host !== expected.host) throw new UpstreamError('Garmin ping callback URL is not on the Garmin API host');
    const response = await this.api(accessToken, url.toString());
    if (response.status !== 200 || !Array.isArray(response.body)) throw new UpstreamError(`Garmin ping callback answered HTTP ${response.status}`);
    return response.body;
  }

  private async permissions(accessToken: string): Promise<string[] | null> {
    const response = await this.api(accessToken, `${this.config.apiBaseUrl}/wellness-api/rest/user/permissions`);
    return response.status === 200 && Array.isArray(response.body) ? response.body.filter((p): p is string => typeof p === 'string') : null;
  }

  private async api(accessToken: string, url: string) {
    const response = await providerRequest(this.fetchImpl, 'Garmin', url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      timeoutMs: this.timeoutMs,
    });
    if (response.status === 401) throw new ProviderAuthError('garmin', 'Garmin rejected the access token');
    return response;
  }

  private async token(params: Record<string, string>): Promise<TokenGrant> {
    const { clientId, clientSecret } = this.credentials();
    const response = await providerRequest(this.fetchImpl, 'Garmin', this.config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: formBody({ client_id: clientId, client_secret: clientSecret, ...params }),
      timeoutMs: this.timeoutMs,
    });
    if (response.status === 400 || response.status === 401) throw new ProviderAuthError('garmin', 'Garmin refused the authorization grant');
    const body = response.body;
    if (response.status !== 200 || !isObj(body) || typeof body.access_token !== 'string') throw new UpstreamError(`Garmin token endpoint answered HTTP ${response.status}`);
    return {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
      accessTokenExpiresAt: expiresIn(body.expires_in),
      refreshTokenExpiresAt: expiresIn(body.refresh_token_expires_in),
      scopes: typeof body.scope === 'string' ? body.scope.split(/[\s,]+/).filter(Boolean) : null,
    };
  }

  assertConfigured(): void {
    this.credentials();
  }

  private credentials(): { clientId: string; clientSecret: string } {
    if (!this.config.clientId || !this.config.clientSecret) {
      throw new NotConfiguredError(
        'Garmin is not configured on this server. It needs an approved Garmin Connect Developer Program app (GARMIN_CLIENT_ID, GARMIN_CLIENT_SECRET); see docs/providers/garmin.md',
      );
    }
    return { clientId: this.config.clientId, clientSecret: this.config.clientSecret };
  }
}
