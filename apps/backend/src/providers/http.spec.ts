import { UpstreamError, UpstreamRateLimitedError } from '../common/errors';
import { expiresIn, providerRequest } from './http';

const respond = (status: number, body = '{}', headers: Record<string, string> = {}) => (async () => new Response(body, { status, headers })) as typeof fetch;

describe('providerRequest', () => {
  it('returns parsed JSON for ordinary statuses, including 4xx for the adapter to interpret', async () => {
    expect((await providerRequest(respond(200, '{"a":1}'), 'X', 'https://x.test', { timeoutMs: 1000 })).body).toEqual({ a: 1 });
    expect((await providerRequest(respond(404, 'not json'), 'X', 'https://x.test', { timeoutMs: 1000 })).status).toBe(404);
  });

  it('maps 429 to a rate-limit error with Retry-After, and 5xx to an upstream error', async () => {
    const limited = providerRequest(respond(429, '{}', { 'retry-after': '120' }), 'Strava', 'https://x.test', { timeoutMs: 1000 });
    await expect(limited).rejects.toBeInstanceOf(UpstreamRateLimitedError);
    await expect(limited).rejects.toMatchObject({ details: { retryAfterSeconds: 120 } });
    await expect(providerRequest(respond(502), 'Strava', 'https://x.test', { timeoutMs: 1000 })).rejects.toThrow('Strava answered HTTP 502');
  });

  it('maps network failures and timeouts to upstream errors without leaking details', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed: secret-token in url');
    }) as typeof fetch;
    await expect(providerRequest(failing, 'Garmin', 'https://x.test', { timeoutMs: 1000 })).rejects.toThrow(
      new UpstreamError('Garmin request failed: network error'),
    );
    const slow = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    await expect(providerRequest(slow, 'Garmin', 'https://x.test', { timeoutMs: 20 })).rejects.toThrow('timed out after 20 ms');
  });

  it('turns relative lifetimes into dates', () => {
    expect(expiresIn(60, 0)?.getTime()).toBe(60_000);
    expect(expiresIn(undefined)).toBeNull();
    expect(expiresIn(-1)).toBeNull();
  });
});
