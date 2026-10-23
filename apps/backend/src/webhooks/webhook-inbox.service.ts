import { contentHash, type Provider } from '@fit/activity-model';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../common/errors';
import { safeEqual } from '../common/secrets';
import { APP_CONFIG, type AppConfig } from '../config/env.config';
import { scrubPayload } from '../activities/activity-ingest.service';
import { UnitOfWork } from '../database/unit-of-work';
import { WebhookDeliveryEntity } from './webhook-delivery.entity';

/** The request is not from the provider (wrong path secret, wrong subscription). Answered as 404 so the endpoint is not discoverable */
export class WebhookNotFoundError extends DomainError {
  readonly code = 'not_found';
  readonly httpStatus = 404;
}

/** Authentic, but not an event Fit understands */
export class WebhookMalformedError extends DomainError {
  readonly code = 'invalid_event';
  readonly httpStatus = 400;
}

export const stravaEventSchema = z.object({
  object_type: z.enum(['activity', 'athlete']),
  object_id: z.union([z.number().int().nonnegative(), z.string().regex(/^\d{1,20}$/)]).transform(String),
  aspect_type: z.enum(['create', 'update', 'delete']),
  owner_id: z.union([z.number().int().nonnegative(), z.string().regex(/^\d{1,20}$/)]).transform(String),
  subscription_id: z.union([z.number().int().nonnegative(), z.string().regex(/^\d{1,20}$/)]).transform(String),
  event_time: z.number().int().nonnegative(),
  updates: z.record(z.string(), z.unknown()).optional(),
});
export type StravaEvent = z.infer<typeof stravaEventSchema>;

/** Garmin pushes one object with lists per summary type; each item names its Garmin user */
const garminItem = z.looseObject({ userId: z.string().min(1).max(128) });
const garminBody = z.looseObject({
  activities: z.array(garminItem).max(1000).optional(),
  manuallyUpdatedActivities: z.array(garminItem).max(1000).optional(),
  deregistrations: z.array(garminItem).max(1000).optional(),
  userPermissionsChange: z.array(garminItem).max(1000).optional(),
});

/** Garmin list name → Fit event type */
const GARMIN_LISTS = {
  activities: 'garmin.activity',
  manuallyUpdatedActivities: 'garmin.activity',
  deregistrations: 'garmin.deregistration',
  userPermissionsChange: 'garmin.permissions',
} as const;

export type ReceiveResult = { received: number; duplicates: number };

/**
 * Authenticates and stores provider events in the durable inbox, then lets
 * the worker do the work. Nothing here calls a provider or changes
 * activities, so the provider gets its 200 within its deadline (Strava: 2 s).
 */
