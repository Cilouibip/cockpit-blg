import { Temporal } from '@js-temporal/polyfill';
import { database, type Database, type Row } from './db';
import { jobScope, loadSyncJobRuns, PILOT_REFRESH_JOBS, syncJobRunFilter, type SyncJob } from './sync-jobs';

export type SyncHealthState = 'healthy' | 'stale' | 'unknown';
export const SYNC_HEALTH_CODES = ['PUBLICATION_CURRENT','CONFIGURATION_UNKNOWN','DATABASE_UNAVAILABLE','CLOCK_INVALID','PUBLICATION_ABSENT','PUBLICATION_INVALID','TIMESTAMP_INVALID','TIMESTAMP_FUTURE','TIMESTAMP_ORDER_INVALID','CURRENT_WINDOW_MISMATCH','COVERAGE_INVALID','PUBLICATION_STALE','LATEST_ATTEMPT_FAILED'] as const;
export type SyncHealthCode = typeof SYNC_HEALTH_CODES[number];
export interface SyncJobHealth { job: SyncJob; state: SyncHealthState; code: SyncHealthCode; cutoff: string | null; publishedAt: string | null; ageMinutes: number | null }
export interface SyncHealthReport { status: SyncHealthState; checkedAt: string | null; maxAgeMinutes: 60; jobs: SyncJobHealth[]; limits: string[] }
const MAX_AGE_MS = 60 * 60_000;
const validClock = (now: number): boolean => { try { Temporal.Instant.fromEpochMilliseconds(now);return Number.isSafeInteger(now); } catch { return false; } };
const columns = ['id','source','source_namespace','stream_key','query_profile_key','status','pagination_complete','rows_rejected','error_code','started_at','finished_at','source_as_of','period_from','period_to','covered_from','covered_to'];
const instant = (value: unknown): number | null => {
 if (typeof value !== 'string') return null;
 try { return Temporal.Instant.from(value).epochMilliseconds; } catch { return null; }
};
const compare = (a: unknown, b: unknown) => Temporal.Instant.compare(String(a),String(b));
const result = (job: SyncJob, state: SyncHealthState, code: SyncHealthCode, proof?: { cutoff: number; finished: number; now: number }): SyncJobHealth => ({ job, state, code, cutoff: proof ? new Date(proof.cutoff).toISOString() : null, publishedAt: proof ? new Date(proof.finished).toISOString() : null, ageMinutes: proof ? (proof.now - proof.cutoff) / 60_000 : null });

