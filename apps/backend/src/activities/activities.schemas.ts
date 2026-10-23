import { SPORTS, SPORT_GROUP_NAMES } from '@fit/activity-model';
import { z } from 'zod';
import { providerSchema } from '../connections/connections.service';
import { dateOrInstant } from '../common/validation';

/**
 * Inputs shared by REST and MCP. Dates without a time are whole UTC days:
 * `from` starts at 00:00Z, `to` includes the whole day.
 */
const filterShape = {
  from: dateOrInstant('Earliest start (inclusive): YYYY-MM-DD (UTC day) or ISO date-time').optional(),
  to: dateOrInstant('Latest start: YYYY-MM-DD includes that whole UTC day; an ISO date-time is exclusive').optional(),
  provider: providerSchema.optional(),
  sport: z
    .union([z.enum(SPORTS), z.array(z.enum(SPORTS)).min(1).max(SPORTS.length)])
    .optional()
    .describe(`One sport or a list. Values: ${SPORTS.join(', ')}`),
  sportGroup: z
    .enum(SPORT_GROUP_NAMES as [string, ...string[]])
    .optional()
    .describe(`Broader group: ${SPORT_GROUP_NAMES.join(', ')}`),
};

export const listActivitiesShape = {
  ...filterShape,
  search: z.string().trim().min(1).max(100).optional().describe('Case-insensitive text to find in the activity name'),
  minDistanceMeters: z.number().nonnegative().optional().describe('Only activities at least this long (meters)'),
  includeDeleted: z.boolean().optional().describe('Include activities deleted at the provider (default false)'),
  limit: z.number().int().min(1).max(100).optional().describe('Page size, 1-100 (default 25)'),
  cursor: z.string().max(200).optional().describe('nextCursor from the previous page'),
};
export const listActivitiesSchema = z.object(listActivitiesShape);
export type ListActivitiesInput = z.infer<typeof listActivitiesSchema>;

export const getActivityShape = {
  activityId: z.string().describe('Activity ID (from list_activities)'),
  includeRaw: z.boolean().optional().describe("Include the provider's latest raw payload (large)"),
  includeHistory: z.boolean().optional().describe('Include every payload version received, with source and time (provenance)'),
};
export const getActivitySchema = z.object(getActivityShape);

export const SUMMARY_GROUPINGS = ['none', 'sport', 'sport_group', 'provider', 'day', 'week', 'month', 'year'] as const;
export const summaryShape = {
  ...filterShape,
  groupBy: z.enum(SUMMARY_GROUPINGS).optional().describe('How to split the totals (default sport). week starts on Monday (UTC)'),
};
export const summarySchema = z.object(summaryShape);
export type SummaryInput = z.infer<typeof summarySchema>;
