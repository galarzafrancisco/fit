import type { Provider, Sport } from '@fit/activity-model';
import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export const ACTIVITY_SOURCES = ['sync', 'webhook'] as const;
/** How a payload reached Fit: pulled by a sync, or delivered/triggered by a webhook */
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number];

/**
 * One activity of one user from one provider. The normalized columns are what
 * queries filter and aggregate on; `raw` is the latest provider payload,
 * untouched. Every distinct payload version is also kept in activity_payloads.
 * Deleted at the provider = `deletedAt` set; the row is kept for provenance.
 *
 * Metrics are double precision: they are measurements, not money.
 */
@Entity('activities')
@Index('UQ_activities_user_provider_external', ['userId', 'provider', 'providerActivityId'], { unique: true })
@Index('IDX_activities_user_start', ['userId', 'startTime'])
export class ActivityEntity {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  /** The connection that imported it; null once that connection is removed */
  @Column({ name: 'connection_id', type: 'uuid', nullable: true })
  connectionId: string | null;

  @Column({ type: 'varchar', length: 16 })
  provider: Provider;

  @Column({ name: 'provider_activity_id', type: 'varchar', length: 128 })
  providerActivityId: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  name: string | null;

  @Column({ type: 'varchar', length: 32 })
  sport: Sport;

  @Column({ name: 'provider_sport_type', type: 'varchar', length: 64, nullable: true })
  providerSportType: string | null;

  @Column({ name: 'start_time', type: 'timestamptz' })
  startTime: Date;

  /** Wall-clock start at the activity's location, as the provider reported it */
  @Column({ name: 'start_time_local', type: 'varchar', length: 32, nullable: true })
  startTimeLocal: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  timezone: string | null;

  @Column({ name: 'utc_offset_seconds', type: 'integer', nullable: true })
  utcOffsetSeconds: number | null;

  @Column({ name: 'elapsed_time_seconds', type: 'double precision', nullable: true })
  elapsedTimeSeconds: number | null;

  @Column({ name: 'moving_time_seconds', type: 'double precision', nullable: true })
  movingTimeSeconds: number | null;

  @Column({ name: 'distance_meters', type: 'double precision', nullable: true })
  distanceMeters: number | null;

  @Column({ name: 'elevation_gain_meters', type: 'double precision', nullable: true })
  elevationGainMeters: number | null;

  @Column({ name: 'average_speed_mps', type: 'double precision', nullable: true })
  averageSpeedMps: number | null;

  @Column({ name: 'max_speed_mps', type: 'double precision', nullable: true })
  maxSpeedMps: number | null;

  @Column({ name: 'average_heart_rate', type: 'double precision', nullable: true })
  averageHeartRate: number | null;

  @Column({ name: 'max_heart_rate', type: 'double precision', nullable: true })
  maxHeartRate: number | null;

  @Column({ name: 'average_power_watts', type: 'double precision', nullable: true })
  averagePowerWatts: number | null;

  @Column({ name: 'average_cadence', type: 'double precision', nullable: true })
  averageCadence: number | null;

  @Column({ type: 'double precision', nullable: true })
  calories: number | null;

  @Column({ name: 'device_name', type: 'varchar', length: 255, nullable: true })
  deviceName: string | null;

  @Column({ type: 'boolean', default: false })
  manual: boolean;

  @Column({ type: 'boolean', nullable: true })
  private: boolean | null;

  @Column({ name: 'start_latitude', type: 'double precision', nullable: true })
  startLatitude: number | null;

  @Column({ name: 'start_longitude', type: 'double precision', nullable: true })
  startLongitude: number | null;

  @Column({ type: 'jsonb' })
  raw: Record<string, unknown>;

  @Column({ name: 'raw_hash', type: 'char', length: 64 })
  rawHash: string;

  @Column({ name: 'first_source', type: 'varchar', length: 16 })
  firstSource: ActivitySource;

  @Column({ name: 'last_source', type: 'varchar', length: 16 })
  lastSource: ActivitySource;

  @Column({ name: 'first_imported_at', type: 'timestamptz' })
  firstImportedAt: Date;

  @Column({ name: 'last_imported_at', type: 'timestamptz' })
  lastImportedAt: Date;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

/** Every distinct provider payload ever received for an activity (provenance; nothing is overwritten) */
@Entity('activity_payloads')
@Index('UQ_activity_payloads_activity_hash', ['activityId', 'payloadHash'], { unique: true })
export class ActivityPayloadEntity {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ name: 'activity_id', type: 'uuid' })
  activityId: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ name: 'payload_hash', type: 'char', length: 64 })
  payloadHash: string;

  @Column({ type: 'varchar', length: 16 })
  source: ActivitySource;

  @Column({ name: 'received_at', type: 'timestamptz' })
  receivedAt: Date;
}
