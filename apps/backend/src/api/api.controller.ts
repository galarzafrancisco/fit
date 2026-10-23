import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ActivitiesService } from '../activities/activities.service';
import { Protected } from '../auth/protected.decorator';
import { AuthenticatedUser } from '../auth/user.guard';
import { ConnectionsService } from '../connections/connections.service';
import { SyncService } from '../sync/sync.service';
import type { CurrentUser } from '../users/users.service';
import { WebhookInboxService } from '../webhooks/webhook-inbox.service';

/**
 * REST adapter over the same services as the MCP tools (see docs/api.md).
 * Query strings arrive as strings; numeric and boolean filters are coerced
 * here, everything else is validated by the services.
 */
@Controller('api')
@Protected()
export class ApiController {
  constructor(
    private readonly activities: ActivitiesService,
    private readonly connections: ConnectionsService,
    private readonly sync: SyncService,
    private readonly webhooks: WebhookInboxService,
  ) {}

  @Get('me')
  me(@AuthenticatedUser() user: CurrentUser) {
    return user;
  }

  @Get('connections')
  listConnections(@AuthenticatedUser() user: CurrentUser) {
    return this.connections.list(user);
  }

  @Get('connections/:provider')
  getConnection(@AuthenticatedUser() user: CurrentUser, @Param('provider') provider: string) {
    return this.connections.get(user, provider);
  }

  @Post('connections/:provider/authorize')
  @HttpCode(200)
  authorize(@AuthenticatedUser() user: CurrentUser, @Param('provider') provider: string) {
    return this.connections.startConnect(user, provider);
  }

  @Delete('connections/:provider')
  disconnect(@AuthenticatedUser() user: CurrentUser, @Param('provider') provider: string, @Query('deleteActivities') deleteActivities?: string) {
    return this.connections.disconnect(user, { provider, deleteActivities: bool(deleteActivities) });
  }

  @Post('connections/:provider/sync')
  @HttpCode(200)
  syncNow(@AuthenticatedUser() user: CurrentUser, @Param('provider') provider: string, @Body() body: { since?: unknown } | undefined) {
    return this.sync.syncForUser(user, { provider, since: body?.since });
  }

  @Get('sync-runs')
  syncRuns(@AuthenticatedUser() user: CurrentUser, @Query() query: Record<string, string>) {
    return this.sync.listRuns(user, { provider: query.provider, limit: int(query.limit) });
  }

  @Get('webhook-events')
  webhookEvents(@AuthenticatedUser() user: CurrentUser, @Query() query: Record<string, string>) {
    const limit = int(query.limit);
    return this.webhooks.listForUser(user.id, {
      provider: query.provider === 'strava' || query.provider === 'garmin' ? query.provider : undefined,
      limit: limit && limit > 0 && limit <= 100 ? limit : undefined,
    });
  }

  @Get('activities')
  listActivities(@AuthenticatedUser() user: CurrentUser, @Query() query: Record<string, string | string[]>) {
    return this.activities.list(user, {
      ...query,
      sport: query.sport,
      limit: int(query.limit),
      minDistanceMeters: num(query.minDistanceMeters),
      includeDeleted: bool(query.includeDeleted),
    });
  }

  @Get('activities/summary')
  summary(@AuthenticatedUser() user: CurrentUser, @Query() query: Record<string, string | string[]>) {
    return this.activities.summary(user, query);
  }

  @Get('activities/:id')
  getActivity(@AuthenticatedUser() user: CurrentUser, @Param('id') id: string, @Query() query: Record<string, string>) {
    return this.activities.get(user, { activityId: id, includeRaw: bool(query.includeRaw), includeHistory: bool(query.includeHistory) });
  }
}

function int(value: unknown): number | undefined {
  return typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : (value as undefined);
}

function num(value: unknown): number | undefined {
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : (value as undefined);
}

function bool(value: unknown): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value as undefined;
}
