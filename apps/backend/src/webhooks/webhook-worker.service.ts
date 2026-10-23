import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { In } from 'typeorm';
import { DomainError, ReauthorizationRequiredError, UpstreamRateLimitedError } from '../common/errors';
import { APP_CONFIG, type AppConfig } from '../config/env.config';
import { returnedRows } from '../database/sql';
import { UnitOfWork } from '../database/unit-of-work';
import { WebhookDeliveryEntity } from './webhook-delivery.entity';
import { PermanentDeliveryError, WebhookHandlers } from './webhook-handlers';
import { WebhookInboxService } from './webhook-inbox.service';

const BATCH_SIZE = 10;
const MAX_RETRY_DELAY_MS = 6 * 3_600_000;

/**
 * Processes the webhook inbox. Deliveries are claimed with
 * FOR UPDATE SKIP LOCKED, so several replicas can run workers safely.
 * Failures are retried with exponential backoff; after WEBHOOK_MAX_ATTEMPTS
 * the delivery is marked failed and kept (dead letter). A delivery left in
 * "processing" by a crashed process is reclaimed after WEBHOOK_STALE_AFTER_MS.
 */
@Injectable()
export class WebhookWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('WebhookWorker');
  private timer: NodeJS.Timeout | null = null;
  private draining: Promise<number> | null = null;
  private again = false;
  private stopped = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly uow: UnitOfWork,
    private readonly handlers: WebhookHandlers,
    inbox: WebhookInboxService,
  ) {
    if (config.webhooks.workerEnabled) inbox.onReceived(() => this.kick());
  }

  onApplicationBootstrap(): void {
    if (!this.config.webhooks.workerEnabled) return;
    this.timer = setInterval(() => this.kick(), this.config.webhooks.pollIntervalMs);
    this.timer.unref();
    this.kick();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.draining?.catch(() => undefined);
  }

  /** Runs a drain now, or right after the current one */
  private kick(): void {
    if (this.stopped) return;
    if (this.draining) {
      this.again = true;
      return;
    }
    void this.drain().catch((error) => this.logger.error('Webhook drain failed', (error as Error).stack));
  }

  /** Processes every due delivery; returns how many were handled. Tests call this directly */
  drain(): Promise<number> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      let total = 0;
      try {
        do {
          this.again = false;
          for (let batch = await this.claim(); batch.length; batch = await this.claim()) {
            for (const delivery of batch) await this.process(delivery);
            total += batch.length;
          }
        } while (this.again && !this.stopped);
      } finally {
        this.draining = null;
      }
      return total;
    })();
    return this.draining;
  }

  private async claim(): Promise<WebhookDeliveryEntity[]> {
    const staleBefore = new Date(Date.now() - this.config.webhooks.staleAfterMs);
    const rows = returnedRows<{ id: string }>(
      await this.uow.manager.query(
        `UPDATE webhook_deliveries SET status = 'processing', locked_at = now(), attempts = attempts + 1
         WHERE id IN (
           SELECT id FROM webhook_deliveries
           WHERE (status = 'pending' AND next_attempt_at <= now()) OR (status = 'processing' AND locked_at < $1)
           ORDER BY received_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         RETURNING id`,
        [staleBefore, BATCH_SIZE],
      ),
    );
    if (!rows.length) return [];
    const deliveries = await this.uow.manager.find(WebhookDeliveryEntity, { where: { id: In(rows.map((r) => r.id)) }, order: { receivedAt: 'ASC' } });
    return deliveries;
  }

  private async process(delivery: WebhookDeliveryEntity): Promise<void> {
    try {
      const result = await this.handlers.handle(delivery);
      await this.finish(delivery, { status: result.status, outcome: result.outcome, userId: result.userId ?? null, lastError: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const permanent = error instanceof PermanentDeliveryError || error instanceof ReauthorizationRequiredError;
      if (permanent || delivery.attempts >= this.config.webhooks.maxAttempts) {
        this.logger.warn(`Webhook delivery ${delivery.id} (${delivery.eventType}) failed permanently: ${message}`);
        await this.finish(delivery, {
          status: 'failed',
          outcome: permanent ? 'not retryable' : `gave up after ${delivery.attempts} attempts`,
          lastError: message,
          userId: delivery.userId,
        });
        return;
      }
      if (!(error instanceof DomainError)) this.logger.error(`Webhook delivery ${delivery.id} errored`, (error as Error).stack);
      const retryAfter = error instanceof UpstreamRateLimitedError ? Number(error.details?.retryAfterSeconds ?? 0) * 1000 : 0;
      const backoff = Math.min(MAX_RETRY_DELAY_MS, this.config.webhooks.retryBaseMs * 2 ** (delivery.attempts - 1));
      await this.uow.manager.update(
        WebhookDeliveryEntity,
        { id: delivery.id },
        {
          status: 'pending',
          lockedAt: null,
          userId: delivery.userId,
          lastError: message.slice(0, 2000),
          nextAttemptAt: new Date(Date.now() + Math.max(backoff, retryAfter)),
        },
      );
    }
  }

  private async finish(
    delivery: WebhookDeliveryEntity,
    result: { status: WebhookDeliveryEntity['status']; outcome: string; lastError: string | null; userId?: string | null },
  ): Promise<void> {
    await this.uow.manager.update(
      WebhookDeliveryEntity,
      { id: delivery.id },
      {
        status: result.status,
        outcome: result.outcome.slice(0, 255),
        lastError: result.lastError?.slice(0, 2000) ?? null,
        lockedAt: null,
        processedAt: new Date(),
        ...(result.userId !== undefined ? { userId: result.userId } : {}),
      },
    );
  }
}
