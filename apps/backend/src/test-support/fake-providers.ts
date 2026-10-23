import { createHash } from 'node:crypto';

/**
 * In-memory stand-ins for Strava and Garmin, served through the `fetch`
 * the app is given (AppModuleOptions.providerFetch). They implement only
 * what Fit calls, with the documented status codes, so the real adapters run
 * unchanged against them.
 */

export const STRAVA_OAUTH = 'https://strava.test/oauth';
export const STRAVA_API = 'https://strava.test/api/v3';
export const GARMIN_AUTHORIZE = 'https://garmin.test/oauth2Confirm';
export const GARMIN_TOKEN = 'https://garmin.test/oauth/token';
export const GARMIN_API = 'https://apis.garmin.test';

type Json = Record<string, any>;
type Call = { method: string; url: URL; body: URLSearchParams | null; headers: Headers };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

async function readCall(input: string | URL | Request, init?: RequestInit): Promise<Call> {
  const request = input instanceof Request ? input : new Request(input, init);
  const text = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
  return { method: request.method, url: new URL(request.url), body: text ? new URLSearchParams(text) : null, headers: request.headers };
}

let tokenCounter = 0;
const nextToken = (prefix: string) => `${prefix}-${++tokenCounter}-${Math.random().toString(36).slice(2, 8)}`;

export class FakeStrava {
  readonly calls: Call[] = [];
  /** athleteId -> activities (Strava DetailedActivity-like objects) */
  readonly activities = new Map<string, Json[]>();
  private readonly codes = new Map<string, { athleteId: string }>();
  private readonly access = new Map<string, { athleteId: string; expiresAt: number }>();
  private readonly refresh = new Map<string, string>();
  /** Responses to return for the next matching calls, e.g. { path: '/athlete/activities', status: 429 } */
  readonly failures: Array<{ path: string; status: number; times: number }> = [];
  /** Lifetime given to new access tokens */
  accessTokenTtlSeconds = 6 * 3600;
  deauthorized: string[] = [];

  constructor(
    readonly clientId = '12345',
    readonly clientSecret = 'strava-secret',
  ) {}

  /** What the user's browser would get back from Strava's authorize page after approving */
  approve(athleteId: string): string {
    const code = nextToken('strava-code');
    this.codes.set(code, { athleteId });
    return code;
  }

  addActivity(athleteId: string, overrides: Json = {}): Json {
    const id = overrides.id ?? Math.floor(Math.random() * 1e12) + 1e12;
    const activity = {
      id,
      name: 'Morning Run',
      sport_type: 'Run',
      type: 'Run',
      start_date: '2026-10-20T19:30:00Z',
      start_date_local: '2026-10-21T06:30:00Z',
      timezone: '(GMT+11:00) Australia/Sydney',
      utc_offset: 39600,
      distance: 10000,
      moving_time: 3000,
      elapsed_time: 3100,
      total_elevation_gain: 50,
      average_speed: 3.33,
      max_speed: 5,
      average_heartrate: 150,
      max_heartrate: 175,
      manual: false,
      private: false,
      athlete: { id: Number(athleteId) },
      ...overrides,
    };
    this.activities.set(athleteId, [...(this.activities.get(athleteId) ?? []).filter((a) => a.id !== id), activity]);
    return activity;
  }

  removeActivity(athleteId: string, id: number | string): void {
    this.activities.set(
      athleteId,
      (this.activities.get(athleteId) ?? []).filter((a) => String(a.id) !== String(id)),
    );
  }

  /** Invalidates every access token, as if they all expired at Strava */
  expireAccessTokens(): void {
    this.access.clear();
  }

