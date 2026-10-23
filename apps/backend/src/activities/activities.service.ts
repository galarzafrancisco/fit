import { SPORT_GROUPS, sportGroupOf, type Sport, type SportGroup } from '@fit/activity-model';
import { Injectable } from '@nestjs/common';
import type { SelectQueryBuilder } from 'typeorm';
import { NotFoundError, ValidationError } from '../common/errors';
import { isUuid, parseInput } from '../common/validation';
import { UnitOfWork } from '../database/unit-of-work';
import type { CurrentUser } from '../users/users.service';
import { ActivityEntity, ActivityPayloadEntity } from './activity.entities';
import { getActivitySchema, listActivitiesSchema, summarySchema, type ListActivitiesInput, type SummaryInput } from './activities.schemas';

export type ActivityView = {
  id: string;
  provider: ActivityEntity['provider'];
  providerActivityId: string;
  name: string | null;
  sport: Sport;
  sportGroup: SportGroup;
  providerSportType: string | null;
  startTime: string;
  startTimeLocal: string | null;
  timezone: string | null;
  distanceMeters: number | null;
  distanceKm: number | null;
  movingTimeSeconds: number | null;
  elapsedTimeSeconds: number | null;
  elevationGainMeters: number | null;
  averageSpeedKmh: number | null;
  /** Moving time per km, for foot sports; null otherwise */
  averagePaceSecondsPerKm: number | null;
  averageHeartRate: number | null;
  calories: number | null;
  deleted: boolean;
};

export type ActivityDetailView = ActivityView & {
  maxSpeedKmh: number | null;
  maxHeartRate: number | null;
  averagePowerWatts: number | null;
  averageCadence: number | null;
  deviceName: string | null;
  manual: boolean;
  private: boolean | null;
  startLatitude: number | null;
  startLongitude: number | null;
  utcOffsetSeconds: number | null;
  providerUrl: string | null;
  provenance: { firstSource: string; lastSource: string; firstImportedAt: string; lastImportedAt: string; deletedAt: string | null; payloadVersions: number };
  raw?: Record<string, unknown>;
  history?: Array<{ source: string; receivedAt: string; payloadHash: string; payload: Record<string, unknown> }>;
};

export type SummaryGroup = {
  key: string;
  count: number;
  distanceMeters: number;
  distanceKm: number;
  movingTimeSeconds: number;
  movingTimeHours: number;
  elapsedTimeSeconds: number;
  elevationGainMeters: number;
  calories: number;
  longestDistanceMeters: number;
};

const PACE_GROUPS: SportGroup[] = ['running', 'walking'];

/** Read side for activities. Every query is scoped to the calling user; another user's activity is "not found" */
@Injectable()
export class ActivitiesService {
  constructor(private readonly uow: UnitOfWork) {}

  async list(user: CurrentUser, input: unknown): Promise<{ items: ActivityView[]; nextCursor: string | null }> {
    const args = parseInput(listActivitiesSchema, input);
    const limit = args.limit ?? 25;
    const qb = this.filtered(user, args);
    if (args.search) qb.andWhere('a.name ILIKE :search', { search: `%${args.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%` });
    if (args.minDistanceMeters !== undefined) qb.andWhere('a.distanceMeters >= :minDistance', { minDistance: args.minDistanceMeters });
    if (!args.includeDeleted) qb.andWhere('a.deletedAt IS NULL');
    if (args.cursor) {
      const cursor = decodeCursor(args.cursor);
      qb.andWhere('(a.startTime < :cursorTime OR (a.startTime = :cursorTime AND a.id < :cursorId))', { cursorTime: cursor.startTime, cursorId: cursor.id });
    }
    const rows = await qb
      .orderBy('a.startTime', 'DESC')
      .addOrderBy('a.id', 'DESC')
      .take(limit + 1)
      .getMany();
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page.map(toView), nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
  }

