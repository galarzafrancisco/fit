/** Defensive readers for untyped provider JSON. A wrong type reads as null, never throws. */

export type Json = Record<string, unknown>;

export function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/** A non-negative number; providers sometimes send 0 for "not measured", which is kept as 0 */
export function nonNegative(value: unknown): number | null {
  const n = num(value);
  return n === null || n < 0 ? null : n;
}

/** A positive number; 0 means "not measured" (e.g. heart rate, power) and reads as null */
export function positive(value: unknown): number | null {
  const n = num(value);
  return n === null || n <= 0 ? null : n;
}

export function str(value: unknown, max = 500): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
}

export function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** IDs arrive as numbers (Strava) or strings (Garmin); both become strings. Large integers must stay exact. */
export function id(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'bigint' && value >= 0n) return value.toString();
  if (typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)) return value;
  return null;
}

export function isoInstant(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export function latLng(lat: unknown, lng: unknown): { lat: number | null; lng: number | null } {
  const a = num(lat);
  const b = num(lng);
  if (a === null || b === null || a < -90 || a > 90 || b < -180 || b > 180) return { lat: null, lng: null };
  return { lat: a, lng: b };
}
