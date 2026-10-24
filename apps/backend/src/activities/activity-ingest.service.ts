import { contentHash, type NormalizedActivity, type Provider } from '@fit/activity-model';
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { IsNull, type EntityManager } from 'typeorm';
import { UnitOfWork } from '../database/unit-of-work';
import { ProviderRegistry } from '../providers/provider-registry';
import { ActivityEntity, ActivityPayloadEntity, type ActivitySource } from './activity.entities';

export type IngestOutcome = 'created' | 'updated' | 'unchanged';

/** Measurements that keep their previous value when a newer payload omits them (e.g. Strava summary vs detailed) */
const MERGED_METRICS = [
  'elapsedTimeSeconds',
  'movingTimeSeconds',
  'distanceMeters',
  'elevationGainMeters',
  'averageSpeedMps',
  'maxSpeedMps',
  'averageHeartRate',
  'maxHeartRate',
  'averagePowerWatts',
  'averageCadence',
  'calories',
  'deviceName',
  'timezone',
  'utcOffsetSeconds',
  'startTimeLocal',
  'startLatitude',
  'startLongitude',
] as const satisfies readonly (keyof NormalizedActivity & keyof ActivityEntity)[];

/** Fields that never belong in stored payloads (old Garmin pushes carried a user access token) */
const SENSITIVE_PAYLOAD_KEYS = ['userAccessToken', 'access_token', 'refresh_token'];

export function scrubPayload(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([key]) => !SENSITIVE_PAYLOAD_KEYS.includes(key)));
}

/**
 * The single write path for activities, used by syncs and webhooks alike.
 * Idempotent: the same payload twice is "unchanged"; a new version updates
 * the normalized columns and is appended to activity_payloads. Concurrent
 * imports of one activity serialize on its unique key and row lock.
 */
@Injectable()
export class ActivityIngestService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly registry: ProviderRegistry,
  ) {}

  /** Throws ActivityMappingError when the payload is not a usable activity */
  async ingest(input: {
    userId: string;
    connectionId: string | null;
    provider: Provider;
    raw: unknown;
    source: ActivitySource;
  }): Promise<{ activityId: string; outcome: IngestOutcome }> {
    const raw = scrubPayload(input.raw);
    const normalized = this.registry.get(input.provider).normalize(raw);
    const hash = contentHash(raw);
    return this.uow.run(async (manager) => {
      const now = new Date();
      const inserted = await manager
        .createQueryBuilder()
        .insert()
        .into(ActivityEntity)
        .values({
          ...columns(normalized),
          id: randomUUID(),
          userId: input.userId,
          connectionId: input.connectionId,
          provider: input.provider,
          providerActivityId: normalized.providerActivityId,
          raw: raw as never,
          rawHash: hash,
          firstSource: input.source,
          lastSource: input.source,
          firstImportedAt: now,
          lastImportedAt: now,
          deletedAt: null,
        })
        .orIgnore()
        .returning(['id'])
        .execute();
      const createdId = (inserted.raw as Array<{ id: string }>)[0]?.id;
      if (createdId) {
        await this.addPayload(manager, createdId, input.userId, raw, hash, input.source, now);
        return { activityId: createdId, outcome: 'created' as const };
      }

      const existing = await manager.findOne(ActivityEntity, {
        where: { userId: input.userId, provider: input.provider, providerActivityId: normalized.providerActivityId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!existing) throw new Error('Activity vanished during ingest');
      if (existing.rawHash === hash && existing.deletedAt === null) return { activityId: existing.id, outcome: 'unchanged' as const };

      const next = columns(normalized);
      for (const key of MERGED_METRICS) {
        if (next[key] === null) (next as Record<string, unknown>)[key] = existing[key];
      }
      Object.assign(existing, next, {
        connectionId: input.connectionId ?? existing.connectionId,
        raw,
        rawHash: hash,
        lastSource: input.source,
        lastImportedAt: now,
        deletedAt: null,
      });
      await manager.save(ActivityEntity, existing);
      await this.addPayload(manager, existing.id, input.userId, raw, hash, input.source, now);
      return { activityId: existing.id, outcome: 'updated' as const };
    });
  }

  /** The provider deleted the activity (or it is no longer visible): keep the row, mark it deleted */
  async markDeleted(userId: string, provider: Provider, providerActivityId: string): Promise<boolean> {
    const result = await this.uow.manager.update(ActivityEntity, { userId, provider, providerActivityId, deletedAt: IsNull() }, { deletedAt: new Date() });
    return (result.affected ?? 0) > 0;
  }

  private async addPayload(
    manager: EntityManager,
    activityId: string,
    userId: string,
    payload: Record<string, unknown>,
    hash: string,
    source: ActivitySource,
    at: Date,
  ) {
    await manager
      .createQueryBuilder()
      .insert()
      .into(ActivityPayloadEntity)
      .values({ id: randomUUID(), activityId, userId, payload: payload as never, payloadHash: hash, source, receivedAt: at })
      .orIgnore()
      .execute();
  }
}

function columns(n: NormalizedActivity) {
  return {
    name: n.name,
    sport: n.sport,
    providerSportType: n.providerSportType,
    startTime: new Date(n.startTime),
    startTimeLocal: n.startTimeLocal,
    timezone: n.timezone,
    utcOffsetSeconds: n.utcOffsetSeconds === null ? null : Math.round(n.utcOffsetSeconds),
    elapsedTimeSeconds: n.elapsedTimeSeconds,
    movingTimeSeconds: n.movingTimeSeconds,
    distanceMeters: n.distanceMeters,
    elevationGainMeters: n.elevationGainMeters,
    averageSpeedMps: n.averageSpeedMps,
    maxSpeedMps: n.maxSpeedMps,
    averageHeartRate: n.averageHeartRate,
    maxHeartRate: n.maxHeartRate,
    averagePowerWatts: n.averagePowerWatts,
    averageCadence: n.averageCadence,
    calories: n.calories,
    deviceName: n.deviceName,
    manual: n.manual,
    private: n.private,
    startLatitude: n.startLatitude,
    startLongitude: n.startLongitude,
  };
}
