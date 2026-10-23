import type { Provider } from '@fit/activity-model';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

export const SYNC_TRIGGERS = ['connect', 'manual'] as const;
export type SyncTrigger = (typeof SYNC_TRIGGERS)[number];

export const SYNC_KINDS = ['initial', 'incremental', 'backfill_request'] as const;
/** backfill_request: Garmin only. Fit asks Garmin to push history; the data arrives later by webhook */
export type SyncKind = (typeof SYNC_KINDS)[number];

export const SYNC_STATUSES = ['running', 'succeeded', 'partial', 'failed'] as const;
/** partial: stopped early (page limit, rate limit) with some data imported; the next sync continues */
export type SyncStatus = (typeof SYNC_STATUSES)[number];

/** Audit trail of every sync attempt, with counts and the error if any */
@Entity('sync_runs')
@Index('IDX_sync_runs_user_started', ['userId', 'startedAt'])
export class SyncRunEntity {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'connection_id', type: 'uuid', nullable: true })
  connectionId: string | null;

  @Column({ type: 'varchar', length: 16 })
  provider: Provider;

  @Column({ type: 'varchar', length: 16 })
  trigger: SyncTrigger;

  @Column({ type: 'varchar', length: 24 })
  kind: SyncKind;

  @Column({ type: 'varchar', length: 16 })
  status: SyncStatus;

  @Column({ name: 'window_start', type: 'timestamptz', nullable: true })
  windowStart: Date | null;

  @Column({ name: 'window_end', type: 'timestamptz', nullable: true })
  windowEnd: Date | null;

  @Column({ type: 'integer', default: 0 })
  pages: number;

  @Column({ type: 'integer', default: 0 })
  fetched: number;

  @Column({ type: 'integer', default: 0 })
  created: number;

  @Column({ type: 'integer', default: 0 })
  updated: number;

  @Column({ type: 'integer', default: 0 })
  unchanged: number;

  /** Payloads that could not be mapped (kept out; see error) */
  @Column({ type: 'integer', default: 0 })
  skipped: number;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ name: 'started_at', type: 'timestamptz' })
  startedAt: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt: Date | null;
}
