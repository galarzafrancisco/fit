import type { Provider } from '@fit/activity-model';
import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export const CONNECTION_STATUSES = ['active', 'needs_reauth', 'revoked', 'disconnected'] as const;
/**
 * - active: tokens work (as far as we know).
 * - needs_reauth: the provider refused our refresh token; the user must connect again.
 * - revoked: the user removed Fit's access at the provider (deauthorization/deregistration event).
 * - disconnected: the user disconnected in Fit; tokens are deleted.
 */
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/**
 * One user's link to one provider account. Tokens are encrypted with
 * TOKEN_ENCRYPTION_KEY and the row ID as associated data (common/secrets.ts),
 * and are never returned by any API.
 */
@Entity('provider_connections')
@Index('UQ_provider_connections_user_provider', ['userId', 'provider'], { unique: true })
@Index('UQ_provider_connections_provider_external', ['provider', 'externalUserId'], { unique: true })
export class ProviderConnectionEntity {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar', length: 16 })
  provider: Provider;

  /** The provider's user/athlete ID; webhooks are routed by it */
  @Column({ name: 'external_user_id', type: 'varchar', length: 128 })
  externalUserId: string;

  @Column({ name: 'display_name', type: 'varchar', length: 255, nullable: true })
  displayName: string | null;

  /** Scopes/permissions the user actually granted */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  scopes: string[];

  @Column({ type: 'varchar', length: 16 })
  status: ConnectionStatus;

  @Column({ name: 'access_token_enc', type: 'text', nullable: true })
  accessTokenEnc: string | null;

  @Column({ name: 'refresh_token_enc', type: 'text', nullable: true })
  refreshTokenEnc: string | null;

  @Column({ name: 'access_token_expires_at', type: 'timestamptz', nullable: true })
  accessTokenExpiresAt: Date | null;

  @Column({ name: 'refresh_token_expires_at', type: 'timestamptz', nullable: true })
  refreshTokenExpiresAt: Date | null;

  /** Garmin Personal API key, encrypted with the row ID as associated data. Never returned by any API */
  @Column({ name: 'api_key_enc', type: 'text', nullable: true })
  apiKeyEnc: string | null;

  /** Garmin: activities already walked through in the newest-first history listing (next page starts here) */
  @Column({ name: 'history_offset', type: 'int', default: 0 })
  historyOffset: number;

  /** Garmin: the history walk reached the end (or its configured limit) */
  @Column({ name: 'history_complete', type: 'boolean', default: false })
  historyComplete: boolean;

  /** Garmin: the scheduler does not touch this connection before this time */
  @Column({ name: 'next_sync_at', type: 'timestamptz', nullable: true })
  nextSyncAt: Date | null;

  /** Garmin: set after repeated provider failures or rate limiting; exponential, capped */
  @Column({ name: 'backoff_until', type: 'timestamptz', nullable: true })
  backoffUntil: Date | null;

  /** Garmin: a sync of this connection holds the lease until this time (atomic claim; expires if the holder dies) */
  @Column({ name: 'sync_lock_until', type: 'timestamptz', nullable: true })
  syncLockUntil: Date | null;

  /** Opaque owner of the current lease; renew/release must present it (fencing) */
  @Column({ name: 'sync_lock_token', type: 'varchar', length: 64, nullable: true })
  syncLockToken: string | null;

  @Column({ name: 'failure_count', type: 'int', default: 0 })
  failureCount: number;

  /** End of the last complete sync window; the next incremental sync starts here minus SYNC_OVERLAP_HOURS */
  @Column({ name: 'sync_cursor', type: 'timestamptz', nullable: true })
  syncCursor: Date | null;

  @Column({ name: 'last_sync_at', type: 'timestamptz', nullable: true })
  lastSyncAt: Date | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  @Column({ name: 'last_error_at', type: 'timestamptz', nullable: true })
  lastErrorAt: Date | null;

  @Column({ name: 'connected_at', type: 'timestamptz' })
  connectedAt: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

/**
 * A started provider connection, waiting for the OAuth callback. Only the
 * SHA-256 of `state` is stored; the row is deleted when the callback uses it,
 * so each state works once.
 */
@Entity('oauth_states')
export class OAuthStateEntity {
  @PrimaryColumn('uuid')
  id: string;

  @Index('UQ_oauth_states_state_hash', { unique: true })
  @Column({ name: 'state_hash', type: 'char', length: 64 })
  stateHash: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar', length: 16 })
  provider: Provider;

  /** PKCE code verifier (Garmin), encrypted with the row ID as associated data */
  @Column({ name: 'code_verifier_enc', type: 'text', nullable: true })
  codeVerifierEnc: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;
}
