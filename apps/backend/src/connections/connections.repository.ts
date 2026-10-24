import { randomUUID } from 'node:crypto';
import type { Provider } from '@fit/activity-model';
import { Injectable } from '@nestjs/common';
import { EntityManager, LessThan } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { returnedRows } from '../database/sql';
import { UnitOfWork } from '../database/unit-of-work';
import { OAuthStateEntity, ProviderConnectionEntity } from './connection.entities';

/** Connections and OAuth states. Every user-facing read takes the owning user */
@Injectable()
export class ConnectionsRepository {
  constructor(private readonly uow: UnitOfWork) {}

  listForUser(userId: string): Promise<ProviderConnectionEntity[]> {
    return this.uow.manager.find(ProviderConnectionEntity, { where: { userId }, order: { provider: 'ASC' } });
  }

  findForUser(userId: string, provider: Provider, manager: EntityManager = this.uow.manager): Promise<ProviderConnectionEntity | null> {
    return manager.findOne(ProviderConnectionEntity, { where: { userId, provider } });
  }

  /** Webhook routing: the connection for a provider account, whoever owns it */
  findByExternal(provider: Provider, externalUserId: string, manager: EntityManager = this.uow.manager): Promise<ProviderConnectionEntity | null> {
    return manager.findOne(ProviderConnectionEntity, { where: { provider, externalUserId } });
  }

  findById(id: string, manager: EntityManager = this.uow.manager): Promise<ProviderConnectionEntity | null> {
    return manager.findOne(ProviderConnectionEntity, { where: { id } });
  }

  /** Locks the row until the surrounding transaction ends (token refresh, connect) */
  lockById(id: string, manager: EntityManager): Promise<ProviderConnectionEntity | null> {
    return manager.findOne(ProviderConnectionEntity, { where: { id }, lock: { mode: 'pessimistic_write' } });
  }

  save(connection: ProviderConnectionEntity, manager: EntityManager = this.uow.manager): Promise<ProviderConnectionEntity> {
    return manager.save(ProviderConnectionEntity, connection);
  }

  async delete(id: string, manager: EntityManager = this.uow.manager): Promise<void> {
    await manager.delete(ProviderConnectionEntity, { id });
  }

  async activityCounts(userId: string): Promise<Map<string, number>> {
    const rows: { provider: string; count: string }[] = await this.uow.manager.query(
      `SELECT provider, count(*)::text AS count FROM activities WHERE user_id = $1 AND deleted_at IS NULL GROUP BY provider`,
      [userId],
    );
    return new Map(rows.map((row) => [row.provider, Number(row.count)]));
  }

  async insertState(state: OAuthStateEntity): Promise<void> {
    await this.uow.manager.insert(OAuthStateEntity, state);
  }

  /** Deletes and returns the state in one statement, so a state can be used once even under concurrent callbacks */
  async consumeState(stateHash: string): Promise<OAuthStateEntity | null> {
    type Row = { id: string; user_id: string; provider: Provider; code_verifier_enc: string | null; created_at: Date; expires_at: Date; state_hash: string };
    const rows = returnedRows<Row>(await this.uow.manager.query(`DELETE FROM oauth_states WHERE state_hash = $1 RETURNING *`, [stateHash]));
    const row = rows[0];
    if (!row) return null;
    return Object.assign(new OAuthStateEntity(), {
      id: row.id,
      stateHash: row.state_hash,
      userId: row.user_id,
      provider: row.provider,
      codeVerifierEnc: row.code_verifier_enc,
      createdAt: new Date(row.created_at),
      expiresAt: new Date(row.expires_at),
    });
  }

  /** Reads a state without using it (the Garmin key page shows who the link belongs to before the key is submitted) */
  findState(stateHash: string): Promise<OAuthStateEntity | null> {
    return this.uow.manager.findOne(OAuthStateEntity, { where: { stateHash } });
  }

  /** Active Garmin connections due for a poll, soonest first */
  dueGarminConnections(now: Date, limit: number): Promise<ProviderConnectionEntity[]> {
    return this.uow.manager
      .createQueryBuilder(ProviderConnectionEntity, 'c')
      .where(`c.provider = 'garmin' AND c.status = 'active'`)
      .andWhere('(c.next_sync_at IS NULL OR c.next_sync_at <= :now)', { now })
      .andWhere('(c.backoff_until IS NULL OR c.backoff_until <= :now)', { now })
      .andWhere('(c.sync_lock_until IS NULL OR c.sync_lock_until <= :now)', { now })
      .orderBy('c.next_sync_at', 'ASC', 'NULLS FIRST')
      .limit(limit)
      .getMany();
  }

  /**
   * Atomically takes the sync lease on a connection and returns its opaque owner
   * token, or null if someone else holds it. For any number of concurrent callers
   * (requests or pods) at most one gets a token; the lease lapses on its own at
   * `until` if the holder dies. Renewal and release must present the token, so a
   * stale holder can never touch a newer holder's lease.
   */
  async claimSync(connectionId: string, now: Date, until: Date): Promise<string | null> {
    const token = randomUUID();
    const rows = returnedRows<{ id: string }>(
      await this.uow.manager.query(
        `UPDATE provider_connections SET sync_lock_until = $2, sync_lock_token = $4
         WHERE id = $1 AND status = 'active' AND (sync_lock_until IS NULL OR sync_lock_until <= $3) RETURNING id`,
        [connectionId, until, now, token],
      ),
    );
    return rows.length > 0 ? token : null;
  }

  /** Extends a lease held by a long run. False when the lease is no longer ours (it lapsed and was re-claimed) */
  async renewSync(connectionId: string, token: string, until: Date): Promise<boolean> {
    const rows = returnedRows<{ id: string }>(
      await this.uow.manager.query(`UPDATE provider_connections SET sync_lock_until = $3 WHERE id = $1 AND sync_lock_token = $2 RETURNING id`, [
        connectionId,
        token,
        until,
      ]),
    );
    return rows.length > 0;
  }

  /**
   * Updates sync state (cursor, backoff, history position, ...) only while the
   * lease token is still ours. False when another worker owns the connection now,
   * in which case nothing was written.
   */
  async updateOwned(connectionId: string, token: string, values: QueryDeepPartialEntity<ProviderConnectionEntity>): Promise<boolean> {
    const result = await this.uow.manager
      .createQueryBuilder()
      .update(ProviderConnectionEntity)
      .set(values)
      .where('id = :connectionId AND sync_lock_token = :token', { connectionId, token })
      .returning('id')
      .execute();
    return returnedRows<{ id: string }>(result.raw).length > 0;
  }

  /** Releases the lease only if we still own it */
  async releaseSync(connectionId: string, token: string): Promise<void> {
    await this.uow.manager.query(`UPDATE provider_connections SET sync_lock_until = NULL, sync_lock_token = NULL WHERE id = $1 AND sync_lock_token = $2`, [
      connectionId,
      token,
    ]);
  }

  async purgeExpiredStates(now = new Date()): Promise<void> {
    await this.uow.manager.delete(OAuthStateEntity, { expiresAt: LessThan(now) });
  }
}
