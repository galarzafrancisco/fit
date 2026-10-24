import type { NormalizedActivity, Provider } from '@fit/activity-model';

/** Tokens returned by a provider's token endpoint */
export type TokenGrant = {
  accessToken: string;
  /** Some providers rotate refresh tokens on every refresh; always store the latest */
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  /** Scopes the user actually granted, when the provider says */
  scopes: string[] | null;
};

/** The provider account a grant belongs to */
export type ProviderAccount = {
  externalUserId: string;
  displayName: string | null;
};

export type ActivityPage = {
  items: unknown[];
  /** True when there may be more pages */
  hasMore: boolean;
};

/**
 * What Fit needs from a fitness provider. Each provider has one adapter
 * (providers/<name>/<name>.adapter.ts) that owns its URLs, payload shapes
 * and quirks; nothing outside the adapter knows a provider's API.
 *
 * Both providers are synced by listing activities (`pull`). Strava also
 * pushes events by webhook. Garmin's Personal API has no OAuth and no push:
 * a user-supplied API key is exchanged for a short-lived token and the
 * activity list is polled (`authKind: 'api_key'`).
 */
export interface ProviderAdapter {
  readonly provider: Provider;
  readonly syncMode: 'pull';
  /** oauth: the user approves Fit in a browser. api_key: the user supplies a personal API key (Garmin Personal API) */
  readonly authKind: 'oauth' | 'api_key';
  /** The provider can be used on this server (Strava needs client credentials; Garmin needs none) */
  readonly configured: boolean;
  /** PKCE (S256) is used in the authorization request */
  readonly usesPkce: boolean;
  /** Scopes the user must grant for Fit to read activities; a connection missing them is refused */
  readonly requiredScopes: string[];

  /** Throws NotConfiguredError (naming the missing variables) when credentials are not set */
  assertConfigured(): void;
  authorizationUrl(input: { state: string; codeChallenge: string | null }): string;
  /** Exchanges an authorization code. `grantedScopes` is the scope list from the callback query, when the provider sends one */
  exchangeCode(input: { code: string; codeVerifier: string | null; grantedScopes: string[] | null }): Promise<{ grant: TokenGrant; account: ProviderAccount }>;
  refresh(refreshToken: string): Promise<TokenGrant>;
  /** Best effort: tells the provider to drop Fit's grant. Errors are logged, never thrown to the user */
  revoke(accessToken: string): Promise<void>;
  normalize(raw: unknown): NormalizedActivity;

  /** pull providers: one page of activities that started in [after, before) */
  listActivities?(accessToken: string, input: { after: Date; before: Date; page: number; pageSize: number }): Promise<ActivityPage>;
  /** pull providers: the current state of one activity, or null when it no longer exists or is no longer visible */
  fetchActivity?(accessToken: string, providerActivityId: string): Promise<unknown | null>;
}

export const PROVIDER_ADAPTERS = Symbol('PROVIDER_ADAPTERS');