  revokeRefreshTokens(): void {
    this.refresh.clear();
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call = await readCall(input, init);
    this.calls.push(call);
    const path = call.url.pathname.replace(/^\/(oauth|api\/v3)/, '');
    const failure = this.failures.find((f) => f.times > 0 && path.startsWith(f.path));
    if (failure) {
      failure.times--;
      return json(failure.status, { message: 'injected failure' }, failure.status === 429 ? { 'retry-after': '60' } : {});
    }
    if (call.url.href.startsWith(`${STRAVA_OAUTH}/token`)) return this.token(call);
    if (call.url.href.startsWith(`${STRAVA_OAUTH}/deauthorize`)) {
      const token = call.body?.get('access_token') ?? '';
      const athlete = this.access.get(token)?.athleteId;
      if (athlete) this.deauthorized.push(athlete);
      return json(200, { access_token: token });
    }
    if (call.url.href.startsWith(STRAVA_API)) {
      const auth = call.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      const grant = this.access.get(auth);
      if (!grant || grant.expiresAt < Date.now()) return json(401, { message: 'Authorization Error' });
      if (path === '/athlete/activities') {
        const after = Number(call.url.searchParams.get('after') ?? 0) * 1000;
        const before = Number(call.url.searchParams.get('before') ?? 1e11) * 1000;
        const page = Number(call.url.searchParams.get('page') ?? 1);
        const perPage = Number(call.url.searchParams.get('per_page') ?? 30);
        const all = (this.activities.get(grant.athleteId) ?? [])
          .filter((a) => Date.parse(a.start_date) > after && Date.parse(a.start_date) < before)
          .sort((a, b) => Date.parse(a.start_date) - Date.parse(b.start_date));
        // The summary representation omits detailed-only fields
        return json(
          200,
          all.slice((page - 1) * perPage, page * perPage).map(({ calories: _c, description: _d, ...summary }) => summary),
        );
      }
      const match = /^\/activities\/(\d+)$/.exec(path);
      if (match) {
        const owned = (this.activities.get(grant.athleteId) ?? []).find((a) => String(a.id) === match[1]);
        if (owned) return json(200, owned);
        const elsewhere = [...this.activities.values()].flat().some((a) => String(a.id) === match[1]);
        return json(elsewhere ? 403 : 404, { message: elsewhere ? 'Forbidden' : 'Record Not Found' });
      }
    }
    return json(404, { message: `FakeStrava: no route ${call.method} ${call.url.href}` });
  };

  private token(call: Call): Response {
    const body = call.body!;
    if (body.get('client_id') !== this.clientId || body.get('client_secret') !== this.clientSecret)
      return json(401, { message: 'Bad Request', errors: [{ field: 'client_id' }] });
    let athleteId: string | undefined;
    if (body.get('grant_type') === 'authorization_code') {
      athleteId = this.codes.get(body.get('code') ?? '')?.athleteId;
      this.codes.delete(body.get('code') ?? '');
    } else if (body.get('grant_type') === 'refresh_token') {
      const old = body.get('refresh_token') ?? '';
      athleteId = this.refresh.get(old);
      this.refresh.delete(old); // rotation: a refresh token works once
    }
    if (!athleteId) return json(400, { message: 'Bad Request', errors: [{ code: 'invalid' }] });
    const accessToken = nextToken('strava-access');
    const refreshToken = nextToken('strava-refresh');
    const expiresAt = Date.now() + this.accessTokenTtlSeconds * 1000;
    this.access.set(accessToken, { athleteId, expiresAt });
    this.refresh.set(refreshToken, athleteId);
    return json(200, {
      token_type: 'Bearer',
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: Math.floor(expiresAt / 1000),
      expires_in: this.accessTokenTtlSeconds,
      ...(body.get('grant_type') === 'authorization_code' ? { athlete: { id: Number(athleteId), firstname: 'Ada', lastname: 'Runner', username: 'ada' } } : {}),
    });
  }
}

export class FakeGarmin {
  readonly calls: Call[] = [];
  readonly backfills: Array<{ userId: string; start: number; end: number }> = [];
  readonly deregistered: string[] = [];
  /** Activity summaries a Ping callback URL returns */
  readonly pingData = new Map<string, Json[]>();
  permissions = ['ACTIVITY_EXPORT', 'HEALTH_EXPORT'];
  private readonly codes = new Map<string, { userId: string; challenge: string }>();
  private readonly access = new Map<string, string>();
  private readonly refresh = new Map<string, string>();

