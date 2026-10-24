import type { Provider } from '@fit/activity-model';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

export const DELIVERY_STATUSES = ['pending', 'processing', 'processed', 'ignored', 'failed'] as const;
/**
 * - pending: waiting for the worker (new, or retrying after an error at `nextAttemptAt`)
 * - processing: claimed by a worker (`lockedAt`); reclaimed if stale
 * - processed / ignored: done (ignored = authentic but nothing to do, e.g. unknown athlete)
 * - failed: gave up after WEBHOOK_MAX_ATTEMPTS (dead letter, kept for inspection)
 */
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * The durable webhook inbox. A provider event is stored here and acknowledged
 * before any work happens; the worker (webhook-worker.service.ts) processes
 * it. `eventKey` is unique, so a redelivered event is stored once.
 */
@Entity('webhook_deliveries')
@Index('IDX_webhook_deliveries_due', ['status', 'nextAttemptAt'])
export class WebhookDeliveryEntity {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 16 })
  provider: Provider;

  @Index('UQ_webhook_deliveries_event_key', { unique: true })
  @Column({ name: 'event_key', type: 'varchar', length: 255 })
  eventKey: string;

  /** e.g. activity.create, athlete.deauthorize, garmin.activities, garmin.deregistration */
  @Column({ name: 'event_type', type: 'varchar', length: 64 })
  eventType: string;

  @Column({ name: 'external_user_id', type: 'varchar', length: 128, nullable: true })
  externalUserId: string | null;

  /** Filled in when the event is routed to a Fit user */
  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ type: 'varchar', length: 16 })
  status: DeliveryStatus;

  @Column({ type: 'integer', default: 0 })
  attempts: number;

  @Column({ name: 'next_attempt_at', type: 'timestamptz' })
  nextAttemptAt: Date;

  @Column({ name: 'locked_at', type: 'timestamptz', nullable: true })
  lockedAt: Date | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  /** Short human-readable result, e.g. "activity created", "unknown athlete" */
  @Column({ type: 'varchar', length: 255, nullable: true })
  outcome: string | null;

  @Column({ name: 'received_at', type: 'timestamptz' })
  receivedAt: Date;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt: Date | null;
}
