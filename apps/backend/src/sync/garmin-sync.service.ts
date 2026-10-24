import { ActivityMappingError } from '@fit/activity-model';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ActivityIngestService } from '../activities/activity-ingest.service';
import { DomainError, ReauthorizationRequiredError, UpstreamError, UpstreamRateLimitedError } from '../common/errors';
import { APP_CONFIG, type AppConfig } from '../config/env.config';
import { ProviderConnectionEntity } from '../connections/connection.entities';
import { ConnectionsRepository } from '../connections/connections.repository';
import { ConnectionsService, SyncLeaseLostError } from '../connections/connections.service';
import { UnitOfWork } from '../database/unit-of-work';
import { ProviderAuthError } from '../providers/http';
import { ProviderRegistry } from '../providers/provider-registry';
import type { CurrentUser } from '../users/users.service';
import { SyncRunEntity, type SyncTrigger } from './sync-run.entity';
import { toSyncRunView, type SyncRunView } from './sync-run.view';

/** A run still marked "running" after this long is assumed dead (process restart) */
const RUNNING_TIMEOUT_MS = 15 * 60_000;

/** Safety stop for one poll: this many pages of new activity in a single run */
const MAX_POLL_PAGES = 1000;

/** Raised inside a run when the user's key no longer works; the connection is already marked needs_reauth */
class KeyRejected extends Error {}
/** The sync lease lapsed and another worker took it: stop without touching shared state */
class LeaseLost extends Error {}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/**
 * Garmin Personal API ingestion. The API documents no webhooks or push, so
 * Fit polls:
 *
 * 1. History: walks the newest-first activity list from offset 0 in pages,
 *    persisting the offset after every page (`history_offset`), so an
 *    interrupted or rate-limited walk resumes where it stopped. It ends on a
 *    short page, or after GARMIN_HISTORY_MAX_ACTIVITIES.
 * 2. Polling: a periodic job re-reads activities since the sync cursor minus
 *    the overlap (`startDate` filter) to pick up new and late-synced ones.
 * 3. Pacing: bounded concurrency across users, a pause between requests,
 *    retries with exponential backoff (Retry-After honored) and, when a run
 *    still fails, a persisted per-connection backoff.
 *
 * Imports go through ActivityIngestService, so they are idempotent: offsets
 * shifting because new activities arrive mid-walk only cause "unchanged" re-reads.
 */
