import type { Coverage, Source } from '../domain/models';

export type SyncStatus = 'complete' | 'empty' | 'partial' | 'failed' | 'not_configured';
export interface Checkpoint { cursor?: string; completedThrough?: string }
export interface SyncCounts { read: number; accepted: number; rejected: number; pages: number }
export interface SyncBatch<T> {
  source: Source; accountId: string; version: string; status: SyncStatus; records: T[];
  coverage: Coverage; checkpoint: Checkpoint; counts: SyncCounts; safeError?: string;
}
export interface PageCommit<T> { records: T[]; checkpoint: Checkpoint; terminal: boolean }
export interface SyncOptions<T> {
  from: string; to: string; fetcher?: typeof fetch; maxPages?: number; cursor?: string;
  /** Persist page + checkpoint in ONE transaction. Throwing leaves the prior checkpoint intact. */
  commitPage?: (page: PageCommit<T>) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>; now?: () => string;
}
export function newBatch<T>(source: Source, accountId: string, version: string, from: string, to: string): SyncBatch<T> {
  return { source, accountId, version, status: 'not_configured', records: [], coverage: { from, to, complete: false, reason: 'Connexion non configurée' }, checkpoint: {}, counts: { read: 0, accepted: 0, rejected: 0, pages: 0 } };
}
