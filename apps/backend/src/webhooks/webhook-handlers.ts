import { ActivityMappingError } from '@fit/activity-model';
import { Injectable } from '@nestjs/common';
import { ActivityIngestService } from '../activities/activity-ingest.service';
import type { ProviderConnectionEntity } from '../connections/connection.entities';
import { ConnectionsRepository } from '../connections/connections.repository';
import { ConnectionsService } from '../connections/connections.service';
import { ProviderRegistry } from '../providers/provider-registry';
import type { WebhookDeliveryEntity } from './webhook-delivery.entity';
import { stravaEventSchema } from './webhook-inbox.service';

export type HandlerResult = { status: 'processed' | 'ignored'; outcome: string; userId?: string };

/** An authentic event that can never succeed (unreadable payload); not retried */
export class PermanentDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentDeliveryError';
  }
}

/**
 * What each stored provider event means for Fit. Throwing means "retry
 * later" (except PermanentDeliveryError); returning means done.
 */
@Injectable()
export class WebhookHandlers {
  constructor(
    private readonly connections: ConnectionsService,
    private readonly connectionsRepo: ConnectionsRepository,
    private readonly registry: ProviderRegistry,
    private readonly ingest: ActivityIngestService,
  ) {}

  async handle(delivery: WebhookDeliveryEntity): Promise<HandlerResult> {
    if (!delivery.externalUserId) return { status: 'ignored', outcome: 'event names no provider user' };
    const connection = await this.connectionsRepo.findByExternal(delivery.provider, delivery.externalUserId);
    if (!connection) return { status: 'ignored', outcome: 'no Fit user is connected to this provider account' };
    const userId = connection.userId;
    // Recorded on the delivery even if processing fails below
    delivery.userId = userId;
    if (connection.status !== 'active') return { status: 'ignored', outcome: `connection is ${connection.status}`, userId };
    if (delivery.provider !== 'strava') return { status: 'ignored', outcome: `${delivery.provider} has no webhooks`, userId };
    const result = await this.strava(delivery, connection);
    return { ...result, userId };
  }

  /**
   * Strava events carry only IDs. The activity is always re-read from the
   * API with the athlete's token, so a forged or stale event cannot inject
   * data, and the result does not depend on the order events arrive in.
   */
  private async strava(delivery: WebhookDeliveryEntity, connection: ProviderConnectionEntity): Promise<HandlerResult> {
    const parsed = stravaEventSchema.safeParse(delivery.payload);
    if (!parsed.success) throw new PermanentDeliveryError('Stored Strava event no longer parses');
    const event = parsed.data;
    if (delivery.eventType === 'athlete.deauthorize') {
      await this.connections.markRevoked(connection.id, 'Access was revoked on Strava; connect again to resume imports');
      return { status: 'processed', outcome: 'connection revoked at Strava' };
    }
    if (event.object_type !== 'activity') return { status: 'ignored', outcome: `athlete ${event.aspect_type} event` };
    if (event.aspect_type === 'delete') {
      const deleted = await this.ingest.markDeleted(connection.userId, 'strava', event.object_id);
      return { status: 'processed', outcome: deleted ? 'activity marked deleted' : 'activity was not imported' };
    }
    const token = await this.connections.accessToken(connection.id);
    const raw = await this.registry.strava.fetchActivity(token, event.object_id);
    if (raw === null) {
      const deleted = await this.ingest.markDeleted(connection.userId, 'strava', event.object_id);
      return { status: 'processed', outcome: deleted ? 'activity no longer visible; marked deleted' : 'activity not visible to Fit' };
    }
    return this.importOne(connection, raw);
  }

  private async importOne(connection: ProviderConnectionEntity, raw: unknown): Promise<HandlerResult> {
    try {
      const { outcome } = await this.ingest.ingest({
        userId: connection.userId,
        connectionId: connection.id,
        provider: connection.provider,
        raw,
        source: 'webhook',
      });
      return { status: 'processed', outcome: `activity ${outcome}` };
    } catch (error) {
      if (error instanceof ActivityMappingError) throw new PermanentDeliveryError(`Unreadable activity: ${error.message}`);
      throw error;
    }
  }
}
