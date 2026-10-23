import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fit's initial schema. Runs on Postgres and PGlite alike (one dialect).
 * Check constraints mirror the `as const` lists in the entity files; change
 * both together, in a new migration.
 */
export class InitialSchema1761200000000 implements MigrationInterface {
  name = 'InitialSchema1761200000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY,
        issuer varchar(500) NOT NULL,
        subject varchar(255) NOT NULL,
        display_name varchar(255),
        email varchar(320),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE UNIQUE INDEX "UQ_users_issuer_subject" ON users (issuer, subject)`);

    await q.query(`
      CREATE TABLE provider_connections (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider varchar(16) NOT NULL CHECK (provider IN ('strava', 'garmin')),
        external_user_id varchar(128) NOT NULL,
        display_name varchar(255),
        scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
        status varchar(16) NOT NULL CHECK (status IN ('active', 'needs_reauth', 'revoked', 'disconnected')),
        access_token_enc text,
        refresh_token_enc text,
        access_token_expires_at timestamptz,
        refresh_token_expires_at timestamptz,
        sync_cursor timestamptz,
        last_sync_at timestamptz,
        last_error text,
        last_error_at timestamptz,
        connected_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_provider_connections_tokens" CHECK (status IN ('active', 'needs_reauth') OR (access_token_enc IS NULL AND refresh_token_enc IS NULL))
      )`);
    await q.query(`CREATE UNIQUE INDEX "UQ_provider_connections_user_provider" ON provider_connections (user_id, provider)`);
    await q.query(`CREATE UNIQUE INDEX "UQ_provider_connections_provider_external" ON provider_connections (provider, external_user_id)`);

    await q.query(`
      CREATE TABLE oauth_states (
        id uuid PRIMARY KEY,
        state_hash char(64) NOT NULL,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider varchar(16) NOT NULL CHECK (provider IN ('strava', 'garmin')),
        code_verifier_enc text,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
      )`);
    await q.query(`CREATE UNIQUE INDEX "UQ_oauth_states_state_hash" ON oauth_states (state_hash)`);
    await q.query(`CREATE INDEX "IDX_oauth_states_expires" ON oauth_states (expires_at)`);

    await q.query(`
      CREATE TABLE activities (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        connection_id uuid REFERENCES provider_connections(id) ON DELETE SET NULL,
        provider varchar(16) NOT NULL CHECK (provider IN ('strava', 'garmin')),
        provider_activity_id varchar(128) NOT NULL,
        name varchar(500),
        sport varchar(32) NOT NULL,
        provider_sport_type varchar(64),
        start_time timestamptz NOT NULL,
        start_time_local varchar(32),
        timezone varchar(64),
        utc_offset_seconds integer,
        elapsed_time_seconds double precision CHECK (elapsed_time_seconds >= 0),
        moving_time_seconds double precision CHECK (moving_time_seconds >= 0),
        distance_meters double precision CHECK (distance_meters >= 0),
        elevation_gain_meters double precision CHECK (elevation_gain_meters >= 0),
        average_speed_mps double precision,
        max_speed_mps double precision,
        average_heart_rate double precision,
        max_heart_rate double precision,
        average_power_watts double precision,
        average_cadence double precision,
        calories double precision,
        device_name varchar(255),
        manual boolean NOT NULL DEFAULT false,
        private boolean,
        start_latitude double precision,
        start_longitude double precision,
        raw jsonb NOT NULL,
        raw_hash char(64) NOT NULL,
        first_source varchar(16) NOT NULL CHECK (first_source IN ('sync', 'webhook')),
        last_source varchar(16) NOT NULL CHECK (last_source IN ('sync', 'webhook')),
        first_imported_at timestamptz NOT NULL,
        last_imported_at timestamptz NOT NULL,
        deleted_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE UNIQUE INDEX "UQ_activities_user_provider_external" ON activities (user_id, provider, provider_activity_id)`);
    await q.query(`CREATE INDEX "IDX_activities_user_start" ON activities (user_id, start_time DESC, id DESC)`);
    await q.query(`CREATE INDEX "IDX_activities_user_sport_start" ON activities (user_id, sport, start_time DESC)`);
    await q.query(`CREATE INDEX "IDX_activities_connection" ON activities (connection_id)`);

    await q.query(`
      CREATE TABLE activity_payloads (
        id uuid PRIMARY KEY,
        activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        payload jsonb NOT NULL,
        payload_hash char(64) NOT NULL,
        source varchar(16) NOT NULL CHECK (source IN ('sync', 'webhook')),
        received_at timestamptz NOT NULL
      )`);
    await q.query(`CREATE UNIQUE INDEX "UQ_activity_payloads_activity_hash" ON activity_payloads (activity_id, payload_hash)`);

    await q.query(`
      CREATE TABLE webhook_deliveries (
        id uuid PRIMARY KEY,
        provider varchar(16) NOT NULL CHECK (provider IN ('strava', 'garmin')),
        event_key varchar(255) NOT NULL,
        event_type varchar(64) NOT NULL,
        external_user_id varchar(128),
        user_id uuid REFERENCES users(id) ON DELETE SET NULL,
        payload jsonb NOT NULL,
        status varchar(16) NOT NULL CHECK (status IN ('pending', 'processing', 'processed', 'ignored', 'failed')),
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL,
        locked_at timestamptz,
        last_error text,
        outcome varchar(255),
        received_at timestamptz NOT NULL,
        processed_at timestamptz
      )`);
    await q.query(`CREATE UNIQUE INDEX "UQ_webhook_deliveries_event_key" ON webhook_deliveries (event_key)`);
    await q.query(`CREATE INDEX "IDX_webhook_deliveries_due" ON webhook_deliveries (status, next_attempt_at)`);
    await q.query(`CREATE INDEX "IDX_webhook_deliveries_user" ON webhook_deliveries (user_id, received_at DESC)`);

    await q.query(`
      CREATE TABLE sync_runs (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        connection_id uuid REFERENCES provider_connections(id) ON DELETE SET NULL,
        provider varchar(16) NOT NULL CHECK (provider IN ('strava', 'garmin')),
        trigger varchar(16) NOT NULL CHECK (trigger IN ('connect', 'manual')),
        kind varchar(24) NOT NULL CHECK (kind IN ('initial', 'incremental', 'backfill_request')),
        status varchar(16) NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
        window_start timestamptz,
        window_end timestamptz,
        pages integer NOT NULL DEFAULT 0,
        fetched integer NOT NULL DEFAULT 0,
        created integer NOT NULL DEFAULT 0,
        updated integer NOT NULL DEFAULT 0,
        unchanged integer NOT NULL DEFAULT 0,
        skipped integer NOT NULL DEFAULT 0,
        error text,
        started_at timestamptz NOT NULL,
        finished_at timestamptz
      )`);
    await q.query(`CREATE INDEX "IDX_sync_runs_user_started" ON sync_runs (user_id, started_at DESC)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE sync_runs`);
    await q.query(`DROP TABLE webhook_deliveries`);
    await q.query(`DROP TABLE activity_payloads`);
    await q.query(`DROP TABLE activities`);
    await q.query(`DROP TABLE oauth_states`);
    await q.query(`DROP TABLE provider_connections`);
    await q.query(`DROP TABLE users`);
  }
}
