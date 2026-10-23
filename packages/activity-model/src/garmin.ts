import { bool, id, isObject, latLng, nonNegative, num, positive, str } from './fields';
import { ActivityMappingError, type NormalizedActivity, type Sport } from './model';

/**
 * Garmin Activity API `activityType` → Fit sport. Garmin's list is long and
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

/** The local wall-clock time of a UTC instant shifted by an offset, ISO 8601 without zone */
function wallClock(epochSeconds: number, offsetSeconds: number | null): string | null {
  if (offsetSeconds === null) return null;
  return new Date((epochSeconds + offsetSeconds) * 1000).toISOString().replace(/\.\d{3}Z$/, '');
}

/**
 * Maps a Garmin Activity API activity summary (as delivered by Push, or
 * returned by a Ping callback URL) to a Fit activity. The provider ID is
 * Garmin's `summaryId`, the key Garmin uses for de-duplication; `activityId`
 * stays available in the raw payload.
 */
export function mapGarminActivity(raw: unknown): NormalizedActivity {
  if (!isObject(raw)) throw new ActivityMappingError('Garmin activity is not an object');
  const providerActivityId = id(raw.summaryId) ?? id(raw.activityId);
  if (!providerActivityId) throw new ActivityMappingError('Garmin activity has no summaryId');
  const startSeconds = num(raw.startTimeInSeconds);
  if (startSeconds === null) throw new ActivityMappingError(`Garmin activity ${providerActivityId} has no startTimeInSeconds`);
  const offset = num(raw.startTimeOffsetInSeconds);
  const providerSportType = str(raw.activityType, 64);
  const start = latLng(raw.startingLatitudeInDegree, raw.startingLongitudeInDegree);
  const duration = nonNegative(raw.durationInSeconds);

  return {
    provider: 'garmin',
    providerActivityId,
    name: str(raw.activityName, 500) ?? str(raw.activityDescription, 500),
    sport: garminSport(providerSportType),
    providerSportType,
    startTime: new Date(startSeconds * 1000).toISOString(),
    startTimeLocal: wallClock(startSeconds, offset),
    timezone: null,
    utcOffsetSeconds: offset,
    elapsedTimeSeconds: duration,
    movingTimeSeconds: nonNegative(raw.movingDurationInSeconds),
    distanceMeters: nonNegative(raw.distanceInMeters),
    elevationGainMeters: nonNegative(raw.totalElevationGainInMeters),
    averageSpeedMps: nonNegative(raw.averageSpeedInMetersPerSecond),
    maxSpeedMps: nonNegative(raw.maxSpeedInMetersPerSecond),
    averageHeartRate: positive(raw.averageHeartRateInBeatsPerMinute),
    maxHeartRate: positive(raw.maxHeartRateInBeatsPerMinute),
    averagePowerWatts: positive(raw.averagePowerInWatts),
    averageCadence:
      positive(raw.averageRunCadenceInStepsPerMinute) ??
      positive(raw.averageBikeCadenceInRoundsPerMinute) ??
      positive(raw.averageSwimCadenceInStrokesPerMinute),
    calories: positive(raw.activeKilocalories),
    deviceName: str(raw.deviceName, 255),
    manual: bool(raw.manual) ?? false,
    private: null,
    startLatitude: start.lat,
    startLongitude: start.lng,
  };
}
