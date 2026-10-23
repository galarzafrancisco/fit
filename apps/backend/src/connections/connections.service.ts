import { isProvider, type Provider } from '@fit/activity-model';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ConflictError, NotFoundError, ReauthorizationRequiredError } from '../common/errors';
import { randomSecret, sha256 } from '../common/secrets';
import { parseInput } from '../common/validation';
import { APP_CONFIG, type AppConfig } from '../config/env.config';
import { UnitOfWork } from '../database/unit-of-work';
import { ProviderAuthError } from '../providers/http';
import { ProviderRegistry } from '../providers/provider-registry';
import type { TokenGrant } from '../providers/provider.port';
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
  syncMode: 'pull' | 'push';
  connected: boolean;
  status: ProviderConnectionEntity['status'] | 'not_connected';
  externalUserId: string | null;
  displayName: string | null;
  scopes: string[];
  connectedAt: string | null;
  lastSyncAt: string | null;
  syncCursor: string | null;
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
  ) {}

  async list(user: CurrentUser): Promise<ConnectionView[]> {
    const [connections, counts] = await Promise.all([this.repo.listForUser(user.id), this.repo.activityCounts(user.id)]);
    return this.registry.all().map((adapter) => {
      const connection = connections.find((c) => c.provider === adapter.provider) ?? null;
      return toView(adapter.provider, adapter.configured, adapter.syncMode, connection, counts.get(adapter.provider) ?? 0);
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
  async startConnect(user: CurrentUser, providerInput: unknown): Promise<{ provider: Provider; authorizationUrl: string; expiresAt: string; instructions: string }> {
    const provider = parseInput(providerSchema, providerInput);
    const adapter = this.registry.get(provider);
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
    if (!input.state || input.state.length > 200) throw new ConnectCallbackError('The sign-in link is missing its state. Start connecting again from your AI assistant.');
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
      throw new ConnectCallbackError(`Fit needs permission to read your activities (${adapter.requiredScopes.join(', ')}). Connect again and keep that permission selected.`);
    }

    const connection = await this.uow.run(async (manager) => {
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
    }).catch((error) => {
      if (error instanceof ConflictError) throw new ConnectCallbackError(error.message);
      throw error;
    });
    this.logger.log(`Connected ${provider} account ${account.externalUserId} for user ${state.userId}`);
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
      Object.assign(locked, { status: 'disconnected', accessTokenEnc: null, refreshTokenEnc: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null });
      await this.repo.save(locked, manager);
      let deletedActivities = 0;
      if (deleteActivities) {
        const result = await manager.query(`DELETE FROM activities WHERE user_id = $1 AND provider = $2`, [user.id, provider]);
        deletedActivities = Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
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

    return this.uow.run(async (manager) => {
      const connection = await this.repo.lockById(connectionId, manager);
      if (!connection || connection.status !== 'active') throw new ReauthorizationRequiredError('The provider connection is not active; connect again');
      const fresh = this.validToken(connection);
      if (fresh) return fresh;
      const refreshToken = this.vault.tryDecrypt(connection.refreshTokenEnc, connection.id);
      if (!refreshToken) {
        await this.needsReauth(connection, 'Stored credentials could not be read (encryption key changed?); connect again', manager);
        throw new ReauthorizationRequiredError(`${capitalize(connection.provider)} needs to be connected again`);
      }
      let grant: TokenGrant;
      try {
        grant = await this.registry.get(connection.provider).refresh(refreshToken);
      } catch (error) {
        if (error instanceof ProviderAuthError) {
          await this.needsReauth(connection, `${capitalize(connection.provider)} refused the refresh token; connect again`, manager);
          throw new ReauthorizationRequiredError(`${capitalize(connection.provider)} needs to be connected again`);
        }
        throw error;
      }
      this.applyGrant(connection, grant, refreshToken);
      await this.repo.save(connection, manager);
      return grant.accessToken;
    });
  }

  /** The user's connection for a provider, if it is usable for a sync */
  async activeConnection(user: CurrentUser, provider: Provider): Promise<ProviderConnectionEntity> {
    const connection = await this.repo.findForUser(user.id, provider);
    if (!connection || connection.status === 'disconnected') throw new NotFoundError(`${capitalize(provider)} is not connected. Use connect_provider first.`);
    if (connection.status !== 'active') {
      throw new ReauthorizationRequiredError(`${capitalize(provider)} access was ${connection.status === 'revoked' ? 'revoked' : 'lost'}; connect again with connect_provider`);
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
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      lastError: reason,
      lastErrorAt: new Date(),
    });
    await this.repo.save(connection, manager);
  }
}

function toView(provider: Provider, available: boolean, syncMode: 'pull' | 'push', c: ProviderConnectionEntity | null, activityCount: number): ConnectionView {
  return {
    provider,
    available,
    syncMode,
    connected: c?.status === 'active',
    status: c?.status ?? 'not_connected',
    externalUserId: c?.externalUserId ?? null,
    displayName: c?.displayName ?? null,
    scopes: c?.scopes ?? [],
    connectedAt: c?.connectedAt?.toISOString() ?? null,
    lastSyncAt: c?.lastSyncAt?.toISOString() ?? null,
    syncCursor: c?.syncCursor?.toISOString() ?? null,
    lastError: c?.lastError ?? null,
    lastErrorAt: c?.lastErrorAt?.toISOString() ?? null,
    activityCount,
  };
}

export function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
