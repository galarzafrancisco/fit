import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Garmin sync claim: a lease on the connection taken with one atomic UPDATE,
 * so concurrent refreshes and several pods never sync the same connection at once.
 */
export class GarminSyncLock1761400000000 implements MigrationInterface {
  name = 'GarminSyncLock1761400000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE provider_connections ADD COLUMN sync_lock_until timestamptz`);
    await q.query(`ALTER TABLE provider_connections ADD COLUMN sync_lock_token varchar(64)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE provider_connections DROP COLUMN sync_lock_token`);
    await q.query(`ALTER TABLE provider_connections DROP COLUMN sync_lock_until`);
  }
}
