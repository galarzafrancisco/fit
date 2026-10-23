import { z } from 'zod';
import { ValidationError } from './errors';

/** Parses input with a schema and turns zod issues into a ValidationError */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    const summary = issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ');
    throw new ValidationError(`Invalid input: ${summary}`, { issues });
  }
  return result.data;
}

/** A calendar date (YYYY-MM-DD) or a full ISO 8601 instant */
export const dateOrInstant = (description: string) =>
  z
    .string()
    .trim()
    .refine((value) => (/^\d{4}-\d{2}-\d{2}$/.test(value) || /^\d{4}-\d{2}-\d{2}T/.test(value)) && !Number.isNaN(Date.parse(value)), {
      message: 'must be a date (YYYY-MM-DD) or an ISO 8601 date-time',
    })
    .describe(description);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** IDs are checked before they reach a query, so a malformed one is simply "not found" */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
