import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Garmin Personal API: each user's own API key (encrypted) and the durable
 * sync state of the recent-to-older history walk and the periodic poll.
 * Old Garmin Developer Program (OAuth/webhook) connections cannot be used any
 * more: they are marked `needs_reauth` so the user is told to run connect_garmin.
 */
export class GarminPersonalApi1761300000000 implements MigrationInterface {
  name = 'GarminPersonalApi1761300000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE provider_connections
      ADD COLUMN api_key_enc text,
      ADD COLUMN history_offset integer NOT NULL DEFAULT 0,
      ADD COLUMN history_complete boolean NOT NULL DEFAULT false,
      ADD COLUMN next_sync_at timestamptz,
      ADD COLUMN backoff_until timestamptz,
      ADD COLUMN failure_count integer NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE provider_connections ADD CONSTRAINT "CHK_provider_connections_api_key"
      CHECK (status IN ('active', 'needs_reauth') OR api_key_enc IS NULL)`);
    await q.query(`CREATE INDEX "IDX_provider_connections_next_sync" ON provider_connections (next_sync_at) WHERE status = 'active' AND provider = 'garmin'`);
    await q.query(`ALTER TABLE sync_runs DROP CONSTRAINT sync_runs_trigger_check`);
    await q.query(`ALTER TABLE sync_runs ADD CONSTRAINT sync_runs_trigger_check CHECK (trigger IN ('connect', 'manual', 'scheduled'))`);
    await q.query(`UPDATE provider_connections SET status = 'needs_reauth', access_token_enc = NULL, refresh_token_enc = NULL,
      last_error = 'Garmin now uses a personal API key instead of the Developer Program; run connect_garmin', last_error_at = now()
      WHERE provider = 'garmin' AND status = 'active'`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`UPDATE sync_runs SET trigger = 'manual' WHERE trigger = 'scheduled'`);
    await q.query(`ALTER TABLE sync_runs DROP CONSTRAINT sync_runs_trigger_check`);
    await q.query(`ALTER TABLE sync_runs ADD CONSTRAINT sync_runs_trigger_check CHECK (trigger IN ('connect', 'manual'))`);
    await q.query(`DROP INDEX "IDX_provider_connections_next_sync"`);
    await q.query(`ALTER TABLE provider_connections DROP CONSTRAINT "CHK_provider_connections_api_key"`);
    await q.query(`ALTER TABLE provider_connections
      DROP COLUMN api_key_enc, DROP COLUMN history_offset, DROP COLUMN history_complete,
      DROP COLUMN next_sync_at, DROP COLUMN backoff_until, DROP COLUMN failure_count`);
  }
}
