/**
 * Domain errors. Services throw these; the REST exception filter and the MCP
 * adapter translate them into transport-specific responses, so both
 * interfaces report the same failures the same way.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends DomainError {
  readonly code = 'validation_failed';
  readonly httpStatus = 400;
}

export class NotFoundError extends DomainError {
  readonly code = 'not_found';
  readonly httpStatus = 404;
}

export class ConflictError extends DomainError {
  readonly code = 'conflict';
  readonly httpStatus = 409;
}

/** A provider (Strava, Garmin) failed or was unreachable; safe to retry later */
export class UpstreamError extends DomainError {
  readonly code = 'upstream_unavailable';
  readonly httpStatus = 502;
}

/** A provider asked us to slow down (HTTP 429). `details.retryAfterSeconds` when known */
export class UpstreamRateLimitedError extends DomainError {
  readonly code = 'upstream_rate_limited';
  readonly httpStatus = 503;
}

/** A feature that this deployment has not been configured for (e.g. provider credentials) */
export class NotConfiguredError extends DomainError {
  readonly code = 'not_configured';
  readonly httpStatus = 503;
}

/** The provider no longer accepts the user's grant; they must connect again */
export class ReauthorizationRequiredError extends DomainError {
  readonly code = 'reauthorization_required';
  readonly httpStatus = 409;
}
