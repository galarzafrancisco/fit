import type { Provider } from '@fit/activity-model';
import type { SyncRunEntity } from './sync-run.entity';

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

export function toSyncRunView(run: SyncRunEntity): SyncRunView {
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
