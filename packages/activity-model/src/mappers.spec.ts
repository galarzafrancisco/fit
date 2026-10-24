import {
  ActivityMappingError,
  canonicalJson,
  contentHash,
  garminSport,
  mapGarminActivity,
  mapStravaActivity,
  sportGroupOf,
  stravaSport,
  stravaTimezone,
} from './index';

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
  activityId: 21000000001,
  activityName: 'Evening Run',
  startTimeLocal: '2026-10-21 18:30:00',
  startTimeGMT: '2026-10-21 07:30:00',
  activityType: { typeId: 1, typeKey: 'running' },
  distance: 10050.5,
  duration: 3000.4,
  elapsedDuration: 3100.9,
  movingDuration: 2990.1,
  elevationGain: 80,
  averageSpeed: 3.35,
  maxSpeed: 5,
  averageHR: 150,
  maxHR: 175,
  avgPower: 0,
  calories: 700,
  averageRunningCadenceInStepsPerMinute: 168,
  startLatitude: -33.86,
  startLongitude: 151.2,
  manufacturer: 'GARMIN',
  manualActivity: false,
};

describe('mapGarminActivity (Personal API activity list item)', () => {
  it('maps the documented list fields', () => {
    expect(mapGarminActivity(garminRun)).toMatchObject({
      provider: 'garmin',
      providerActivityId: '21000000001',
      name: 'Evening Run',
      sport: 'run',
      providerSportType: 'running',
      startTime: '2026-10-21T07:30:00.000Z',
      startTimeLocal: '2026-10-21T18:30:00',
      utcOffsetSeconds: 39600,
      elapsedTimeSeconds: 3100.9,
      movingTimeSeconds: 2990.1,
      distanceMeters: 10050.5,
      averageHeartRate: 150,
      averagePowerWatts: null,
      averageCadence: 168,
      calories: 700,
      deviceName: 'GARMIN',
      manual: false,
      startLatitude: -33.86,
    });
  });

  it('maps unknown types to other and keeps the Garmin type', () => {
    const a = mapGarminActivity({ ...garminRun, activityType: { typeKey: 'pickleball' } });
    expect(a.sport).toBe('other');
    expect(a.providerSportType).toBe('pickleball');
    expect(garminSport('trail_running')).toBe('trail_run');
  });

  it('refuses items without an id or a GMT start', () => {
    expect(() => mapGarminActivity(null)).toThrow(ActivityMappingError);
    expect(() => mapGarminActivity({ ...garminRun, activityId: undefined })).toThrow(/no activityId/);
    expect(() => mapGarminActivity({ ...garminRun, startTimeGMT: 'soon' })).toThrow(/no startTimeGMT/);
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
