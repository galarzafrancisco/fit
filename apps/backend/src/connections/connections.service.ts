import { isProvider, type Provider } from '@fit/activity-model';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ConflictError, NotFoundError, ReauthorizationRequiredError, ValidationError } from '../common/errors';
import { randomSecret, sha256 } from '../common/secrets';
import { parseInput } from '../common/validation';
import { APP_CONFIG, type AppConfig } from '../config/env.config';
import { UnitOfWork } from '../database/unit-of-work';
import { ProviderAuthError } from '../providers/http';
import { ProviderRegistry } from '../providers/provider-registry';
import type { TokenGrant } from '../providers/provider.port';
import { UsersRepository } from '../users/users.repository';
import type { CurrentUser } from '../users/users.service';
import { OAuthStateEntity, ProviderConnectionEntity } from './connection.entities';
import { ConnectionsRepository } from './connections.repository';
import { TokenVault } from './token-vault';

export const providerSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(isProvider, { message: 'must be "strava" or "garmin"' })
  .transform((value) => value as Provider)
  .describe('Fitness provider: "strava" or "garmin"');

export const disconnectShape = {
  provider: providerSchema,
  deleteActivities: z.boolean().optional().describe('Also delete every activity imported from this provider (default false: they are kept)'),
};
const disconnectSchema = z.object(disconnectShape);

/** A refresh is done this long before the access token expires */
const REFRESH_MARGIN_MS = 120_000;

export type ConnectionView = {
  provider: Provider;
  /** Credentials for this provider are configured on the server */
  available: boolean;
  /** "pull": Fit lists activities; "push": the provider sends them by webhook */
  syncMode: 'pull';
  /** "oauth": approved in a browser (Strava). "api_key": the user's own personal API key (Garmin Personal API) */
  authMethod: 'oauth' | 'api_key';
  connected: boolean;
  status: ProviderConnectionEntity['status'] | 'not_connected';
  externalUserId: string | null;
  displayName: string | null;
  scopes: string[];
  connectedAt: string | null;
  lastSyncAt: string | null;
  syncCursor: string | null;
  /** Garmin: progress of the newest-first history import */
  history: { complete: boolean; activitiesWalked: number } | null;
  /** Garmin: when the next scheduled poll is due, and any rate-limit/error backoff in effect */
  nextSyncAt: string | null;
  backoffUntil: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  activityCount: number;
};

/** A problem during the OAuth callback, shown to the user on the callback page */
export class ConnectCallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectCallbackError';
  }
}

