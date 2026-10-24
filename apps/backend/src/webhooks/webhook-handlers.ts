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
    const result = delivery.provider === 'strava' ? await this.strava(delivery, connection) : await this.garmin(delivery, connection);
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

  /**
   * Garmin Push carries the activity summary itself. Ping carries a callback
   * URL on Garmin's API host, fetched with the user's token.
   */
  private async garmin(delivery: WebhookDeliveryEntity, connection: ProviderConnectionEntity): Promise<HandlerResult> {
    switch (delivery.eventType) {
      case 'garmin.deregistration':
        await this.connections.markRevoked(connection.id, 'Fit was disconnected in Garmin Connect; connect again to resume imports');
        return { status: 'processed', outcome: 'connection deregistered at Garmin' };
      case 'garmin.permissions': {
        const permissions = Array.isArray(delivery.payload.permissions) ? delivery.payload.permissions.filter((p): p is string => typeof p === 'string') : [];
        const canRead = permissions.includes('ACTIVITY_EXPORT');
        await this.connections.recordOutcome(connection.id, {
          scopes: permissions,
          error: canRead ? null : 'Activity sharing was turned off in Garmin Connect; new activities will not arrive',
        });
        return { status: 'processed', outcome: `permissions now ${permissions.join(', ') || 'none'}` };
      }
      case 'garmin.activity':
        return this.importOne(connection, delivery.payload);
      case 'garmin.activity_ping': {
        const callbackUrl = String(delivery.payload.callbackURL);
        // Checked again inside the adapter; here it makes a forged URL a permanent failure instead of a retry
        if (!URL.canParse(callbackUrl) || new URL(callbackUrl).host !== this.registry.garmin.apiHost) {
          throw new PermanentDeliveryError('Garmin ping callback URL is not on the Garmin API host');
        }
        const token = await this.connections.accessToken(connection.id);
        const items = await this.registry.garmin.fetchCallback(token, callbackUrl);
        const counts: Record<string, number> = {};
        for (const item of items) {
          const { outcome } = await this.importOne(connection, item);
          counts[outcome] = (counts[outcome] ?? 0) + 1;
        }
        return {
          status: 'processed',
          outcome:
            Object.entries(counts)
              .map(([k, v]) => `${v} ${k}`)
              .join(', ') || 'no activities',
        };
      }
      default:
        return { status: 'ignored', outcome: `unhandled event type ${delivery.eventType}` };
    }
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
