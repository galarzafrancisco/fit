import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { getActivityShape, listActivitiesShape, summaryShape } from '../activities/activities.schemas';
import { ActivitiesService } from '../activities/activities.service';
import { DomainError } from '../common/errors';
import { ConnectionsService, disconnectShape, providerSchema } from '../connections/connections.service';
import { listSyncRunsShape, syncShape, SyncService } from '../sync/sync.service';
import type { CurrentUser } from '../users/users.service';
import { WebhookInboxService } from '../webhooks/webhook-inbox.service';

const INSTRUCTIONS =
  "Fit holds the signed-in user's workouts imported from Strava and Garmin, normalized to one model. " +
  'Typical flow: list_connections to see what is connected; connect_provider returns a link the user opens in a browser to connect a provider; ' +
  'list_activities (filter by from/to dates, provider, sport or sportGroup, search) and get_activity for detail; get_activity_summary for totals by sport, week, month and so on. ' +
  'Distances are meters (distanceKm is provided), durations seconds, speeds km/h, dates ISO 8601 UTC with startTimeLocal for the local wall clock. ' +
  'New activities arrive automatically by webhook; sync_provider catches up on demand. Fit only reads from providers; it never changes anything there.';

/**
 * The MCP adapter. Tools hold no business rules: each calls the same service
 * method as the matching REST route, for the user resolved from the request's
 * access token. That user is bound when the server is built and never comes
 * from tool arguments.
 */
@Injectable()
export class FitMcpServerFactory {
  constructor(
    private readonly activities: ActivitiesService,
    private readonly connections: ConnectionsService,
    private readonly sync: SyncService,
    private readonly webhooks: WebhookInboxService,
  ) {}

  build(user: CurrentUser): McpServer {
    const server = new McpServer({ name: 'fit', version: '0.0.1' }, { instructions: INSTRUCTIONS });
    const read = { readOnlyHint: true, openWorldHint: false };
    const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
    const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

    const tool = <Shape extends z.ZodRawShape>(
      name: string,
      description: string,
      annotations: Record<string, boolean>,
      shape: Shape,
      run: (args: z.infer<z.ZodObject<Shape>>) => Promise<unknown>,
    ) => {
      server.registerTool(name, { description, annotations, inputSchema: shape }, (async (args: z.infer<z.ZodObject<Shape>>) => toResult(() => run(args))) as never);
    };

    tool('whoami', 'The Fit user the current access token maps to', read, {}, async () => user);

    tool(
      'list_connections',
      'Strava and Garmin connection status for the user: whether each provider is available on this server, connected, its status (active, needs_reauth, revoked, disconnected), last sync, last error and activity count',
      read,
      {},
      () => this.connections.list(user),
    );
    tool(
      'connect_provider',
      'Start connecting Strava or Garmin. Returns authorizationUrl: give it to the user to open in a browser and approve read access. The link works once and expires in about 15 minutes. After approval Fit imports activities automatically',
      write,
      { provider: providerSchema },
      ({ provider }) => this.connections.startConnect(user, provider),
    );
    tool(
      'disconnect_provider',
      'Disconnect Strava or Garmin: Fit revokes its access and stops importing. Imported activities are kept unless deleteActivities is true',
      destructive,
      disconnectShape,
      (args) => this.connections.disconnect(user, args),
    );
    tool(
      'sync_provider',
      'Catch up with a provider now. Strava: imports activities since the last sync (or since `since`) and returns counts. Garmin: asks Garmin to re-send history, which arrives in the background',
      write,
      syncShape,
      (args) => this.sync.syncForUser(user, args),
    );
    tool('list_sync_runs', 'Recent syncs with their status, counts and errors (audit trail), newest first', read, listSyncRunsShape, (args) => this.sync.listRuns(user, args));
    tool(
      'list_webhook_events',
      'Recent provider webhook events for the user (new, updated or deleted activities, revocations) with processing status and errors, newest first',
      read,
      { provider: providerSchema.optional(), limit: z.number().int().min(1).max(100).optional().describe('How many events (default 20)') },
      (args) => this.webhooks.listForUser(user.id, args),
    );

    tool(
      'list_activities',
      'List activities newest first, filtered by start date (from/to), provider, sport or sportGroup (running, cycling, swimming, ...), name search and minimum distance. Paginated: pass nextCursor as cursor for more',
      read,
      listActivitiesShape,
      (args) => this.activities.list(user, args),
    );
    tool(
      'get_activity',
      'One activity with every normalized metric, provenance (how and when it was imported) and a link to it on the provider. includeRaw adds the provider payload; includeHistory adds every version received',
      read,
      getActivityShape,
      (args) => this.activities.get(user, args),
    );
    tool(
      'get_activity_summary',
      'Totals (count, distance, moving time, elevation, calories, longest) over a date range, split by sport, sport_group, provider, day, week, month or year. Same filters as list_activities',
      read,
      summaryShape,
      (args) => this.activities.summary(user, args),
    );

    server.registerResource(
      'activity',
      new ResourceTemplate('fit://activities/{activityId}', {
        list: async () => {
          const { items } = await this.activities.list(user, { limit: 50 });
          return { resources: items.map((a) => ({ uri: `fit://activities/${a.id}`, name: `${a.startTime.slice(0, 10)} ${a.name ?? a.sport}`, mimeType: 'application/json' })) };
        },
      }),
      { title: 'Activity', description: 'One activity with its normalized metrics and provenance', mimeType: 'application/json' },
      async (uri, { activityId }) => ({
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await this.activities.get(user, { activityId: String(activityId) }), null, 2) }],
      }),
    );

    return server;
  }
}

/** Results as JSON text; domain errors become tool errors with the same code and message as REST */
async function toResult(run: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const result = await run();
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    if (error instanceof DomainError) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }) }],
      };
    }
    throw error;
  }
}