@Injectable()
export class ConnectionsService {
  private readonly logger = new Logger('ConnectionsService');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly repo: ConnectionsRepository,
    private readonly registry: ProviderRegistry,
    private readonly vault: TokenVault,
    private readonly uow: UnitOfWork,
    private readonly users: UsersRepository,
  ) {}

  async list(user: CurrentUser): Promise<ConnectionView[]> {
    const [connections, counts] = await Promise.all([this.repo.listForUser(user.id), this.repo.activityCounts(user.id)]);
    return this.registry.all().map((adapter) => {
      const connection = connections.find((c) => c.provider === adapter.provider) ?? null;
      return toView(adapter.provider, adapter.configured, adapter.syncMode, adapter.authKind, connection, counts.get(adapter.provider) ?? 0);
    });
  }

  async get(user: CurrentUser, providerInput: unknown): Promise<ConnectionView> {
    const provider = parseInput(providerSchema, providerInput);
    return (await this.list(user)).find((view) => view.provider === provider)!;
  }

  /**
   * Starts connecting a provider: returns the URL the user opens in a browser
   * to approve access. The state is random, stored hashed, single-use and
   * short-lived; for PKCE providers the verifier is stored encrypted.
   */
  async startConnect(
    user: CurrentUser,
    providerInput: unknown,
  ): Promise<{ provider: Provider; authorizationUrl: string; expiresAt: string; instructions: string }> {
    const provider = parseInput(providerSchema, providerInput);
    const adapter = this.registry.get(provider);
    if (adapter.authKind !== 'oauth') throw new ValidationError(`${capitalize(provider)} uses a personal API key, not an OAuth approval. Use connect_garmin`);
    // Throws not_configured, naming the variables and docs, when credentials are missing
    adapter.assertConfigured();
    await this.repo.purgeExpiredStates();
    const state = randomSecret(32);
    const stateRow = Object.assign(new OAuthStateEntity(), {
      id: randomUUID(),
      stateHash: sha256(state),
      userId: user.id,
      provider,
      codeVerifierEnc: null as string | null,
      expiresAt: new Date(Date.now() + this.config.oauth.stateTtlSeconds * 1000),
    });
    let codeChallenge: string | null = null;
    if (adapter.usesPkce) {
      const verifier = randomSecret(48);
      codeChallenge = createHash('sha256').update(verifier).digest('base64url');
      stateRow.codeVerifierEnc = this.vault.encrypt(verifier, stateRow.id);
    }
    const authorizationUrl = adapter.authorizationUrl({ state, codeChallenge });
    await this.repo.insertState(stateRow);
    return {
      provider,
      authorizationUrl,
      expiresAt: stateRow.expiresAt.toISOString(),
      instructions: `Open authorizationUrl in a browser signed in to ${provider} and approve access. The link works once and expires at expiresAt. Fit then imports your activities automatically.`,
    };
  }

  /**
   * The OAuth callback. Consumes the state, exchanges the code and stores the
   * connection. Throws ConnectCallbackError with a message for the user.
   */
  async completeConnect(input: {
    provider: string;
    state?: string;
    code?: string;
    error?: string;
    scope?: string;
  }): Promise<{ connection: ProviderConnectionEntity; userId: string }> {
    if (!isProvider(input.provider)) throw new ConnectCallbackError('Unknown provider.');
    const provider = input.provider;
    const adapter = this.registry.get(provider);
    if (adapter.authKind !== 'oauth') throw new ConnectCallbackError(`${capitalize(provider)} does not use this sign-in flow.`);
    if (!input.state || input.state.length > 200)
      throw new ConnectCallbackError('The sign-in link is missing its state. Start connecting again from your AI assistant.');
    const state = await this.repo.consumeState(sha256(input.state));
    if (!state || state.provider !== provider) throw new ConnectCallbackError('This sign-in link is invalid or was already used. Start connecting again.');
    if (state.expiresAt.getTime() < Date.now()) throw new ConnectCallbackError('This sign-in link has expired. Start connecting again.');
    if (input.error) throw new ConnectCallbackError(`${capitalize(provider)} did not grant access (${input.error.slice(0, 100)}).`);
    if (!input.code || input.code.length > 2048) throw new ConnectCallbackError(`${capitalize(provider)} did not return an authorization code.`);

    const codeVerifier = adapter.usesPkce ? this.vault.tryDecrypt(state.codeVerifierEnc, state.id) : null;
    if (adapter.usesPkce && !codeVerifier) throw new ConnectCallbackError('This sign-in link can no longer be completed. Start connecting again.');
    const grantedScopes = input.scope ? input.scope.split(/[\s,]+/).filter(Boolean) : null;

    let exchanged;
    try {
      exchanged = await adapter.exchangeCode({ code: input.code, codeVerifier, grantedScopes });
    } catch (error) {
      if (error instanceof ProviderAuthError) throw new ConnectCallbackError(`${capitalize(provider)} refused the authorization code. Start connecting again.`);
      throw error;
    }
    const { grant, account } = exchanged;
    const scopes = grant.scopes ?? [];
    if (grant.scopes && !adapter.requiredScopes.some((required) => scopes.some((s) => s === required || s.startsWith(`${required}_`)))) {
      await adapter.revoke(grant.accessToken);
      throw new ConnectCallbackError(
        `Fit needs permission to read your activities (${adapter.requiredScopes.join(', ')}). Connect again and keep that permission selected.`,
      );
    }

    const connection = await this.uow
      .run(async (manager) => {
        const owner = await this.repo.findByExternal(provider, account.externalUserId, manager);
        if (owner && owner.userId !== state.userId) {
          if (owner.status === 'active' || owner.status === 'needs_reauth') {
            throw new ConflictError(`This ${capitalize(provider)} account is already connected to another Fit user.`);
          }
          // A stale, inactive link from another Fit user: the provider account now belongs to this user
          await this.repo.delete(owner.id, manager);
        }
        let row = await this.repo.findForUser(state.userId, provider, manager);
        if (row && row.externalUserId !== account.externalUserId) {
          // The user switched to a different provider account: start a fresh connection, keep old activities
          await this.repo.delete(row.id, manager);
          row = null;
        }
        const now = new Date();
        const connection =
          row ??
          Object.assign(new ProviderConnectionEntity(), {
            id: randomUUID(),
            userId: state.userId,
            provider,
            externalUserId: account.externalUserId,
            syncCursor: null,
            lastSyncAt: null,
          });
        Object.assign(connection, {
          displayName: account.displayName ?? connection.displayName ?? null,
          scopes,
          status: 'active' as const,
          connectedAt: now,
          lastError: null,
          lastErrorAt: null,
        });
        this.applyGrant(connection, grant);
        return this.repo.save(connection, manager);
      })
      .catch((error) => {
        if (error instanceof ConflictError) throw new ConnectCallbackError(error.message);
        throw error;
      });
    this.logger.log(`Connected ${provider} account ${account.externalUserId} for user ${state.userId}`);
    return { connection, userId: state.userId };
  }

  /**
   * Garmin Personal API: creates the single-use link the authenticated user
   * opens to enter their own API key. The link is created here, behind the
   * MCP/REST bearer-token check, so the token identifies the Fit user
   * (issuer + subject) server-side; no user ID travels in the URL. Only the
   * SHA-256 of the link token is stored.
   */
  async startGarminLink(user: CurrentUser): Promise<{ provider: 'garmin'; connectUrl: string; expiresAt: string; instructions: string }> {
    await this.repo.purgeExpiredStates();
    const token = randomSecret(32);
    const row = Object.assign(new OAuthStateEntity(), {
      id: randomUUID(),
      stateHash: sha256(token),
      userId: user.id,
      provider: 'garmin' as const,
      codeVerifierEnc: null as string | null,
      expiresAt: new Date(Date.now() + this.config.oauth.stateTtlSeconds * 1000),
    });
    await this.repo.insertState(row);
    const url = new URL(`${this.config.publicBaseUrl}/connect/garmin`);
    url.searchParams.set('link', token);
    return {
      provider: 'garmin',
      connectUrl: url.toString(),
      expiresAt: row.expiresAt.toISOString(),
      instructions:
        'Open connectUrl in a browser and paste your own Garmin Connect Personal API key (create it in Garmin Connect on the web, under Account > Personal API Key; it is shown only once). The key goes straight to this server over HTTPS, is stored encrypted and is never shown again. The link works once and expires at expiresAt. Never paste the key into this chat.',
    };
  }

  /** What the key page shows before submission: whose account the link is for. Null when invalid or expired */
  async previewGarminLink(link: string | undefined): Promise<{ label: string } | null> {
    if (!link || link.length > 200) return null;
    const state = await this.repo.findState(sha256(link));
    if (!state || state.provider !== 'garmin' || state.expiresAt.getTime() < Date.now()) return null;
    const user = await this.users.findById(state.userId);
    return user ? { label: user.displayName ?? user.email ?? user.subject } : null;
  }

  /**
   * Consumes the link, validates the key against Garmin (token exchange plus
   * one list call) and stores it encrypted for the link's user. The key is
   * never logged, echoed or returned.
   */
  async completeGarminKey(link: string | undefined, apiKey: string | undefined): Promise<{ connection: ProviderConnectionEntity; userId: string }> {
    if (!link || link.length > 200) throw new ConnectCallbackError('This link is missing. Ask your AI assistant for a new one with connect_garmin.');
    const state = await this.repo.consumeState(sha256(link));
    if (!state || state.provider !== 'garmin')
      throw new ConnectCallbackError('This link is invalid or was already used. Ask your AI assistant for a new one with connect_garmin.');
    if (state.expiresAt.getTime() < Date.now())
      throw new ConnectCallbackError('This link has expired. Ask your AI assistant for a new one with connect_garmin.');
    const key = apiKey?.trim();
    if (!key || key.length > 4096 || /\s/.test(key))
      throw new ConnectCallbackError('That does not look like a Garmin Personal API key. Ask for a new link with connect_garmin and try again.');

    const garmin = this.registry.garmin;
    let grant: TokenGrant;
    try {
      grant = await garmin.obtainToken(key);
      await garmin.listPage(grant.accessToken, { start: 0, limit: 1 });
    } catch (error) {
      if (error instanceof ProviderAuthError) {
        throw new ConnectCallbackError(
          'Garmin rejected that key (wrong, deleted or expired). Create a new key in Garmin Connect and ask for a new link with connect_garmin.',
        );
      }
      throw error;
    }

    // A personal key belongs to one person: the same key cannot be attached to two Fit users.
    // Only a one-way digest identifies it (a hash of a high-entropy secret; the key itself is encrypted).
    const keyId = `key-${sha256(key).slice(0, 32)}`;
    const connection = await this.uow
      .run(async (manager) => {
        const owner = await this.repo.findByExternal('garmin', keyId, manager);
        if (owner && owner.userId !== state.userId) {
          if (owner.status === 'active' || owner.status === 'needs_reauth')
            throw new ConflictError('This Garmin key is already connected to another Fit user. Personal API keys cannot be shared.');
          await this.repo.delete(owner.id, manager);
        }
        const existing = await this.repo.findForUser(state.userId, 'garmin', manager);
        const now = new Date();
        const row =
          existing ??
          Object.assign(new ProviderConnectionEntity(), {
            id: randomUUID(),
            userId: state.userId,
            provider: 'garmin' as const,
            syncCursor: null,
            lastSyncAt: null,
            historyOffset: 0,
            historyComplete: false,
            failureCount: 0,
          });
        Object.assign(row, {
          externalUserId: keyId,
          displayName: row.displayName ?? null,
          scopes: ['personal_api'],
          status: 'active' as const,
          connectedAt: now,
          lastError: null,
          lastErrorAt: null,
          nextSyncAt: null,
          backoffUntil: null,
          failureCount: 0,
          apiKeyEnc: this.vault.encrypt(key, row.id),
          refreshTokenEnc: null,
        });
        this.applyGrant(row, grant);
        return this.repo.save(row, manager);
      })
      .catch((error) => {
        if (error instanceof ConflictError) throw new ConnectCallbackError(error.message);
        throw error;
      });
    this.logger.log(`Garmin personal API key stored for user ${state.userId}`);
    return { connection, userId: state.userId };
  }

  async disconnect(user: CurrentUser, input: unknown): Promise<{ provider: Provider; status: 'disconnected'; deletedActivities: number }> {
    const { provider, deleteActivities } = parseInput(disconnectSchema, input);
    const connection = await this.repo.findForUser(user.id, provider);
    if (!connection) throw new NotFoundError(`${capitalize(provider)} is not connected`);
    const accessToken = this.vault.tryDecrypt(connection.accessTokenEnc, connection.id);
    if (accessToken) await this.registry.get(provider).revoke(accessToken);
    return this.uow.run(async (manager) => {
      const locked = await this.repo.lockById(connection.id, manager);
      if (!locked) throw new NotFoundError(`${capitalize(provider)} is not connected`);
      Object.assign(locked, {
        status: 'disconnected',
        accessTokenEnc: null,
        refreshTokenEnc: null,
        apiKeyEnc: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
      });
      await this.repo.save(locked, manager);
      let deletedActivities = 0;
      if (deleteActivities) {
        const result = await manager.query(`DELETE FROM activities WHERE user_id = $1 AND provider = $2`, [user.id, provider]);
        deletedActivities = Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
        // Imported again from scratch if the user reconnects
        Object.assign(locked, { historyOffset: 0, historyComplete: false, syncCursor: null });
        await this.repo.save(locked, manager);
      }
      return { provider, status: 'disconnected' as const, deletedActivities };
    });
  }

  /** The provider told us the user revoked access (Strava deauthorization, Garmin deregistration) */
  async markRevoked(connectionId: string, reason: string): Promise<void> {
    await this.uow.run(async (manager) => {
      const connection = await this.repo.lockById(connectionId, manager);
      if (!connection) return;
      Object.assign(connection, {
        status: 'revoked',
        accessTokenEnc: null,
        refreshTokenEnc: null,
        apiKeyEnc: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        lastError: reason,
        lastErrorAt: new Date(),
      });
      await this.repo.save(connection, manager);
    });
  }

  async recordOutcome(connectionId: string, outcome: { error: string | null; syncedAt?: Date; cursor?: Date | null; scopes?: string[] }): Promise<void> {
    const connection = await this.repo.findById(connectionId);
    if (!connection) return;
    if (outcome.syncedAt) connection.lastSyncAt = outcome.syncedAt;
    if (outcome.cursor && (!connection.syncCursor || outcome.cursor > connection.syncCursor)) connection.syncCursor = outcome.cursor;
    if (outcome.scopes) connection.scopes = outcome.scopes;
    connection.lastError = outcome.error;
    connection.lastErrorAt = outcome.error ? new Date() : connection.lastErrorAt;
    await this.repo.save(connection);
  }

  /**
   * A valid access token for an active connection, refreshing it when it is
   * about to expire. The refresh runs with the connection row locked, so two
   * concurrent callers never both spend a rotating refresh token.
   */
  async accessToken(connectionId: string): Promise<string> {
    const current = await this.repo.findById(connectionId);
    if (!current || current.status !== 'active') throw new ReauthorizationRequiredError('The provider connection is not active; connect again');
    const cached = this.validToken(current);
    if (cached) return cached;

    // The status change to needs_reauth must commit, so the transaction returns it instead of throwing
    const result = await this.uow.run(async (manager): Promise<{ token: string } | { reauth: string }> => {
      const connection = await this.repo.lockById(connectionId, manager);
      if (!connection || connection.status !== 'active') return { reauth: 'The provider connection is not active; connect again' };
      const name = capitalize(connection.provider);
      const fresh = this.validToken(connection);
      if (fresh) return { token: fresh };
      if (this.registry.get(connection.provider).authKind === 'api_key') {
        const apiKey = this.vault.tryDecrypt(connection.apiKeyEnc, connection.id);
        if (!apiKey) {
          await this.needsReauth(connection, 'Stored Garmin key could not be read (encryption key changed?); run connect_garmin again', manager);
          return { reauth: `${name} needs to be connected again` };
        }
        try {
          const grant = await this.registry.garmin.obtainToken(apiKey);
          this.applyGrant(connection, grant);
          await this.repo.save(connection, manager);
          return { token: grant.accessToken };
        } catch (error) {
          if (!(error instanceof ProviderAuthError)) throw error;
          await this.needsReauth(
            connection,
            'Garmin rejected the personal API key (deleted or expired); create a new key and run connect_garmin again',
            manager,
          );
          return { reauth: `${name} needs to be connected again` };
        }
      }
      const refreshToken = this.vault.tryDecrypt(connection.refreshTokenEnc, connection.id);
      if (!refreshToken) {
        await this.needsReauth(connection, 'Stored credentials could not be read (encryption key changed?); connect again', manager);
        return { reauth: `${name} needs to be connected again` };
      }
      let grant: TokenGrant;
      try {
        grant = await this.registry.get(connection.provider).refresh(refreshToken);
      } catch (error) {
        if (!(error instanceof ProviderAuthError)) throw error;
        await this.needsReauth(connection, `${name} refused the refresh token; connect again`, manager);
        return { reauth: `${name} needs to be connected again` };
      }
      this.applyGrant(connection, grant, refreshToken);
      await this.repo.save(connection, manager);
      return { token: grant.accessToken };
    });
    if ('reauth' in result) throw new ReauthorizationRequiredError(result.reauth);
    return result.token;
  }

  /** The provider no longer accepts the user's credential: stop using it until the user connects again */
  async markNeedsReauth(connectionId: string, reason: string): Promise<void> {
    await this.uow.run(async (manager) => {
      const connection = await this.repo.lockById(connectionId, manager);
      if (connection && connection.status === 'active') await this.needsReauth(connection, reason, manager);
    });
  }

  /** The provider refused the cached access token: drop it so the next accessToken() obtains a fresh one */
  async discardAccessToken(connectionId: string): Promise<void> {
    await this.uow.manager.update(ProviderConnectionEntity, { id: connectionId }, { accessTokenEnc: null, accessTokenExpiresAt: null });
  }

  /** The user's connection for a provider, if it is usable for a sync */
  async activeConnection(user: CurrentUser, provider: Provider): Promise<ProviderConnectionEntity> {
    const connection = await this.repo.findForUser(user.id, provider);
    if (!connection || connection.status === 'disconnected') throw new NotFoundError(`${capitalize(provider)} is not connected. Use connect_provider first.`);
    if (connection.status !== 'active') {
      throw new ReauthorizationRequiredError(
        `${capitalize(provider)} access was ${connection.status === 'revoked' ? 'revoked' : 'lost'}; connect again with connect_provider`,
      );
    }
    return connection;
  }

  private validToken(connection: ProviderConnectionEntity): string | null {
    const expiresAt = connection.accessTokenExpiresAt?.getTime() ?? Infinity;
    if (expiresAt - REFRESH_MARGIN_MS <= Date.now()) return null;
    // Unreadable or missing: fall through to a refresh
    return this.vault.tryDecrypt(connection.accessTokenEnc, connection.id);
  }

  private applyGrant(connection: ProviderConnectionEntity, grant: TokenGrant, previousRefreshToken: string | null = null): void {
    connection.accessTokenEnc = this.vault.encrypt(grant.accessToken, connection.id);
    const refresh = grant.refreshToken ?? previousRefreshToken;
    connection.refreshTokenEnc = refresh ? this.vault.encrypt(refresh, connection.id) : null;
    connection.accessTokenExpiresAt = grant.accessTokenExpiresAt;
    if (grant.refreshTokenExpiresAt || grant.refreshToken) connection.refreshTokenExpiresAt = grant.refreshTokenExpiresAt;
  }

  private async needsReauth(connection: ProviderConnectionEntity, reason: string, manager: Parameters<ConnectionsRepository['save']>[1]): Promise<void> {
    Object.assign(connection, {
      status: 'needs_reauth',
      accessTokenEnc: null,
      refreshTokenEnc: null,
      apiKeyEnc: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      lastError: reason,
      lastErrorAt: new Date(),
    });
    await this.repo.save(connection, manager);
  }
}

