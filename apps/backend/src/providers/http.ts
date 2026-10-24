import { UpstreamError, UpstreamRateLimitedError } from '../common/errors';

/** The provider rejected the credential (HTTP 400/401 on a token or API call): the user must reconnect */
export class ProviderAuthError extends Error {
  constructor(
    readonly provider: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderAuthError';
  }
}

export type ProviderResponse = { status: number; body: unknown; /** Raw response text; may be a credential, never log it */ text: string; headers: Headers };

/**
 * One HTTP call to a provider, with a timeout. Network failures and 5xx
 * become UpstreamError, 429 becomes UpstreamRateLimitedError (both retryable),
 * other statuses are returned for the adapter to interpret. Response bodies
 * are never logged or echoed: they can contain tokens.
 */
export async function providerRequest(
  fetchImpl: typeof fetch,
  provider: string,
  url: string,
  init: RequestInit & { timeoutMs: number },
): Promise<ProviderResponse> {
  const { timeoutMs, ...rest } = init;
  let response: Response;
  try {
    response = await fetchImpl(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    // AbortSignal.timeout rejects with a DOMException, which is not always an Error instance across realms
    const reason = (error as { name?: unknown } | null)?.name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : 'network error';
    throw new UpstreamError(`${provider} request failed: ${reason}`);
  }
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after'));
    throw new UpstreamRateLimitedError(
      `${provider} rate limit reached; try again later`,
      Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : undefined,
    );
  }
  if (response.status >= 500) throw new UpstreamError(`${provider} answered HTTP ${response.status}`);
  return { status: response.status, body, text, headers: response.headers };
}

export function formBody(values: Record<string, string>): URLSearchParams {
  return new URLSearchParams(values);
}

/** Converts a relative lifetime in seconds to an absolute expiry, or null */
export function expiresIn(seconds: unknown, now = Date.now()): Date | null {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? new Date(now + seconds * 1000) : null;
}