@Injectable()
export class WebhookInboxService {
  private readonly logger = new Logger('WebhookInbox');
  private listener: (() => void) | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly uow: UnitOfWork,
  ) {}

  /** The worker subscribes to be woken when a delivery is stored */
  onReceived(listener: () => void): void {
    this.listener = listener;
  }

  /** Strava subscription validation (GET with hub.* parameters) */
  stravaChallenge(pathSecret: string, query: Record<string, unknown>): { 'hub.challenge': string } {
    this.checkSecret(this.config.strava.webhookSecret, pathSecret);
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    if (mode !== 'subscribe' || typeof token !== 'string' || typeof challenge !== 'string' || challenge.length > 255) {
      throw new WebhookMalformedError('Not a subscription validation request');
    }
    if (!safeEqual(token, this.config.strava.webhookSecret!)) throw new WebhookNotFoundError('Not found');
    return { 'hub.challenge': challenge };
  }

  async receiveStrava(pathSecret: string, body: unknown): Promise<ReceiveResult> {
    this.checkSecret(this.config.strava.webhookSecret, pathSecret);
    const parsed = stravaEventSchema.safeParse(body);
    if (!parsed.success) throw new WebhookMalformedError('Not a Strava webhook event');
    const event = parsed.data;
    const expected = this.config.strava.webhookSubscriptionId;
    if (expected && event.subscription_id !== expected) throw new WebhookNotFoundError('Not found');
    if (!expected) this.logger.warn('STRAVA_WEBHOOK_SUBSCRIPTION_ID is not set; accepting events for any subscription');
    const deauthorize = event.object_type === 'athlete' && String(event.updates?.authorized) === 'false';
    const stored = await this.store({
      provider: 'strava',
      eventKey: `strava:${event.subscription_id}:${event.object_type}:${event.object_id}:${event.aspect_type}:${event.event_time}`,
      eventType: deauthorize ? 'athlete.deauthorize' : `${event.object_type}.${event.aspect_type}`,
      externalUserId: event.owner_id,
      payload: body as Record<string, unknown>,
    });
    return { received: 1, duplicates: stored ? 0 : 1 };
  }

  async receiveGarmin(pathSecret: string, body: unknown): Promise<ReceiveResult> {
    this.checkSecret(this.config.garmin.webhookSecret, pathSecret);
    const parsed = garminBody.safeParse(body);
    if (!parsed.success) throw new WebhookMalformedError('Not a Garmin notification');
    let received = 0;
    let duplicates = 0;
    for (const [list, type] of Object.entries(GARMIN_LISTS) as Array<[keyof typeof GARMIN_LISTS, string]>) {
      for (const item of parsed.data[list] ?? []) {
        const payload = scrubPayload(item);
        const eventType = type === 'garmin.activity' && typeof payload.callbackURL === 'string' ? 'garmin.activity_ping' : type;
        const stored = await this.store({
          provider: 'garmin',
          eventKey: `garmin:${eventType}:${item.userId}:${contentHash(payload)}`,
          eventType,
          externalUserId: item.userId,
          payload,
        });
        received++;
        if (!stored) duplicates++;
      }
    }
    const unknown = Object.keys(parsed.data).filter((key) => !(key in GARMIN_LISTS));
    if (unknown.length) this.logger.log(`Garmin notification lists not handled: ${unknown.join(', ')}`);
    return { received, duplicates };
  }

  /** Webhook events routed to this user, newest first (observability for the user and their AI client) */
  async listForUser(userId: string, input: { provider?: Provider; limit?: number }) {
    const rows = await this.uow.manager.find(WebhookDeliveryEntity, {
      where: { userId, ...(input.provider ? { provider: input.provider } : {}) },
      order: { receivedAt: 'DESC' },
      take: input.limit ?? 20,
    });
    return rows.map((d) => ({
      id: d.id,
      provider: d.provider,
      eventType: d.eventType,
      status: d.status,
      outcome: d.outcome,
      attempts: d.attempts,
      lastError: d.lastError,
      nextAttemptAt: d.status === 'pending' ? d.nextAttemptAt.toISOString() : null,
      receivedAt: d.receivedAt.toISOString(),
      processedAt: d.processedAt?.toISOString() ?? null,
    }));
  }

  /** Inserts a delivery; false when the same event was already stored (provider retry) */
  private async store(input: { provider: Provider; eventKey: string; eventType: string; externalUserId: string | null; payload: Record<string, unknown> }): Promise<boolean> {
    const now = new Date();
    const result = await this.uow.manager
      .createQueryBuilder()
      .insert()
      .into(WebhookDeliveryEntity)
      .values({
        id: randomUUID(),
        provider: input.provider,
        eventKey: input.eventKey.slice(0, 255),
        eventType: input.eventType,
        externalUserId: input.externalUserId,
        userId: null,
        payload: input.payload as never,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now,
        lockedAt: null,
        lastError: null,
        outcome: null,
        receivedAt: now,
        processedAt: null,
      })
      .orIgnore()
      .returning(['id'])
      .execute();
    const stored = (result.raw as unknown[]).length > 0;
    if (stored) this.listener?.();
    return stored;
  }

  /** Constant-time check of the URL's secret segment. Unconfigured provider webhooks answer 404 */
  private checkSecret(expected: string | null, actual: string): void {
    if (!expected || !safeEqual(actual, expected)) throw new WebhookNotFoundError('Not found');
  }
}