  constructor(
    readonly clientId = 'garmin-client',
    readonly clientSecret = 'garmin-secret',
  ) {}

  /** Simulates the user approving on Garmin's page for the given authorization URL */
  approve(authorizationUrl: string, userId: string): string {
    const url = new URL(authorizationUrl);
    const code = nextToken('garmin-code');
    this.codes.set(code, { userId, challenge: url.searchParams.get('code_challenge') ?? '' });
    return code;
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call = await readCall(input, init);
    this.calls.push(call);
    if (call.url.href.startsWith(GARMIN_TOKEN)) return this.token(call);
    if (!call.url.href.startsWith(GARMIN_API)) return json(404, {});
    const userId = this.access.get(call.headers.get('authorization')?.replace(/^Bearer /, '') ?? '');
    if (!userId) return json(401, { errorMessage: 'Unauthorized' });
    const path = call.url.pathname;
    if (path === '/wellness-api/rest/user/id') return json(200, { userId });
    if (path === '/wellness-api/rest/user/permissions') return json(200, this.permissions);
    if (path === '/wellness-api/rest/user/registration' && call.method === 'DELETE') {
      this.deregistered.push(userId);
      return new Response(null, { status: 204 });
    }
    if (path === '/wellness-api/rest/backfill/activities') {
      this.backfills.push({
        userId,
        start: Number(call.url.searchParams.get('summaryStartTimeInSeconds')),
        end: Number(call.url.searchParams.get('summaryEndTimeInSeconds')),
      });
      return new Response(null, { status: 202 });
    }
    if (path === '/wellness-api/rest/activities') return json(200, this.pingData.get(call.url.search) ?? []);
    return json(404, {});
  };

  private token(call: Call): Response {
    const body = call.body!;
    if (body.get('client_id') !== this.clientId || body.get('client_secret') !== this.clientSecret) return json(401, { error: 'invalid_client' });
    let userId: string | undefined;
    if (body.get('grant_type') === 'authorization_code') {
      const pending = this.codes.get(body.get('code') ?? '');
      this.codes.delete(body.get('code') ?? '');
      const verifier = body.get('code_verifier') ?? '';
      if (pending && createHash('sha256').update(verifier).digest('base64url') === pending.challenge) userId = pending.userId;
    } else if (body.get('grant_type') === 'refresh_token') {
      userId = this.refresh.get(body.get('refresh_token') ?? '');
    }
    if (!userId) return json(400, { error: 'invalid_grant' });
    const accessToken = nextToken('garmin-access');
    const refreshToken = nextToken('garmin-refresh');
    this.access.set(accessToken, userId);
    this.refresh.set(refreshToken, userId);
    return json(200, {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 86400,
      refresh_token_expires_in: 7776000,
      token_type: 'bearer',
      scope: 'PARTNER_READ',
    });
  }
}

export function garminActivity(overrides: Json = {}): Json {
  return {
    userId: 'garmin-user-1',
    summaryId: String(Math.floor(Math.random() * 1e10)),
    activityId: Math.floor(Math.random() * 1e10),
    activityName: 'Lunch Ride',
    activityType: 'ROAD_BIKING',
    startTimeInSeconds: 1761000000,
    startTimeOffsetInSeconds: 39600,
    durationInSeconds: 5400,
    distanceInMeters: 42000,
    averageSpeedInMetersPerSecond: 7.8,
    activeKilocalories: 900,
    ...overrides,
  };
}

/** Routes each request to the fake for its host */
export function providerFetch(strava: FakeStrava, garmin: FakeGarmin): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith('https://strava.test')) return strava.fetch(input, init);
    if (url.startsWith('https://garmin.test') || url.startsWith(GARMIN_API)) return garmin.fetch(input, init);
    throw new TypeError(`fetch failed: unexpected outbound request to ${url}`);
  }) as typeof fetch;
}
