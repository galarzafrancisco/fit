import type { Provider } from '@fit/activity-model';
import { Injectable } from '@nestjs/common';
import { EntityManager, LessThan } from 'typeorm';
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
      .orderBy('c.next_sync_at', 'ASC', 'NULLS FIRST')
      .limit(limit)
      .getMany();
  }

  async purgeExpiredStates(now = new Date()): Promise<void> {
    await this.uow.manager.delete(OAuthStateEntity, { expiresAt: LessThan(now) });
  }
}
