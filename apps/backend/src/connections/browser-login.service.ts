import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ResourceServer } from '@taico/auth';
import { OAuthClient } from '@taico/auth/client';
import { RESOURCE_SERVER } from '../auth/auth.setup';
import { safeEqual, sha256 } from '../common/secrets';
import { APP_CONFIG, type AppConfig } from '../config/env.config';
import { TokenVault } from './token-vault';

export const AUTH_FETCH = Symbol('AUTH_FETCH');

export const LOGIN_COOKIE = 'fit_garmin_login';
export const SESSION_COOKIE = 'fit_garmin_session';

const LOGIN_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 15 * 60_000;

type LoginCookie = { state: string; verifier: string; link: string; clientId: string; exp: number };
type SessionCookie = { linkHash: string; issuer: string; subject: string; exp: number };

/** The identity Taico vouched for in the browser: who is really sitting at the page */
export type BrowserIdentity = { issuer: string; subject: string };

/**
 * Browser sign-in for the Garmin key page. Fit has no logins of its own, so the
 * page is an OAuth client of Taico (authorization code + PKCE): the browser
 * is sent to Taico, comes back with a code, and the access token it yields is
 * verified exactly like an MCP token (signature, `iss`, audience). Only that
 * token's `(iss, sub)` counts as the identity; the link only says which Fit
 * account the key is meant for.
 *
 * State lives in short-lived, AES-GCM encrypted, HttpOnly cookies instead of
 * server memory, so it works behind several pods. That includes the dynamically
 * registered client_id: an authorization code is bound to the client it was
 * issued to, so the callback pod rebuilds that exact client from the cookie
 * rather than registering a new one. The Taico token is used once
 * to read the identity and discarded; Fit never stores it.
 */
@Injectable()
export class BrowserLoginService {
  private readonly logger = new Logger('BrowserLogin');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RESOURCE_SERVER) private readonly resourceServer: ResourceServer,
    @Inject(AUTH_FETCH) private readonly authFetch: typeof fetch,
    private readonly vault: TokenVault,
  ) {}

  get redirectUri(): string {
    return `${this.config.publicBaseUrl}/connect/garmin/auth`;
  }

  get secureCookies(): boolean {
    return this.config.publicBaseUrl.startsWith('https://');
  }

  private newClient(clientId?: string): OAuthClient {
    return new OAuthClient({
      issuer: this.config.auth.authorizationServers[0] ?? this.config.auth.issuer,
      fetch: this.authFetch,
      ...(clientId ? { clientId } : {}),
    });
  }

  /** Where to send the browser to sign in, plus the encrypted cookie that proves the callback belongs to this attempt */
  async begin(link: string): Promise<{ url: string; cookie: string; maxAgeMs: number }> {
    const client = this.newClient();
    const clientId = await client.register({ clientName: 'Fit (Garmin connection page)', redirectUris: [this.redirectUri] });
    const request = await client.createAuthorizationRequest({ redirectUri: this.redirectUri, resource: this.config.auth.mcpResourceUrl });
    const payload: LoginCookie = { state: request.state, verifier: request.codeVerifier, link, clientId, exp: Date.now() + LOGIN_TTL_MS };
    return { url: request.url, cookie: this.seal(LOGIN_COOKIE, payload), maxAgeMs: LOGIN_TTL_MS };
  }

  /**
   * Completes the sign-in: checks `state` against the cookie, redeems the code,
   * verifies the access token and returns the verified identity plus the
   * encrypted session cookie. Null when anything does not check out.
   */
  async complete(
    loginCookie: string | undefined,
    query: { code?: string; state?: string },
  ): Promise<{ identity: BrowserIdentity; link: string; sessionCookie: string; maxAgeMs: number } | null> {
    const login = this.open<LoginCookie>(LOGIN_COOKIE, loginCookie);
    if (!login || !query.code || !query.state || !safeEqual(query.state, login.state)) return null;
    try {
      const client = this.newClient(login.clientId);
      const tokens = await client.exchangeCode({
        code: query.code,
        codeVerifier: login.verifier,
        redirectUri: this.redirectUri,
        resource: this.config.auth.mcpResourceUrl,
      });
      const auth = await this.resourceServer.authenticateToken(tokens.accessToken, this.config.auth.mcpResourceUrl);
      const issuer = auth.claims.iss;
      if (!issuer || !auth.subject) return null;
      const identity = { issuer, subject: auth.subject };
      const session: SessionCookie = { linkHash: sha256(login.link), ...identity, exp: Date.now() + SESSION_TTL_MS };
      return { identity, link: login.link, sessionCookie: this.seal(SESSION_COOKIE, session), maxAgeMs: SESSION_TTL_MS };
    } catch (error) {
      this.logger.warn(`Browser sign-in failed: ${(error as Error).constructor.name}`);
      return null;
    }
  }

  /** The identity signed in for exactly this link, from the session cookie; null when absent, expired or for another link */
  session(sessionCookie: string | undefined, link: string): BrowserIdentity | null {
    const session = this.open<SessionCookie>(SESSION_COOKIE, sessionCookie);
    if (!session || !safeEqual(session.linkHash, sha256(link))) return null;
    return { issuer: session.issuer, subject: session.subject };
  }

  private seal(name: string, payload: object): string {
    return this.vault.encrypt(JSON.stringify(payload), name);
  }

  private open<T extends { exp: number }>(name: string, value: string | undefined): T | null {
    if (!value) return null;
    const plain = this.vault.tryDecrypt(value, name);
    if (!plain) return null;
    try {
      const payload = JSON.parse(plain) as T;
      return payload.exp > Date.now() ? payload : null;
    } catch {
      return null;
    }
  }
}

/** Reads one cookie from a Cookie header */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}
