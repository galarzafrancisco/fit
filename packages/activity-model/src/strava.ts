import { bool, id, isObject, isoInstant, latLng, nonNegative, num, positive, str } from './fields';
import { ActivityMappingError, type NormalizedActivity, type Sport } from './model';

/**
 * Strava `sport_type` (falling back to the legacy `type`) → Fit sport.
 * https://developers.strava.com/docs/reference/#api-models-SportType
 */
const STRAVA_SPORTS: Record<string, Sport> = {
  Run: 'run',
  TrailRun: 'trail_run',
  VirtualRun: 'virtual_run',
  Walk: 'walk',
  Hike: 'hike',
  Snowshoe: 'hike',
  Ride: 'ride',
  Handcycle: 'ride',
  Velomobile: 'ride',
  MountainBikeRide: 'mountain_bike',
  EMountainBikeRide: 'e_bike',
  EBikeRide: 'e_bike',
  GravelRide: 'gravel_ride',
  VirtualRide: 'virtual_ride',
  Swim: 'swim',
  Rowing: 'row',
  VirtualRow: 'row',
  Canoeing: 'paddle',
  Kayaking: 'paddle',
  StandUpPaddling: 'paddle',
  AlpineSki: 'ski',
  BackcountrySki: 'ski',
  NordicSki: 'ski',
  RollerSki: 'ski',
  Snowboard: 'snowboard',
  WeightTraining: 'strength',
  Crossfit: 'workout',
  HighIntensityIntervalTraining: 'workout',
  Elliptical: 'workout',
  StairStepper: 'workout',
  Workout: 'workout',
  Pilates: 'yoga',
  Yoga: 'yoga',
  RockClimbing: 'climb',
};

export function stravaSport(sportType: string | null): Sport {
  return (sportType && STRAVA_SPORTS[sportType]) || 'other';
}

/** Strava's timezone looks like "(GMT+10:00) Australia/Sydney"; the IANA name is the last token */
export function stravaTimezone(value: unknown): string | null {
  const raw = str(value, 100);
  if (!raw) return null;
  const zone = raw.replace(/^\([^)]*\)\s*/, '').trim();
  return /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(zone) ? zone : null;
}

/** Strava's start_date_local is wall-clock time wrongly suffixed with "Z"; drop the suffix */
function localWallClock(value: unknown): string | null {
  const raw = str(value, 40);
  if (!raw || Number.isNaN(Date.parse(raw))) return null;
  return raw.replace(/Z$/, '');
}

/**
 * Maps a Strava activity (summary or detailed representation) to a Fit
 * activity. Throws ActivityMappingError when there is no usable ID or start.
 */
export function mapStravaActivity(raw: unknown): NormalizedActivity {
  if (!isObject(raw)) throw new ActivityMappingError('Strava activity is not an object');
  const providerActivityId = id(raw.id);
  if (!providerActivityId) throw new ActivityMappingError('Strava activity has no id');
  const startTime = isoInstant(raw.start_date);
  if (!startTime) throw new ActivityMappingError(`Strava activity ${providerActivityId} has no start_date`);
  const providerSportType = str(raw.sport_type, 64) ?? str(raw.type, 64);
  const start = Array.isArray(raw.start_latlng) ? latLng(raw.start_latlng[0], raw.start_latlng[1]) : { lat: null, lng: null };
  const kilojoules = positive(raw.kilojoules);

  return {
    provider: 'strava',
    providerActivityId,
    name: str(raw.name, 500),
    sport: stravaSport(providerSportType),
    providerSportType,
    startTime,
    startTimeLocal: localWallClock(raw.start_date_local),
    timezone: stravaTimezone(raw.timezone),
    utcOffsetSeconds: num(raw.utc_offset),
    elapsedTimeSeconds: nonNegative(raw.elapsed_time),
    movingTimeSeconds: nonNegative(raw.moving_time),
    distanceMeters: nonNegative(raw.distance),
    elevationGainMeters: nonNegative(raw.total_elevation_gain),
    averageSpeedMps: nonNegative(raw.average_speed),
    maxSpeedMps: nonNegative(raw.max_speed),
    averageHeartRate: positive(raw.average_heartrate),
    maxHeartRate: positive(raw.max_heartrate),
    averagePowerWatts: positive(raw.average_watts),
    averageCadence: positive(raw.average_cadence),
    // `calories` is only on the detailed representation; for rides Strava reports work in kJ, roughly 1:1 with kcal burned
    calories: positive(raw.calories) ?? (kilojoules !== null ? Math.round(kilojoules) : null),
    deviceName: str(raw.device_name, 255),
    manual: bool(raw.manual) ?? false,
    private: bool(raw.private),
    startLatitude: start.lat,
    startLongitude: start.lng,
  };
}
