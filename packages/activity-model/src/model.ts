/**
 * The provider-neutral activity shape Fit stores and serves. Every field a
 * provider does not report is null; nothing is invented. The provider's own
 * payload is kept alongside (lossless), so this shape can grow without
 * re-importing anything.
 */

export const PROVIDERS = ['strava', 'garmin'] as const;
export type Provider = (typeof PROVIDERS)[number];

export function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}

/**
 * Fit's sport taxonomy. Deliberately coarse so filters work across
 * providers; the provider's exact type is kept in `providerSportType`.
 */
export const SPORTS = [
  'run',
  'trail_run',
  'virtual_run',
  'walk',
  'hike',
  'ride',
  'mountain_bike',
  'gravel_ride',
  'virtual_ride',
  'e_bike',
  'swim',
  'open_water_swim',
  'row',
  'paddle',
  'ski',
  'snowboard',
  'strength',
  'workout',
  'yoga',
  'climb',
  'other',
] as const;
export type Sport = (typeof SPORTS)[number];

export function isSport(value: unknown): value is Sport {
  return typeof value === 'string' && (SPORTS as readonly string[]).includes(value);
}

/** Broader groups of sports, for summaries ("how much did I cycle") */
export const SPORT_GROUPS = {
  running: ['run', 'trail_run', 'virtual_run'],
  walking: ['walk', 'hike'],
  cycling: ['ride', 'mountain_bike', 'gravel_ride', 'virtual_ride', 'e_bike'],
  swimming: ['swim', 'open_water_swim'],
  water: ['row', 'paddle'],
  winter: ['ski', 'snowboard'],
  gym: ['strength', 'workout', 'yoga', 'climb'],
  other: ['other'],
} as const satisfies Record<string, readonly Sport[]>;
export type SportGroup = keyof typeof SPORT_GROUPS;
export const SPORT_GROUP_NAMES = Object.keys(SPORT_GROUPS) as SportGroup[];

export function sportGroupOf(sport: Sport): SportGroup {
  for (const group of SPORT_GROUP_NAMES) {
    if ((SPORT_GROUPS[group] as readonly Sport[]).includes(sport)) return group;
  }
  return 'other';
}

export type NormalizedActivity = {
  provider: Provider;
  /** The provider's ID for this activity, as a string (Strava activity id, Garmin summaryId) */
  providerActivityId: string;
  name: string | null;
  sport: Sport;
  /** The provider's own type string, unmodified (e.g. Strava "TrailRun", Garmin "TRAIL_RUNNING") */
  providerSportType: string | null;
  /** Start instant, ISO 8601 UTC */
  startTime: string;
  /** Wall-clock start at the activity's location, ISO 8601 without offset, when the provider gives it */
  startTimeLocal: string | null;
  /** IANA zone when known, else null */
  timezone: string | null;
  /** UTC offset at the start, in seconds, when known */
  utcOffsetSeconds: number | null;
  elapsedTimeSeconds: number | null;
  movingTimeSeconds: number | null;
  distanceMeters: number | null;
  elevationGainMeters: number | null;
  averageSpeedMps: number | null;
  maxSpeedMps: number | null;
  averageHeartRate: number | null;
  maxHeartRate: number | null;
  averagePowerWatts: number | null;
  averageCadence: number | null;
  calories: number | null;
  deviceName: string | null;
  /** Entered by hand rather than recorded by a device */
  manual: boolean;
  /** Provider privacy flag, when the provider has one */
  private: boolean | null;
  startLatitude: number | null;
  startLongitude: number | null;
};

/** A provider payload that cannot be turned into an activity (missing ID or start time) */
export class ActivityMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActivityMappingError';
  }
}
