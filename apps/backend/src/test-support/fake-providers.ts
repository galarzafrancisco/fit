/**
 * In-memory stand-ins for Strava and Garmin, served through the `fetch`
 * the app is given (AppModuleOptions.providerFetch). They implement only
 * what Fit calls, with the documented status codes, so the real adapters run
 * unchanged against them.
 */

export const STRAVA_OAUTH = 'https://strava.test/oauth';
export const STRAVA_API = 'https://strava.test/api/v3';
export const GARMIN_API = 'https://personal.garmin.test';

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

/** A stand-in for the Garmin Connect Personal API: key-to-token exchange and the offset-paged activity list */
export class FakeGarmin {
  readonly calls: Call[] = [];
  /** Valid API keys → the Garmin account they belong to */
  readonly keys = new Map<string, string>();
  readonly activities = new Map<string, Json[]>();
  private readonly tokens = new Map<string, string>();
  tokenRequests = 0;
  /** Runs (once) inside the next activity list call before it answers, to simulate a slow response */
  duringNextList: (() => Promise<void>) | null = null;
  /** Responses returned (once each, in order) for the next activity list calls instead of data */
  readonly failNext: Array<{ status: number; headers?: Record<string, string> }> = [];

  addKey(apiKey: string, account: string): void {
    this.keys.set(apiKey, account);
    if (!this.activities.has(account)) this.activities.set(account, []);
  }

  addActivities(account: string, items: Json[]): void {
    this.activities.get(account)!.push(...items);
  }

  /** Simulates the 24 h access tokens expiring */
  expireTokens(): void {
    this.tokens.clear();
  }

  listCalls(): Call[] {
    return this.calls.filter((c) => c.url.pathname === '/activitylist-service/activities/search/activities');
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call = await readCall(input, init);
    this.calls.push(call);
    const auth = call.headers.get('authorization') ?? '';
    if (call.url.pathname === '/personalapitoken-service/personal-api/personal-api-key/token') {
      this.tokenRequests++;
      const account = this.keys.get(auth.replace(/^ApiKey /, ''));
      if (call.method !== 'POST' || !auth.startsWith('ApiKey ') || !account) return json(401, { message: 'Unauthorized' });
      const jwt = ['e30', Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url'), nextToken('sig')].join('.');
      this.tokens.set(jwt, account);
      return new Response(jwt, { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    const account = this.tokens.get(auth.replace(/^Bearer /, ''));
    if (!account) return json(401, { message: 'Unauthorized' });
    if (call.url.pathname !== '/activitylist-service/activities/search/activities') return json(404, {});
    const hook = this.duringNextList;
    this.duringNextList = null;
    if (hook) await hook();
    const failure = this.failNext.shift();
    if (failure) return json(failure.status, { message: 'forced' }, failure.headers);
    const start = Number(call.url.searchParams.get('start') ?? 0);
    const limit = Number(call.url.searchParams.get('limit') ?? 20);
    const startDate = call.url.searchParams.get('startDate');
    let items = [...(this.activities.get(account) ?? [])].sort((a, b) => String(b.startTimeGMT).localeCompare(String(a.startTimeGMT)));
    if (startDate) items = items.filter((a) => String(a.startTimeLocal).slice(0, 10) >= startDate);
    return json(200, items.slice(start, start + limit));
  };
}

/** A Personal API activity list item. `n` orders activities: a higher n is more recent (one per hour) */
export function garminActivity(n: number, overrides: Json = {}): Json {
  const gmt = new Date(Date.UTC(2026, 0, 1) + n * 3_600_000);
  const local = new Date(gmt.getTime() + 39_600_000);
  const fmt = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');
  return {
    activityId: 9_000_000_000 + n,
    activityName: `Activity ${n}`,
    startTimeGMT: fmt(gmt),
    startTimeLocal: fmt(local),
    activityType: { typeKey: 'running' },
    distance: 5000 + n,
    duration: 1800,
    elapsedDuration: 1850,
    calories: 400,
    ...overrides,
  };
}

/** Routes each request to the fake for its host */
export function providerFetch(strava: FakeStrava, garmin: FakeGarmin): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith('https://strava.test')) return strava.fetch(input, init);
    if (url.startsWith(GARMIN_API)) return garmin.fetch(input, init);
    throw new TypeError(`fetch failed: unexpected outbound request to ${url}`);
  }) as typeof fetch;
}

/**
 * Stands in for Taico's authorization server as the Garmin key page's browser
 * sign-in sees it: discovery, dynamic client registration and the token
 * endpoint. `approve(subject)` is the user finishing the login in the browser.
 */
export class FakeTaico {
  readonly registrations: Array<Record<string, unknown>> = [];
  readonly tokenRequests: URLSearchParams[] = [];
  private readonly codes = new Map<string, string>();
  private counter = 0;

  constructor(
    private readonly issuer: string,
    private readonly mint: (subject: string) => Promise<string>,
  ) {}

  /** The user signs in at Taico as `subject`; returns the authorization code Taico sends back */
  approve(subject: string): string {
    const code = `taico-code-${++this.counter}`;
    this.codes.set(code, subject);
    return code;
  }

  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json({
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        registration_endpoint: `${this.issuer}/register`,
      });
    }
    if (url.pathname === '/register') {
      this.registrations.push(JSON.parse(String(init?.body)));
      return json({ client_id: 'fit-browser-client' }, 201);
    }
    if (url.pathname === '/token') {
      const form = new URLSearchParams(String(init?.body));
      this.tokenRequests.push(form);
      const subject = this.codes.get(form.get('code') ?? '');
      if (!subject || !form.get('code_verifier')) return json({ error: 'invalid_grant' }, 400);
      this.codes.delete(form.get('code')!); // codes are single-use
      return json({ access_token: await this.mint(subject), token_type: 'Bearer', expires_in: 600 });
    }
    return json({ error: 'not_found' }, 404);
  }
}
