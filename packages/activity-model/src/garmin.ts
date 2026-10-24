import { bool, id, isObject, latLng, nonNegative, num, positive, str } from './fields';
import { ActivityMappingError, type NormalizedActivity, type Sport } from './model';

/**
 * Garmin `activityType.typeKey` (upper-cased) → Fit sport. Garmin's list is long and
 * grows; anything unknown maps to "other" and keeps its original type.
 */
const GARMIN_SPORTS: Record<string, Sport> = {
  RUNNING: 'run',
  STREET_RUNNING: 'run',
  TRACK_RUNNING: 'run',
  TREADMILL_RUNNING: 'run',
  ULTRA_RUN: 'trail_run',
  TRAIL_RUNNING: 'trail_run',
  VIRTUAL_RUN: 'virtual_run',
  INDOOR_RUNNING: 'run',
  WALKING: 'walk',
  CASUAL_WALKING: 'walk',
  SPEED_WALKING: 'walk',
  HIKING: 'hike',
  CYCLING: 'ride',
  ROAD_BIKING: 'ride',
  TRACK_CYCLING: 'ride',
  RECUMBENT_CYCLING: 'ride',
  MOUNTAIN_BIKING: 'mountain_bike',
  GRAVEL_CYCLING: 'gravel_ride',
  CYCLOCROSS: 'gravel_ride',
  INDOOR_CYCLING: 'virtual_ride',
  VIRTUAL_RIDE: 'virtual_ride',
  E_BIKE_FITNESS: 'e_bike',
  E_BIKE_MOUNTAIN: 'e_bike',
  SWIMMING: 'swim',
  LAP_SWIMMING: 'swim',
  OPEN_WATER_SWIMMING: 'open_water_swim',
  ROWING: 'row',
  INDOOR_ROWING: 'row',
  STAND_UP_PADDLEBOARDING: 'paddle',
  KAYAKING: 'paddle',
  RESORT_SKIING_SNOWBOARDING: 'ski',
  RESORT_SKIING: 'ski',
  BACKCOUNTRY_SKIING: 'ski',
  CROSS_COUNTRY_SKIING: 'ski',
  SKATE_SKIING: 'ski',
  RESORT_SNOWBOARDING: 'snowboard',
  STRENGTH_TRAINING: 'strength',
  CARDIO_TRAINING: 'workout',
  HIIT: 'workout',
  ELLIPTICAL: 'workout',
  STAIR_CLIMBING: 'workout',
  INDOOR_CARDIO: 'workout',
  FITNESS_EQUIPMENT: 'workout',
  YOGA: 'yoga',
  PILATES: 'yoga',
  BOULDERING: 'climb',
  INDOOR_CLIMBING: 'climb',
  ROCK_CLIMBING: 'climb',
};

export function garminSport(activityType: string | null): Sport {
  return (activityType && GARMIN_SPORTS[activityType.toUpperCase()]) || 'other';
}

/** Garmin timestamps in activity lists look like "2026-08-24 06:30:00" (no zone). Returns epoch seconds, reading the text as UTC */
function parseNaive(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(value.trim());
  if (!m) return null;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) / 1000;
}

/**
 * Maps one item of the Garmin Connect Personal API activity list
 * (`GET /activitylist-service/activities/search/activities`) to a Fit
 * activity. The provider ID is Garmin's numeric `activityId`. Fields are read
 * defensively: anything missing or mistyped becomes null. The Personal API
 * does not publish response schemas in a machine-readable form, so field
 * names follow the Garmin Connect activity summary and are covered by
 * fixtures (see docs/providers/garmin.md).
 */
export function mapGarminActivity(raw: unknown): NormalizedActivity {
  if (!isObject(raw)) throw new ActivityMappingError('Garmin activity is not an object');
  const providerActivityId = id(raw.activityId);
  if (!providerActivityId) throw new ActivityMappingError('Garmin activity has no activityId');
  const gmt = parseNaive(raw.startTimeGMT);
  if (gmt === null) throw new ActivityMappingError(`Garmin activity ${providerActivityId} has no startTimeGMT`);
  const local = parseNaive(raw.startTimeLocal);
  const offset = local === null ? null : local - gmt;
  const typeKey = isObject(raw.activityType) ? str(raw.activityType.typeKey, 64) : str(raw.activityType, 64);
  const start = latLng(raw.startLatitude, raw.startLongitude);
  const duration = nonNegative(raw.elapsedDuration) ?? nonNegative(raw.duration);

  return {
    provider: 'garmin',
    providerActivityId,
    name: str(raw.activityName, 500),
    sport: garminSport(typeKey),
    providerSportType: typeKey,
    startTime: new Date(gmt * 1000).toISOString(),
    startTimeLocal: local === null ? null : new Date(local * 1000).toISOString().replace(/\.\d{3}Z$/, ''),
    timezone: null,
    utcOffsetSeconds: offset,
    elapsedTimeSeconds: duration,
    movingTimeSeconds: nonNegative(raw.movingDuration),
    distanceMeters: nonNegative(raw.distance),
    elevationGainMeters: nonNegative(raw.elevationGain),
    averageSpeedMps: nonNegative(raw.averageSpeed),
    maxSpeedMps: nonNegative(raw.maxSpeed),
    averageHeartRate: positive(raw.averageHR),
    maxHeartRate: positive(raw.maxHR),
    averagePowerWatts: positive(raw.avgPower),
    averageCadence:
      positive(raw.averageRunningCadenceInStepsPerMinute) ?? positive(raw.averageBikingCadenceInRevPerMinute) ?? positive(raw.averageSwimCadenceInStrokesPerMinute),
    calories: positive(raw.calories),
    deviceName: str(raw.deviceName, 255) ?? str(raw.manufacturer, 255),
    manual: bool(raw.manualActivity) ?? false,
    private: bool(raw.privacy) ?? null,
    startLatitude: start.lat,
    startLongitude: start.lng,
  };
}
