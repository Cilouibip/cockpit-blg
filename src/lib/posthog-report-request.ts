import {Temporal} from '@js-temporal/polyfill';
import {postHogClientProfile,postHogScopeProfile,postHogMasterclassProfile,type PostHogClientProfile,type PostHogDimensionScope} from '../connectors/posthog-analytics';
import {database,type Database} from './db';
import {readPostHogPeriod,readPostHogMasterclassPeriod,postHogPeriod,postHogMasterclassPeriod,postHogScopeFromFilters} from './posthog-dashboard';
import {invalidateSourceSnapshots} from './source-snapshots';
import type {DashboardFilters} from './ui-contract';
import {postHogReportSelectionKey} from './posthog-report-controller';

export type PostHogReportType='quiz'|'masterclass';
export interface PostHogReportRequest {
 key:string;type:PostHogReportType;profile:string;stream:string;from:string;to:string;namespace:string;
 scope:PostHogDimensionScope;client:PostHogClientProfile;
}
export interface PostHogReportState {
 key:string;state:'ready'|'waiting'|'failed'|'unsupported';message:string;
 observedAt?:string|null;empty?:boolean;retryAfterMs?:number;
}
type PublishedReport={status:string;observedAt:string|null;coverage:{queryComplete:boolean}};
type Options={db?:Database;namespace?:string;client?:PostHogClientProfile;now?:()=>number;
 read?:(request:PostHogReportRequest)=>Promise<PublishedReport|null>;
 start?:(request:PostHogReportRequest)=>Promise<PublishedReport|null>};
const pending=new WeakMap<Database,Map<string,Promise<PostHogReportState>>>();
const published=(report:PublishedReport|null):report is PublishedReport=>!!report&&report.coverage.queryComplete&&['complete','empty'].includes(report.status);

/** Source-free descriptor for GET /reports/posthog. The client uses this opaque
 * key, including the exact configured project/client/page profile. */
export function postHogReportRequest(filters:DashboardFilters,type:PostHogReportType,client=postHogClientProfile(),namespace=process.env.POSTHOG_PROJECT_ID??''):PostHogReportRequest|null {
 if(!['quiz','masterclass'].includes(type))return null;
 if(['quiz','masterclass'].includes(filters.tunnel)&&filters.tunnel!==type)return null;
 const scope=postHogScopeFromFilters(filters);if(!scope||(type==='masterclass'&&(scope.source!=='all'||scope.campaignId)))return null;
 const start=Temporal.PlainDate.from(filters.from),end=Temporal.PlainDate.from(filters.to).add({days:1});
 if(start.until(end).days<1||start.until(end).days>367)return null;
 const profile=type==='quiz'?postHogScopeProfile(scope,client):postHogMasterclassProfile(client),from=start.toString(),to=end.toString();
 return {key:postHogReportSelectionKey(filters,type,{namespace,profile}),namespace,type,profile,from,to,scope,client,stream:type==='quiz'?'quiz_observations':'masterclass_observations'};
}

/** POST-only preparation. One source report per invocation; GET dashboard stays
 * database-only. A source answer is insufficient: ready requires publication. */
export async function requestPostHogReport(filters:DashboardFilters,type:PostHogReportType,options:Options={}):Promise<PostHogReportState>{
 const namespace=options.namespace??process.env.POSTHOG_PROJECT_ID;
 const request=postHogReportRequest(filters,type,options.client,namespace),key=request?.key??JSON.stringify([type,filters.from,filters.to,filters.source,filters.campaign]);
 if(!request)return {key,state:'unsupported',message:'Ces filtres ne sont pas encore disponibles pour ce parcours.'};
 if(!namespace)return {key,state:'failed',message:'La connexion aux statistiques de visite est indisponible.'};
 const db=options.db??database(),cacheKey=namespace+':'+request.profile+':'+key;
 let entries=pending.get(db);if(!entries){entries=new Map();pending.set(db,entries);}
 const hit=entries.get(cacheKey);if(hit)return hit;
 const waiting=():PostHogReportState=>({key,state:'waiting',message:'Ces chiffres sont en cours de chargement.',retryAfterMs:15000});
 if(entries.size>=16)return waiting();
 const configured=()=>{if(namespace!==process.env.POSTHOG_PROJECT_ID)throw new Error('posthog_namespace_mismatch');};
 const read=options.read??(r=>{configured();return r.type==='quiz'?readPostHogPeriod(db,r.from,r.to,{scope:r.scope,client:r.client}):readPostHogMasterclassPeriod(db,r.from,r.to,{client:r.client});});
 const start=options.start??(r=>{configured();return r.type==='quiz'?postHogPeriod(r.from,r.to,{db,scope:r.scope,client:r.client}):postHogMasterclassPeriod(r.from,r.to,{db,client:r.client});});
 const active=async()=>{
  const rows=await db.select('sync_runs',{eq:{source:'posthog',source_namespace:namespace,stream_key:request.stream,query_profile_key:request.profile,status:'running'},order:'started_at',descending:true,limit:1});
  return rows.some(row=>Number.isFinite(Date.parse(String(row.started_at)))&&Date.parse(String(row.started_at))>(options.now?.()??Date.now())-10*60_000);
 };
 const fresh=(report:PublishedReport|null):report is PublishedReport=>{
  if(!published(report))return false;
  const now=options.now?.()??Date.now(),today=Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO('Europe/Paris').toPlainDate().toString();
  const observed=Date.parse(report.observedAt??''),end=Temporal.PlainDate.from(request.to).toZonedDateTime('Europe/Paris').epochMilliseconds;
  if(request.from<=today&&today<request.to)return Number.isFinite(observed)&&observed>now-15*60_000;
  // A report observed during its last day gets one final read after that day
  // closes. Older closed reports are otherwise reused, without permanent polling.
  if(end<=now)return Number.isFinite(observed)&&observed>=end;
  return true;
 };
 const ready=(report:PublishedReport):PostHogReportState=>({key,state:'ready',message:'Ces chiffres sont disponibles pour cette période.',observedAt:report.observedAt,empty:report.status==='empty'});
 const failed=():PostHogReportState=>({key,state:'failed',message:'Ces chiffres n’ont pas pu être chargés. Réessaie.'});
 const work=(async()=>{
  try {
   // A previous missing lookup must not hide a report published by another worker.
   invalidateSourceSnapshots(db);
   const existing=await read(request);if(fresh(existing))return ready(existing);
   if(await active())return waiting();
   const result=await start(request);
   invalidateSourceSnapshots(db);
   const stored=await read(request);if(fresh(stored))return ready(stored);
   // The persistent stream lock also handles a race after our initial probe.
   if(!published(result)&&await active())return waiting();
   return failed();
  }catch{return failed();}
 })();
 entries.set(cacheKey,work);try{return await work;}finally{entries.delete(cacheKey);}
}