  async get(user: CurrentUser, input: unknown): Promise<ActivityDetailView> {
    const { activityId, includeRaw, includeHistory } = parseInput(getActivitySchema, input);
    if (!isUuid(activityId)) throw new NotFoundError('Activity not found');
    const activity = await this.uow.manager.findOne(ActivityEntity, { where: { id: activityId, userId: user.id } });
    if (!activity) throw new NotFoundError('Activity not found');
    const payloads = await this.uow.manager.find(ActivityPayloadEntity, { where: { activityId: activity.id, userId: user.id }, order: { receivedAt: 'ASC' } });
    const detail: ActivityDetailView = {
      ...toView(activity),
      maxSpeedKmh: kmh(activity.maxSpeedMps),
      maxHeartRate: activity.maxHeartRate,
      averagePowerWatts: activity.averagePowerWatts,
      averageCadence: activity.averageCadence,
      deviceName: activity.deviceName,
      manual: activity.manual,
      private: activity.private,
      startLatitude: activity.startLatitude,
      startLongitude: activity.startLongitude,
      utcOffsetSeconds: activity.utcOffsetSeconds,
      providerUrl: providerUrl(activity),
      provenance: {
        firstSource: activity.firstSource,
        lastSource: activity.lastSource,
        firstImportedAt: activity.firstImportedAt.toISOString(),
        lastImportedAt: activity.lastImportedAt.toISOString(),
        deletedAt: activity.deletedAt?.toISOString() ?? null,
        payloadVersions: payloads.length,
      },
    };
    if (includeRaw) detail.raw = activity.raw;
    if (includeHistory) {
      detail.history = payloads.map((p) => ({ source: p.source, receivedAt: p.receivedAt.toISOString(), payloadHash: p.payloadHash, payload: p.payload }));
    }
    return detail;
  }

