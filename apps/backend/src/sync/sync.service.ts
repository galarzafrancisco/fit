import { ActivityMappingError, type Provider } from '@fit/activity-model';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MoreThan } from 'typeorm';
import { z } from 'zod';
import { ActivityIngestService } from '../activities/activity-ingest.service';
import { ConflictError, DomainError, ReauthorizationRequiredError, UpstreamRateLimitedError } from '../common/errors';
import { dateOrInstant, parseInput } from '../common/validation';
import { APP_CONFIG, type AppConfig } from '../config/env.config';
import type { ProviderConnectionEntity } from '../connections/connection.entities';
import { ConnectionsService, capitalize, providerSchema } from '../connections/connections.service';
import { UnitOfWork } from '../database/unit-of-work';
import { ProviderRegistry } from '../providers/provider-registry';
import type { CurrentUser } from '../users/users.service';
import { SyncRunEntity, type SyncTrigger } from './sync-run.entity';

export const syncShape = {
  provider: providerSchema,
  since: dateOrInstant('Re-read activities that started at or after this (default: from the last sync, or the initial window on first sync)').optional(),
};
const syncSchema = z.object(syncShape);

export const listSyncRunsShape = {
  provider: providerSchema.optional(),
  limit: z.number().int().min(1).max(100).optional().describe('How many runs, newest first (default 20)'),
};
const listSyncRunsSchema = z.object(listSyncRunsShape);

export type SyncRunView = {
  id: string;
  provider: Provider;
  trigger: string;
  kind: string;
  status: string;
  windowStart: string | null;
  windowEnd: string | null;
  pages: number;
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  note?: string;
};

/** A run older than this that still says "running" is assumed dead (process restart) and does not block a new one */
const RUNNING_TIMEOUT_MS = 15 * 60_000;

