import { createHash } from 'node:crypto';
import { database, type Database, type Row } from './db';
import { ALL_REFRESH_JOBS, configuredJobScope, jobScope, loadSyncJobRuns, refreshCadences, syncJobRunFilter, syncStreamStates, type SyncJob } from './sync-jobs';
import { evaluateSyncJobHealth } from './sync-health';

export interface RefreshState { publicationId: string | null; pending: boolean; stale: boolean }
const columns = ['id','source','source_namespace','stream_key','query_profile_key','status','pagination_complete','rows_rejected','error_code','started_at','finished_at','source_as_of','period_from','period_to','covered_from','covered_to','lease_until'];
/** Only immutable completed publications change the screen revision. A checkpoint,
 * successful HTTP request, failed attempt or lease can never stand in for one. */
export async function readRefreshState(db: Database = database(), env: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<RefreshState> {
 const scopes = new Map<SyncJob,{namespace:string;profile:string}>();
 let configurationMissing = false;
 for (const job of ALL_REFRESH_JOBS) {
  const scope = configuredJobScope(job,env);
  if (scope) scopes.set(job,scope); else configurationMissing = true;
  if (!jobScope(job,env)) configurationMissing = true;
 }
 const jobs = [...scopes.keys()];
 const rows = await loadSyncJobRuns(db,scopes,jobs,options=>db.select('sync_runs',{...options,columns,timeoutMs:5000}));
 const states = syncStreamStates(rows,now,jobs,refreshCadences(env));
 const publications: string[] = [];
 let invalid = false;
 for (const job of jobs) {
  const scope = scopes.get(job)!;
  const health = evaluateSyncJobHealth(job,rows,scope,now);
  if (health.state !== 'healthy') invalid = true;
  const eq = syncJobRunFilter(job,scope);
  const publication = rows.filter(row=>Object.entries(eq).every(([key,value])=>row[key]===value)&&
   ['complete','empty'].includes(String(row.status))&&row.pagination_complete===true&&row.rows_rejected===0&&!row.error_code)
   .sort((a:Row,b:Row)=>String(b.finished_at).localeCompare(String(a.finished_at)))[0];
  if (publication) publications.push([job,publication.id,publication.finished_at,publication.source_as_of].join(':'));
 }
 return {
  publicationId: publications.length ? createHash('sha256').update(publications.sort().join('|')).digest('hex') : null,
  pending: states.some(state=>state.state==='waiting'),
  stale: configurationMissing || invalid || states.some(state=>state.state!=='complete'),
 };
}