function toView(
  provider: Provider,
  available: boolean,
  syncMode: 'pull',
  authMethod: 'oauth' | 'api_key',
  c: ProviderConnectionEntity | null,
  activityCount: number,
): ConnectionView {
  return {
    provider,
    available,
    syncMode,
    authMethod,
    connected: c?.status === 'active',
    status: c?.status ?? 'not_connected',
    // For Garmin this is only a key digest (used to stop sharing a key between users): not shown
    externalUserId: authMethod === 'api_key' ? null : (c?.externalUserId ?? null),
    displayName: c?.displayName ?? null,
    scopes: c?.scopes ?? [],
    connectedAt: c?.connectedAt?.toISOString() ?? null,
    lastSyncAt: c?.lastSyncAt?.toISOString() ?? null,
    syncCursor: c?.syncCursor?.toISOString() ?? null,
    history: c && authMethod === 'api_key' ? { complete: c.historyComplete, activitiesWalked: c.historyOffset } : null,
    nextSyncAt: c?.nextSyncAt?.toISOString() ?? null,
    backoffUntil: c?.backoffUntil?.toISOString() ?? null,
    lastError: c?.lastError ?? null,
    lastErrorAt: c?.lastErrorAt?.toISOString() ?? null,
    activityCount,
  };
}

export function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