/**
 * Imports history and catches up. Strava (pull): pages through
 * /athlete/activities for a time window. Garmin (push): asks Garmin to push
 * history, which arrives through the webhook. Every run is recorded in
 * sync_runs with its counts and error. Webhooks keep data current between runs.
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger('SyncService');
  private readonly background = new Set<Promise<unknown>>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly connections: ConnectionsService,
    private readonly registry: ProviderRegistry,
    private readonly ingest: ActivityIngestService,
    private readonly uow: UnitOfWork,
  ) {}

  async syncForUser(user: CurrentUser, input: unknown): Promise<SyncRunView> {
    const { provider, since } = parseInput(syncSchema, input);
    const connection = await this.connections.activeConnection(user, provider);
    return this.run(connection, 'manual', since ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(since) ? `${since}T00:00:00Z` : since) : null);
  }

  /** Starts the first sync after connecting without blocking the callback page. Errors land in sync_runs */
  startInitialSync(connection: ProviderConnectionEntity): void {
    const promise = this.run(connection, 'connect', null)
      .catch((error) => this.logger.warn(`Initial ${connection.provider} sync failed: ${(error as Error).message}`))
      .finally(() => this.background.delete(promise));
    this.background.add(promise);
  }

  /** Resolves when background syncs have finished (tests, graceful shutdown) */
  async idle(): Promise<void> {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  async listRuns(user: CurrentUser, input: unknown): Promise<SyncRunView[]> {
    const { provider, limit } = parseInput(listSyncRunsSchema, input);
    const runs = await this.uow.manager.find(SyncRunEntity, {
      where: { userId: user.id, ...(provider ? { provider } : {}) },
      order: { startedAt: 'DESC' },
      take: limit ?? 20,
    });
    return runs.map(toView);
  }

  private async run(connection: ProviderConnectionEntity, trigger: SyncTrigger, since: Date | null): Promise<SyncRunView> {
    const adapter = this.registry.get(connection.provider);
    const running = await this.uow.manager.findOne(SyncRunEntity, {
      where: { connectionId: connection.id, status: 'running', startedAt: MoreThan(new Date(Date.now() - RUNNING_TIMEOUT_MS)) },
    });
    if (running) throw new ConflictError(`A ${connection.provider} sync is already running (started ${running.startedAt.toISOString()})`);

    const now = new Date();
    const firstSync = connection.syncCursor === null;
    const after =
      since ??
      (connection.syncCursor
        ? new Date(connection.syncCursor.getTime() - this.config.sync.overlapHours * 3_600_000)
        : new Date(now.getTime() - this.config.sync.initialDays * 86_400_000));
    const run: SyncRunEntity = Object.assign(new SyncRunEntity(), {
      id: randomUUID(),
      userId: connection.userId,
      connectionId: connection.id,
      provider: connection.provider,
      trigger,
      kind: adapter.syncMode === 'push' ? 'backfill_request' : firstSync ? 'initial' : 'incremental',
      status: 'running',
      windowStart: after,
      windowEnd: now,
      pages: 0,
      fetched: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      error: null,
      startedAt: now,
      finishedAt: null,
    } as SyncRunEntity);
    await this.uow.manager.insert(SyncRunEntity, run);

    let note: string | undefined;
    try {
      const token = await this.connections.accessToken(connection.id);
      if (adapter.syncMode === 'push') {
        await adapter.requestBackfill!(token, { after, before: now });
        note = `${capitalize(connection.provider)} accepted the history request; activities arrive by webhook over the next minutes.`;
        run.status = 'succeeded';
      } else {
        const pageSize = this.config.sync.pageSize;
        let hasMore = true;
        for (let page = 1; hasMore && page <= this.config.sync.maxPages; page++) {
          const result = await adapter.listActivities!(token, { after, before: now, page, pageSize });
          run.pages = page;
          hasMore = result.hasMore;
          for (const item of result.items) {
            run.fetched++;
            try {
              const { outcome } = await this.ingest.ingest({ userId: connection.userId, connectionId: connection.id, provider: connection.provider, raw: item, source: 'sync' });
              run[outcome]++;
            } catch (error) {
              if (!(error instanceof ActivityMappingError)) throw error;
              run.skipped++;
              run.error = `Skipped unreadable activity: ${error.message}`;
            }
          }
        }
        if (hasMore) {
          run.status = 'partial';
          run.error = `Stopped after ${this.config.sync.maxPages} pages (SYNC_MAX_PAGES); run the sync again to continue`;
        } else {
          run.status = 'succeeded';
        }
      }
    } catch (error) {
      const message = error instanceof DomainError ? error.message : `Unexpected error: ${(error as Error).message}`;
      run.status = run.fetched > 0 && error instanceof UpstreamRateLimitedError ? 'partial' : 'failed';
      run.error = message.slice(0, 2000);
      if (!(error instanceof DomainError)) this.logger.error(`Sync ${run.id} failed`, (error as Error).stack);
      if (error instanceof ReauthorizationRequiredError) note = 'Connect the provider again with connect_provider.';
    }
    run.finishedAt = new Date();
    await this.uow.manager.save(SyncRunEntity, run);
    // The cursor moves to the end of the window only on a complete run, so a partial one is resumed
    // from the same point. Late uploads older than the overlap are caught by webhooks.
    await this.connections.recordOutcome(connection.id, {
      error: run.status === 'succeeded' ? null : run.error,
      syncedAt: run.finishedAt,
      cursor: run.status === 'succeeded' ? now : undefined,
    });
    return { ...toView(run), ...(note ? { note } : {}) };
  }
}

function toView(run: SyncRunEntity): SyncRunView {
  return {
    id: run.id,
    provider: run.provider,
    trigger: run.trigger,
    kind: run.kind,
    status: run.status,
    windowStart: run.windowStart?.toISOString() ?? null,
    windowEnd: run.windowEnd?.toISOString() ?? null,
    pages: run.pages,
    fetched: run.fetched,
    created: run.created,
    updated: run.updated,
    unchanged: run.unchanged,
    skipped: run.skipped,
    error: run.error,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}