/** Publication proof only. It neither reads sources nor runs/retries the collector. */
export function evaluateSyncJobHealth(job: SyncJob, rows: Row[], scope: { namespace: string; profile: string }, now: number): SyncJobHealth {
 if (!validClock(now)) return result(job, 'unknown', 'CLOCK_INVALID');
 const eq = syncJobRunFilter(job, scope);
 const exact = rows.filter(row => Object.entries(eq).every(([key, value]) => row[key] === value));
 const publications = exact.filter(row => ['complete','empty'].includes(String(row.status))).sort((a,b) => (instant(b.finished_at) ?? Infinity) - (instant(a.finished_at) ?? Infinity));
 const publication = publications[0];
 if (!publication) return result(job, 'unknown', 'PUBLICATION_ABSENT');
 if (publication.pagination_complete !== true || publication.rows_rejected !== 0 || publication.error_code) return result(job, 'unknown', 'PUBLICATION_INVALID');
 const started = instant(publication.started_at), finished = instant(publication.finished_at), observed = instant(publication.source_as_of);
 const from = instant(publication.period_from), to = instant(publication.period_to);
 if (started === null || finished === null || observed === null || from === null || to === null) return result(job, 'unknown', 'TIMESTAMP_INVALID');
 if ([publication.started_at,publication.finished_at,publication.source_as_of].some(at => compare(at,new Date(now).toISOString()) > 0)) return result(job, 'unknown', 'TIMESTAMP_FUTURE');
 if (compare(publication.started_at,publication.finished_at) > 0 || compare(publication.source_as_of,publication.finished_at) > 0 || compare(publication.period_from,publication.period_to) >= 0) return result(job, 'unknown', 'TIMESTAMP_ORDER_INVALID');
 let cutoff = Math.min(started, finished, observed);
 if (job === 'notion' || job === 'forms') {
  // Forms uses DEFAULT now() for source_as_of/start (transaction start), but clock_timestamp()
  // for period_to (claim cutoff). Their order is not a coverage invariant; both stay in the conservative min.
  // Notion explicitly publishes source_as_of=period_to. Lower delta bounds stay the worker's existing ones.
  if (compare(publication.period_to,new Date(now).toISOString()) > 0 || compare(publication.period_to,publication.finished_at) > 0) return result(job, 'unknown', 'TIMESTAMP_FUTURE');
  if (instant(publication.covered_from) !== from || instant(publication.covered_to) !== to || compare(publication.covered_from,publication.period_from) !== 0 || compare(publication.covered_to,publication.period_to) !== 0 || (job === 'notion' && compare(publication.period_to,publication.source_as_of) > 0)) return result(job, 'unknown', 'COVERAGE_INVALID');
  cutoff = Math.min(cutoff, to);
 } else {
  const today = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO('Europe/Paris').toPlainDate();
  const expectedFrom = job === 'masterclass' ? today.with({ day: 1 }).subtract({ months: 1 }) : today.subtract({ days: 35 });
  const expectedTo = today.add({ days: 1 });
  const bound = (day: Temporal.PlainDate) => day.toZonedDateTime('Europe/Paris').toInstant().epochMilliseconds;
  if (compare(publication.period_from,new Date(bound(expectedFrom)).toISOString()) !== 0 || compare(publication.period_to,new Date(bound(expectedTo)).toISOString()) !== 0) return result(job, 'unknown', 'CURRENT_WINDOW_MISMATCH');
  // Aggregate publication SQL proves covered=period, just like Forms. A current
  // requested window cannot compensate for absent or older covered bounds.
  if (instant(publication.covered_from) !== from || instant(publication.covered_to) !== to || compare(publication.covered_from,publication.period_from) !== 0 || compare(publication.covered_to,publication.period_to) !== 0) return result(job, 'unknown', 'COVERAGE_INVALID');
 }
 const proof = { cutoff, finished, now };
 if (now - cutoff > MAX_AGE_MS) return result(job, 'stale', 'PUBLICATION_STALE', proof);
 // Only an attempt from this exact scope can flag a collector failure.
 const latest = exact.sort((a,b) => (instant(b.started_at) ?? Infinity) - (instant(a.started_at) ?? Infinity))[0];
 const latestAt = latest && instant(latest.started_at);
 if (latestAt === null || latestAt === undefined) return result(job, 'unknown', 'TIMESTAMP_INVALID', proof);
 if (compare(latest.started_at,new Date(now).toISOString()) > 0) return result(job, 'unknown', 'TIMESTAMP_FUTURE', proof);
 if (latest.status === 'failed' || latest.error_code) return result(job, 'stale', 'LATEST_ATTEMPT_FAILED', proof);
 return result(job, 'healthy', 'PUBLICATION_CURRENT', proof);
}

export async function readSyncHealth(db: Database | undefined = undefined, env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): Promise<SyncHealthReport> {
 const store = (() => { try { return db ?? database(); } catch { return null; } })();
 const jobs = await Promise.all(PILOT_REFRESH_JOBS.map(async job => {
  if (!validClock(now)) return result(job, 'unknown', 'CLOCK_INVALID');
  let scope: ReturnType<typeof jobScope>;
  try { scope = jobScope(job, env); } catch { return result(job, 'unknown', 'CONFIGURATION_UNKNOWN'); }
  if (!scope) return result(job, 'unknown', 'CONFIGURATION_UNKNOWN');
  if (!store) return result(job, 'unknown', 'DATABASE_UNAVAILABLE');
  try {
   const rows = await loadSyncJobRuns(store, new Map([[job,scope]]), [job], options => store.select('sync_runs', { ...options, columns, timeoutMs: 5_000 }));
   return evaluateSyncJobHealth(job, rows, scope, now);
  } catch { return result(job, 'unknown', 'DATABASE_UNAVAILABLE'); }
 }));
 const status = jobs.some(job => job.state === 'unknown') ? 'unknown' : jobs.some(job => job.state === 'stale') ? 'stale' : 'healthy';
 return { status, checkedAt: validClock(now) ? new Date(now).toISOString() : null, maxAgeMinutes: 60, jobs, limits: ['GITHUB_SCHEDULE_CAN_BE_DELAYED','NOTION_ARCHIVE_INVENTORY_HAS_SEPARATE_COVERAGE','LIVE_BROWSER_DETAIL_NOT_MONITORED','NOTIFICATION_DELIVERY_NOT_GUARANTEED'] };
}