  async summary(user: CurrentUser, input: unknown): Promise<{ from: string | null; to: string | null; groupBy: string; totals: SummaryGroup; groups: SummaryGroup[] }> {
    const args = parseInput(summarySchema, input);
    const groupBy = args.groupBy ?? 'sport';
    const qb = this.filtered(user, args).andWhere('a.deletedAt IS NULL');
    const keyExpression: Record<string, string> = {
      none: `'all'`,
      sport: 'a.sport',
      sport_group: 'a.sport',
      provider: 'a.provider',
      day: `to_char(a.start_time AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
      week: `to_char(date_trunc('week', a.start_time AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
      month: `to_char(a.start_time AT TIME ZONE 'UTC', 'YYYY-MM')`,
      year: `to_char(a.start_time AT TIME ZONE 'UTC', 'YYYY')`,
    };
    const rows: Array<Record<string, string | null>> = await qb
      .select(keyExpression[groupBy], 'key')
      .addSelect('count(*)', 'count')
      .addSelect('coalesce(sum(a.distance_meters), 0)', 'distance')
      .addSelect('coalesce(sum(a.moving_time_seconds), 0)', 'moving')
      .addSelect('coalesce(sum(a.elapsed_time_seconds), 0)', 'elapsed')
      .addSelect('coalesce(sum(a.elevation_gain_meters), 0)', 'elevation')
      .addSelect('coalesce(sum(a.calories), 0)', 'calories')
      .addSelect('coalesce(max(a.distance_meters), 0)', 'longest')
      .groupBy('1')
      .orderBy('1', 'ASC')
      .getRawMany();

    let groups = rows.map((row) => group(String(row.key), Number(row.count), Number(row.distance), Number(row.moving), Number(row.elapsed), Number(row.elevation), Number(row.calories), Number(row.longest)));
    if (groupBy === 'sport_group') {
      const merged = new Map<string, SummaryGroup>();
      for (const g of groups) {
        const key = sportGroupOf(g.key as Sport);
        merged.set(key, merge(merged.get(key) ?? empty(key), g));
      }
      groups = [...merged.values()].sort((a, b) => a.key.localeCompare(b.key));
    }
    const totals = groups.reduce((acc, g) => merge(acc, g), empty('total'));
    const range = dateRange(args);
    return { from: range.from?.toISOString() ?? null, to: range.to?.toISOString() ?? null, groupBy, totals, groups };
  }

  private filtered(user: CurrentUser, args: Pick<ListActivitiesInput, 'from' | 'to' | 'provider' | 'sport' | 'sportGroup'>): SelectQueryBuilder<ActivityEntity> {
    const qb = this.uow.manager.createQueryBuilder(ActivityEntity, 'a').where('a.userId = :userId', { userId: user.id });
    const range = dateRange(args);
    if (range.from && range.to && range.from >= range.to) throw new ValidationError('from must be before to');
    if (range.from) qb.andWhere('a.startTime >= :from', { from: range.from });
    if (range.to) qb.andWhere('a.startTime < :to', { to: range.to });
    if (args.provider) qb.andWhere('a.provider = :provider', { provider: args.provider });
    const sports = new Set<string>();
    if (args.sport) for (const s of Array.isArray(args.sport) ? args.sport : [args.sport]) sports.add(s);
    if (args.sportGroup) {
      const inGroup = SPORT_GROUPS[args.sportGroup as SportGroup] as readonly string[];
      if (sports.size) {
        for (const s of [...sports]) if (!inGroup.includes(s)) sports.delete(s);
        if (!sports.size) qb.andWhere('false');
      } else {
        inGroup.forEach((s) => sports.add(s));
      }
    }
    if (sports.size) qb.andWhere('a.sport IN (:...sports)', { sports: [...sports] });
    return qb;
  }
}

function dateRange(args: { from?: string; to?: string }): { from: Date | null; to: Date | null } {
  const dayOnly = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
  const from = args.from ? new Date(dayOnly(args.from) ? `${args.from}T00:00:00Z` : args.from) : null;
  let to: Date | null = null;
  if (args.to) {
    to = new Date(dayOnly(args.to) ? `${args.to}T00:00:00Z` : args.to);
    if (dayOnly(args.to)) to = new Date(to.getTime() + 86_400_000);
  }
  return { from, to };
}

function toView(a: ActivityEntity): ActivityView {
  const group = sportGroupOf(a.sport);
  return {
    id: a.id,
    provider: a.provider,
    providerActivityId: a.providerActivityId,
    name: a.name,
    sport: a.sport,
    sportGroup: group,
    providerSportType: a.providerSportType,
    startTime: a.startTime.toISOString(),
    startTimeLocal: a.startTimeLocal,
    timezone: a.timezone,
    distanceMeters: a.distanceMeters,
    distanceKm: a.distanceMeters === null ? null : round(a.distanceMeters / 1000, 2),
    movingTimeSeconds: a.movingTimeSeconds,
    elapsedTimeSeconds: a.elapsedTimeSeconds,
    elevationGainMeters: a.elevationGainMeters,
    averageSpeedKmh: kmh(a.averageSpeedMps),
    averagePaceSecondsPerKm:
      PACE_GROUPS.includes(group) && a.distanceMeters && a.distanceMeters > 0 && (a.movingTimeSeconds ?? a.elapsedTimeSeconds)
        ? Math.round(((a.movingTimeSeconds ?? a.elapsedTimeSeconds)! / a.distanceMeters) * 1000)
        : null,
    averageHeartRate: a.averageHeartRate,
    calories: a.calories,
    deleted: a.deletedAt !== null,
  };
}

function providerUrl(a: ActivityEntity): string | null {
  if (a.provider === 'strava') return `https://www.strava.com/activities/${a.providerActivityId}`;
  const garminId = a.raw.activityId;
  return typeof garminId === 'number' || typeof garminId === 'string' ? `https://connect.garmin.com/modern/activity/${garminId}` : null;
}

function kmh(mps: number | null): number | null {
  return mps === null ? null : round(mps * 3.6, 2);
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function group(key: string, count: number, distance: number, moving: number, elapsed: number, elevation: number, calories: number, longest: number): SummaryGroup {
  return {
    key,
    count,
    distanceMeters: round(distance, 1),
    distanceKm: round(distance / 1000, 2),
    movingTimeSeconds: Math.round(moving),
    movingTimeHours: round(moving / 3600, 2),
    elapsedTimeSeconds: Math.round(elapsed),
    elevationGainMeters: round(elevation, 1),
    calories: Math.round(calories),
    longestDistanceMeters: round(longest, 1),
  };
}

function empty(key: string): SummaryGroup {
  return group(key, 0, 0, 0, 0, 0, 0, 0);
}

function merge(a: SummaryGroup, b: SummaryGroup): SummaryGroup {
  return group(
    a.key,
    a.count + b.count,
    a.distanceMeters + b.distanceMeters,
    a.movingTimeSeconds + b.movingTimeSeconds,
    a.elapsedTimeSeconds + b.elapsedTimeSeconds,
    a.elevationGainMeters + b.elevationGainMeters,
    a.calories + b.calories,
    Math.max(a.longestDistanceMeters, b.longestDistanceMeters),
  );
}

function encodeCursor(a: ActivityEntity): string {
  return Buffer.from(JSON.stringify([a.startTime.toISOString(), a.id])).toString('base64url');
}

function decodeCursor(cursor: string): { startTime: Date; id: string } {
  try {
    const [startTime, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [string, string];
    const date = new Date(startTime);
    if (Number.isNaN(date.getTime()) || typeof id !== 'string' || !isUuid(id)) throw new Error('bad cursor');
    return { startTime: date, id };
  } catch {
    throw new ValidationError('cursor is invalid; pass nextCursor from the previous page unchanged');
  }
}
