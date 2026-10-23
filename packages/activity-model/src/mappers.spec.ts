import { ActivityMappingError, canonicalJson, contentHash, garminSport, mapGarminActivity, mapStravaActivity, sportGroupOf, stravaSport, stravaTimezone } from './index';

const stravaRun = {
  id: 12345678987654,
  name: 'Morning Run',
  distance: 10012.4,
  moving_time: 2950,
  elapsed_time: 3010,
  total_elevation_gain: 88.2,
  type: 'Run',
  sport_type: 'TrailRun',
  start_date: '2026-10-20T19:30:00Z',
  start_date_local: '2026-10-21T06:30:00Z',
  timezone: '(GMT+11:00) Australia/Sydney',
  utc_offset: 39600,
  start_latlng: [-33.86, 151.2],
  average_speed: 3.39,
  max_speed: 5.1,
  average_heartrate: 151.3,
  max_heartrate: 178,
  average_cadence: 84,
  device_name: 'Garmin Forerunner 965',
  manual: false,
  private: true,
};

describe('mapStravaActivity', () => {
  it('maps a detailed activity without losing reported fields', () => {
    const activity = mapStravaActivity(stravaRun);
    expect(activity).toMatchObject({
      provider: 'strava',
      providerActivityId: '12345678987654',
      name: 'Morning Run',
      sport: 'trail_run',
      providerSportType: 'TrailRun',
      startTime: '2026-10-20T19:30:00.000Z',
      startTimeLocal: '2026-10-21T06:30:00',
      timezone: 'Australia/Sydney',
      utcOffsetSeconds: 39600,
      elapsedTimeSeconds: 3010,
      movingTimeSeconds: 2950,
      distanceMeters: 10012.4,
      averageHeartRate: 151.3,
      maxHeartRate: 178,
      averagePowerWatts: null,
      deviceName: 'Garmin Forerunner 965',
      manual: false,
      private: true,
      startLatitude: -33.86,
      startLongitude: 151.2,
    });
  });

  it('falls back to the legacy type and to "other" for unknown sports', () => {
    expect(mapStravaActivity({ ...stravaRun, sport_type: undefined, type: 'Ride' }).sport).toBe('ride');
    expect(mapStravaActivity({ ...stravaRun, sport_type: 'Pickleball' }).sport).toBe('other');
    expect(mapStravaActivity({ ...stravaRun, sport_type: 'Pickleball' }).providerSportType).toBe('Pickleball');
  });

  it('uses kilojoules as calories when calories are absent', () => {
    expect(mapStravaActivity({ ...stravaRun, kilojoules: 612.6 }).calories).toBe(613);
    expect(mapStravaActivity({ ...stravaRun, kilojoules: 612.6, calories: 700 }).calories).toBe(700);
  });

  it('treats zero heart rate and power as not measured', () => {
    const activity = mapStravaActivity({ ...stravaRun, average_heartrate: 0, average_watts: 0 });
    expect(activity.averageHeartRate).toBeNull();
    expect(activity.averagePowerWatts).toBeNull();
  });

  it('drops invalid coordinates and wrong-typed fields instead of failing', () => {
    const activity = mapStravaActivity({ ...stravaRun, start_latlng: [], distance: 'far', name: 42 });
    expect(activity.startLatitude).toBeNull();
    expect(activity.distanceMeters).toBeNull();
    expect(activity.name).toBeNull();
  });

  it('refuses payloads without an id or start', () => {
    expect(() => mapStravaActivity(null)).toThrow(ActivityMappingError);
    expect(() => mapStravaActivity({ ...stravaRun, id: undefined })).toThrow(/no id/);
    expect(() => mapStravaActivity({ ...stravaRun, id: 1.5 })).toThrow(/no id/);
    expect(() => mapStravaActivity({ ...stravaRun, start_date: 'yesterday' })).toThrow(/no start_date/);
  });
});

describe('stravaTimezone / stravaSport', () => {
  it('extracts the IANA zone', () => {
    expect(stravaTimezone('(GMT-08:00) America/Los_Angeles')).toBe('America/Los_Angeles');
    expect(stravaTimezone('(GMT+00:00) Etc/UTC')).toBe('Etc/UTC');
    expect(stravaTimezone('nonsense here')).toBeNull();
    expect(stravaTimezone(undefined)).toBeNull();
  });

  it('maps known sport types', () => {
    expect(stravaSport('VirtualRide')).toBe('virtual_ride');
    expect(stravaSport('WeightTraining')).toBe('strength');
    expect(stravaSport(null)).toBe('other');
  });
});

const garminRun = {
  userId: 'garmin-user-1',
  summaryId: '5001968355',
  activityId: 5001968355,
  activityName: 'Sydney Running',
  activityType: 'RUNNING',
  startTimeInSeconds: 1761000000,
  startTimeOffsetInSeconds: 39600,
  durationInSeconds: 3000,
  distanceInMeters: 10000,
  averageSpeedInMetersPerSecond: 3.33,
  maxSpeedInMetersPerSecond: 4.9,
  averageHeartRateInBeatsPerMinute: 150,
  maxHeartRateInBeatsPerMinute: 176,
  averageRunCadenceInStepsPerMinute: 170,
  activeKilocalories: 690,
  totalElevationGainInMeters: 40,
  deviceName: 'forerunner965',
  startingLatitudeInDegree: -33.86,
  startingLongitudeInDegree: 151.2,
};

describe('mapGarminActivity', () => {
  it('maps an activity summary', () => {
    expect(mapGarminActivity(garminRun)).toMatchObject({
      provider: 'garmin',
      providerActivityId: '5001968355',
      name: 'Sydney Running',
      sport: 'run',
      providerSportType: 'RUNNING',
      startTime: new Date(1761000000 * 1000).toISOString(),
      startTimeLocal: new Date((1761000000 + 39600) * 1000).toISOString().replace(/\.\d{3}Z$/, ''),
      utcOffsetSeconds: 39600,
      elapsedTimeSeconds: 3000,
      distanceMeters: 10000,
      averageCadence: 170,
      calories: 690,
      private: null,
    });
  });

  it('falls back to activityId and maps unknown types to other', () => {
    const activity = mapGarminActivity({ ...garminRun, summaryId: undefined, activityType: 'SKY_DIVING' });
    expect(activity.providerActivityId).toBe('5001968355');
    expect(activity.sport).toBe('other');
  });

  it('refuses payloads without an id or start', () => {
    expect(() => mapGarminActivity({ ...garminRun, summaryId: undefined, activityId: undefined })).toThrow(ActivityMappingError);
    expect(() => mapGarminActivity({ ...garminRun, startTimeInSeconds: undefined })).toThrow(/startTimeInSeconds/);
  });

  it('maps sport types case-insensitively', () => {
    expect(garminSport('lap_swimming')).toBe('swim');
    expect(garminSport('OPEN_WATER_SWIMMING')).toBe('open_water_swim');
  });
});

describe('sport groups and hashing', () => {
  it('groups sports', () => {
    expect(sportGroupOf('gravel_ride')).toBe('cycling');
    expect(sportGroupOf('trail_run')).toBe('running');
    expect(sportGroupOf('other')).toBe('other');
  });

  it('hashes payloads independent of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });
});