@Injectable()
export class GarminSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('GarminSync');
  private readonly background = new Set<Promise<unknown>>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;

  constructor(
    @Inject(APP_CONFIG) private readonly appConfig: AppConfig,
    private readonly connections: ConnectionsService,
    private readonly repo: ConnectionsRepository,
    private readonly registry: ProviderRegistry,
    private readonly ingest: ActivityIngestService,
    private readonly uow: UnitOfWork,
  ) {}

  private get config() {
    return this.appConfig.garmin;
  }

  onModuleInit(): void {
    if (!this.config.pollerEnabled) return;
    this.timer = setInterval(
      () => void this.tick().catch((error) => this.logger.error(`Garmin poll tick failed: ${(error as Error).message}`)),
      this.config.tickIntervalMs,
    );
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.idle();
  }

  /** Resolves when background syncs have finished (tests, graceful shutdown) */
  async idle(): Promise<void> {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  /** Starts the first sync right after a key is stored, without blocking the page */
  startInitialSync(connection: ProviderConnectionEntity): void {
    this.track(this.runConnection(connection, 'connect').catch((error) => this.logger.warn(`Initial Garmin sync failed: ${(error as Error).message}`)));
  }

  /**
   * One scheduler pass: connections that are due (not in backoff, not synced
   * recently), at most `concurrency` at a time. Public so tests and operators
   * can trigger it; the timer calls it every GARMIN_TICK_INTERVAL_MS.
   */
  async tick(now = new Date()): Promise<number> {
    if (this.ticking || this.stopped) return 0;
    this.ticking = true;
    try {
      const due = await this.repo.dueGarminConnections(now, this.config.concurrency);
      await Promise.allSettled(
        due.map((connection) =>
          this.runConnection(connection, 'scheduled').catch((error) => this.logger.warn(`Scheduled Garmin sync failed: ${(error as Error).message}`)),
        ),
      );
      return due.length;
    } finally {
      this.ticking = false;
    }
  }

  /**
   * "Sync now" for the current user. Safe to call repeatedly: while a run is
   * in progress, or right after a run finished, it returns that run's status
   * instead of calling Garmin again; during an error backoff it says when
   * the next attempt will happen.
   */
  async syncNow(user: CurrentUser): Promise<SyncRunView & { note?: string }> {
    const connection = await this.connections.activeConnection(user, 'garmin');
    const latest = await this.uow.manager.findOne(SyncRunEntity, { where: { connectionId: connection.id }, order: { startedAt: 'DESC' } });
    if (latest?.status === 'running' && latest.startedAt.getTime() > Date.now() - RUNNING_TIMEOUT_MS) {
      return { ...toSyncRunView(latest), note: 'A Garmin sync is already running; check again shortly with list_connections or list_sync_runs.' };
    }
    if (connection.backoffUntil && connection.backoffUntil.getTime() > Date.now()) {
      return {
        ...(latest ? toSyncRunView(latest) : emptyView(connection)),
        note: `Garmin is being given time to recover after errors or rate limiting; the next attempt is at ${connection.backoffUntil.toISOString()}.`,
      };
    }
    const throttleMs = this.config.manualMinIntervalSeconds * 1000;
    if (latest?.finishedAt && throttleMs > 0 && latest.finishedAt.getTime() > Date.now() - throttleMs) {
      return {
        ...toSyncRunView(latest),
        note: `The last Garmin sync finished less than ${this.config.manualMinIntervalSeconds} seconds ago; showing its result instead of calling Garmin again.`,
      };
    }
    return this.runConnection(connection, 'manual');
  }

  private track<T>(promise: Promise<T>): void {
    const tracked: Promise<unknown> = promise.finally(() => this.background.delete(tracked));
    this.background.add(tracked);
  }

  private async runConnection(connection: ProviderConnectionEntity, trigger: SyncTrigger): Promise<SyncRunView & { note?: string }> {
    // Atomic lease: of any number of concurrent refreshes, ticks or pods, exactly one gets to call Garmin
    const lease = await this.repo.claimSync(connection.id, new Date(), new Date(Date.now() + RUNNING_TIMEOUT_MS));
    if (!lease) {
      const current = await this.uow.manager.findOne(SyncRunEntity, { where: { connectionId: connection.id }, order: { startedAt: 'DESC' } });
      return { ...(current ? toSyncRunView(current) : emptyView(connection)), note: 'A Garmin sync is already running.' };
    }
    try {
      return await this.runClaimed(connection, trigger, lease);
    } finally {
      await this.repo.releaseSync(connection.id, lease).catch((error) => this.logger.warn(`Could not release Garmin sync lease: ${(error as Error).message}`));
    }
  }

  private async runClaimed(connection: ProviderConnectionEntity, trigger: SyncTrigger, lease: string): Promise<SyncRunView & { note?: string }> {
    const fresh = (await this.repo.findById(connection.id)) ?? connection;

    const startedAt = new Date();
    const polling = fresh.historyComplete || fresh.syncCursor !== null;
    const cursorAtStart = fresh.syncCursor;
    const run: SyncRunEntity = Object.assign(new SyncRunEntity(), {
      id: randomUUID(),
      userId: fresh.userId,
      connectionId: fresh.id,
      provider: 'garmin',
      trigger,
      kind: fresh.historyComplete ? 'incremental' : 'initial',
      status: 'running',
      windowStart: polling && cursorAtStart ? this.pollStart(cursorAtStart) : null,
      windowEnd: startedAt,
      pages: 0,
      fetched: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      error: null,
      startedAt,
      finishedAt: null,
    } as SyncRunEntity);
    await this.uow.manager.insert(SyncRunEntity, run);

    let note: string | undefined;
    const state = { cursor: null as Date | null, nextDelayMs: this.config.pollIntervalMs, failed: false, retryAfterMs: 0 };
    const holder = { token: '' };
    const last = { at: 0, lease };
    try {
      const adapter = this.registry.garmin;
      const call = <T>(work: (token: string) => Promise<T>): Promise<T> => this.request(fresh.id, holder, last, work);
      holder.token = await this.connections.accessToken(fresh.id, lease);

      let budget = this.config.maxPagesPerRun;
      const ingestPage = async (items: unknown[]) => {
        for (const item of items) {
          run.fetched++;
          try {
            const { outcome } = await this.ingest.ingest({ userId: fresh.userId, connectionId: fresh.id, provider: 'garmin', raw: item, source: 'sync' });
            run[outcome]++;
          } catch (error) {
            if (!(error instanceof ActivityMappingError)) throw error;
            run.skipped++;
            run.error = `Skipped unreadable activity: ${error.message}`;
          }
        }
      };

      let offset = fresh.historyOffset;
      let historyComplete = fresh.historyComplete;

      // 1. Poll for what is new since the cursor (skipped on the very first run: the history walk starts at the newest activity).
      //    Bounded by what is new rather than by the per-run page budget, so a long gap never turns into a re-walk of old history.
      if (cursorAtStart) {
        const startDate = ymd(this.pollStart(cursorAtStart));
        let polled = 0;
        let more = true;
        for (let page = 0; more && page < MAX_POLL_PAGES; page++) {
          const items = await call((token) => adapter.listPage(token, { start: polled, limit: this.config.pageSize, startDate }));
          run.pages++;
          polled += items.length;
          await ingestPage(items);
          more = items.length >= this.config.pageSize;
        }
        state.cursor = startedAt;
      }

      // 2. Walk older history, newest to oldest, resuming from the stored offset
      while (!historyComplete && budget > 0) {
        const limit =
          this.config.historyMaxActivities > 0 ? Math.min(this.config.pageSize, Math.max(this.config.historyMaxActivities - offset, 0)) : this.config.pageSize;
        const items = limit > 0 ? await call((token) => adapter.listPage(token, { start: offset, limit })) : [];
        budget--;
        run.pages++;
        await ingestPage(items);
        offset += items.length;
        const reachedLimit = this.config.historyMaxActivities > 0 && offset >= this.config.historyMaxActivities;
        historyComplete = items.length < limit || reachedLimit;
        await this.savePosition(fresh.id, lease, { historyOffset: offset, historyComplete });
        if (!state.cursor) state.cursor = startedAt; // the newest activities are covered once the first page is in
        if (reachedLimit && items.length >= limit) note = `History import stopped at GARMIN_HISTORY_MAX_ACTIVITIES (${this.config.historyMaxActivities}).`;
      }

      if (!historyComplete) {
        run.status = 'partial';
        run.error = `History import is in progress (${offset} activities walked); it continues automatically`;
        state.nextDelayMs = this.config.tickIntervalMs;
      } else {
        run.status = 'succeeded';
      }
    } catch (error) {
      if (error instanceof LeaseLost) {
        // Another worker owns the connection now: record this run as aborted, leave scheduling/position state to the owner
        run.status = 'failed';
        run.error = error.message;
        run.finishedAt = new Date();
        await this.uow.manager.save(SyncRunEntity, run);
        this.logger.warn(`Garmin sync ${run.id} aborted: lease lost`);
        return { ...toSyncRunView(run), note: 'This sync lost its lease to another worker and stopped.' };
      }
      state.failed = !(error instanceof KeyRejected || error instanceof ReauthorizationRequiredError);
      const message =
        error instanceof DomainError ? error.message : error instanceof KeyRejected ? error.message : `Unexpected error: ${(error as Error).message}`;
      run.status = run.fetched > 0 && state.failed ? 'partial' : 'failed';
      run.error = message.slice(0, 2000);
      if (error instanceof UpstreamRateLimitedError) state.retryAfterMs = Number(error.details?.retryAfterSeconds ?? 0) * 1000;
      if (!(error instanceof DomainError) && !(error instanceof KeyRejected)) this.logger.error(`Garmin sync ${run.id} failed`, (error as Error).stack);
      if (error instanceof KeyRejected || error instanceof ReauthorizationRequiredError)
        note = 'Create a new Garmin Personal API key and run connect_garmin again.';
    }
    run.finishedAt = new Date();
    await this.uow.manager.save(SyncRunEntity, run);

    if (!(await this.finish(fresh.id, lease, run, state))) {
      this.logger.warn(`Garmin sync ${run.id} lost its lease before finishing; scheduling state left to the new owner`);
      run.status = 'failed';
      run.error = 'Garmin sync lease was lost';
      await this.uow.manager.save(SyncRunEntity, run);
      return { ...toSyncRunView(run), note: 'This sync lost its lease to another worker and stopped.' };
    }
    this.logger.log(
      `Garmin sync ${run.id} (${trigger}) ${run.status}: ${run.pages} pages, ${run.fetched} fetched, ${run.created} new, ${run.updated} updated, ${run.unchanged} unchanged`,
    );
    return { ...toSyncRunView(run), ...(note ? { note } : {}) };
  }

  /** Updates scheduling and error state after a run. The cursor advances only when the run covered everything newer than it */
  private async finish(
    connectionId: string,
    lease: string,
    run: SyncRunEntity,
    state: { cursor: Date | null; nextDelayMs: number; failed: boolean; retryAfterMs: number },
  ): Promise<boolean> {
    const connection = await this.repo.findById(connectionId);
    if (!connection) return true;
    const now = Date.now();
    if (run.status === 'failed' || state.failed) {
      if (state.failed) {
        connection.failureCount += 1;
        const exponential = this.config.tickIntervalMs * 2 ** Math.min(connection.failureCount, 20);
        const delay = Math.min(this.config.maxBackoffMs, Math.max(exponential, state.retryAfterMs));
        connection.backoffUntil = new Date(now + delay);
        connection.nextSyncAt = connection.backoffUntil;
      }
    } else {
      connection.failureCount = 0;
      connection.backoffUntil = null;
      connection.nextSyncAt = new Date(now + state.nextDelayMs);
    }
    if (state.cursor && (!connection.syncCursor || state.cursor > connection.syncCursor)) connection.syncCursor = state.cursor;
    connection.lastSyncAt = run.finishedAt;
    // A connection that needs the user's attention keeps the specific message recorded when it was marked so;
    // a partial history walk is progress, not an error worth showing as one
    if (connection.status === 'active') {
      connection.lastError = run.status === 'succeeded' || (run.status === 'partial' && !state.failed) ? null : run.error;
      if (connection.lastError) connection.lastErrorAt = new Date();
    }
    // Do not overwrite status/key changes made while the run was going (e.g. needs_reauth)
    return this.repo.updateOwned(connectionId, lease, {
      failureCount: connection.failureCount,
      backoffUntil: connection.backoffUntil,
      nextSyncAt: connection.nextSyncAt,
      syncCursor: connection.syncCursor,
      lastSyncAt: connection.lastSyncAt,
      lastError: connection.lastError,
      lastErrorAt: connection.lastErrorAt,
    });
  }

  private async savePosition(connectionId: string, lease: string, position: { historyOffset: number; historyComplete: boolean }): Promise<void> {
    if (!(await this.repo.updateOwned(connectionId, lease, position))) throw new LeaseLost('Garmin sync lease was lost');
  }

  private pollStart(cursor: Date): Date {
    return new Date(cursor.getTime() - this.appConfig.sync.overlapHours * 3_600_000);
  }

  /**
   * One Garmin call with pacing and retries. Network errors, 5xx and 429
   * retry with exponential backoff (Retry-After wins, capped); a rejected
   * access token is replaced once from the key; a rejected key stops the run.
   */
  private async request<T>(
    connectionId: string,
    holder: { token: string },
    last: { at: number; lease: string },
    work: (token: string) => Promise<T>,
  ): Promise<T> {
    let replacedToken = false;
    for (let attempt = 0; ; attempt++) {
      const wait = last.at + this.config.minRequestIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      last.at = Date.now();
      if (!(await this.repo.renewSync(connectionId, last.lease, new Date(last.at + RUNNING_TIMEOUT_MS)))) throw new LeaseLost('Garmin sync lease was lost');
      try {
        const result = await work(holder.token);
        // The call may have outlived the lease: confirm we still own the connection before the caller persists anything
        if (!(await this.repo.renewSync(connectionId, last.lease, new Date(Date.now() + RUNNING_TIMEOUT_MS))))
          throw new LeaseLost('Garmin sync lease was lost');
        return result;
      } catch (error) {
        if (error instanceof LeaseLost) throw error;
        if (error instanceof SyncLeaseLostError) throw new LeaseLost(error.message);
        if (error instanceof ProviderAuthError) {
          if (replacedToken) {
            await this.connections.markNeedsReauth(
              connectionId,
              'Garmin rejected the access token obtained from your key; create a new personal API key and run connect_garmin again',
              last.lease,
            );
            throw new KeyRejected('Garmin rejected the personal API key');
          }
          replacedToken = true;
          await this.connections.discardAccessToken(connectionId, last.lease);
          holder.token = await this.connections.accessToken(connectionId, last.lease);
          attempt--;
          continue;
        }
        if (!(error instanceof UpstreamError || error instanceof UpstreamRateLimitedError) || attempt >= this.config.maxRetries) throw error;
        const retryAfter = error instanceof UpstreamRateLimitedError ? Number(error.details?.retryAfterSeconds ?? 0) * 1000 : 0;
        await sleep(Math.min(this.config.maxBackoffMs, Math.max(retryAfter, this.config.retryBaseMs * 2 ** attempt)));
      }
    }
  }
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function emptyView(connection: ProviderConnectionEntity): SyncRunView {
  return {
    id: '',
    provider: 'garmin',
    trigger: 'manual',
    kind: connection.historyComplete ? 'incremental' : 'initial',
    status: 'failed',
    windowStart: null,
    windowEnd: null,
    pages: 0,
    fetched: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    error: connection.lastError,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
}
