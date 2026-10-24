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
 * `pull` providers (Strava) are synced by listing activities. `push`
 * providers (Garmin) deliver activities by webhook; a sync asks them to
 * re-send history instead.
 */
export interface ProviderAdapter {
  readonly provider: Provider;
  readonly syncMode: 'pull' | 'push';
  /** Credentials are configured on this server */
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
  /** push providers: asks the provider to push activities that started in [after, before) */
  requestBackfill?(accessToken: string, input: { after: Date; before: Date }): Promise<void>;
}

export const PROVIDER_ADAPTERS = Symbol('PROVIDER_ADAPTERS');
