import {Temporal} from '@js-temporal/polyfill';
import {database,type Database,type Row} from './db';
import {synchronize,synchronizeMetaAds} from './sync';
import {synchronizeWix} from './sync-wix';
import {synchronizeWixTransactionCounts} from './wix-transaction-counts';
import {postHogPeriod,postHogMasterclassPeriod} from './posthog-dashboard';
import {NOTION_BUSINESS_VERSION} from '../connectors/notion-business';
import {META_ACCOUNT_PROFILE} from '../connectors/meta-account-analytics';
import {WIX_PAYMENTS_ANALYTICS_MAPPING} from '../connectors/wix-payments-analytics';
import {WIX_RECEIPTS_PROFILE} from './wix-transaction-counts';
import {postHogScopeProfile,postHogMasterclassProfile,postHogClientProfile,POSTHOG_DEFAULT_SCOPE} from '../connectors/posthog-analytics';
import {AppError} from './errors';
export type SyncJob='notion'|'meta'|'wix'|'receipts'|'meta_ads'|'quiz'|'masterclass';
const definitions:{id:SyncJob;source:string;stream:string;cadence:number}[]=[
 {id:'notion',source:'notion',stream:'prospects_business',cadence:3600000},
 {id:'meta',source:'meta',stream:'meta_account_daily',cadence:3600000},
 {id:'wix',source:'wix',stream:'payments_analytics',cadence:3600000},
 {id:'receipts',source:'wix',stream:'receipt_observations',cadence:3600000},
 {id:'meta_ads',source:'meta',stream:'ad_daily',cadence:86400000},
 {id:'quiz',source:'posthog',stream:'quiz_observations',cadence:86400000},
 {id:'masterclass',source:'posthog',stream:'masterclass_observations',cadence:86400000},
];
export function chooseSyncJob(runs:Row[],now:number,enabled:SyncJob[]):SyncJob|null {
 const due=definitions.filter(d=>enabled.includes(d.id)).flatMap(d=>{
  const streamRuns=runs.filter(r=>r.source===d.source&&r.stream_key===d.stream);
  if(streamRuns.some(r=>r.status==='running'&&Date.parse(String(r.lease_until??r.started_at))>now-(r.lease_until?0:120000)))return [];
  const latest=streamRuns.sort((a,b)=>Date.parse(String(b.lease_until??b.finished_at??b.started_at))-Date.parse(String(a.lease_until??a.finished_at??a.started_at)))[0];
  const touched=latest?Date.parse(String(latest.lease_until??latest.finished_at??latest.started_at)):0;
  const cadence=latest?.status==='running'&&d.id==='notion'?0:latest?.status==='failed'?300000:d.cadence;
  return !latest||now-touched>=cadence?[{id:d.id,touched}]:[];
 });
 return due.sort((a,b)=>a.touched-b.touched)[0]?.id??null;
}
/** One source invocation per tick. No scheduler is enabled by this handler. */
export async function tickSyncJobs(db:Database=database(),env:NodeJS.ProcessEnv=process.env){
 if(env.COCKPIT_MODE==='demo')throw new AppError('Données de démonstration.',409,'demo_mode');
 const namespaces:Record<string,string|undefined>={notion:env.NOTION_DATA_SOURCE_ID,meta:env.META_AD_ACCOUNT_ID?.replace(/^act_/,''),wix:env.WIX_SITE_ID,posthog:env.POSTHOG_PROJECT_ID};
 const enabled=definitions.filter(d=>namespaces[d.source]).map(d=>d.id),runs:Row[]=[];
 const client=postHogClientProfile(env);
 const profiles:Record<SyncJob,string>={notion:NOTION_BUSINESS_VERSION,meta:META_ACCOUNT_PROFILE,wix:WIX_PAYMENTS_ANALYTICS_MAPPING.version,receipts:WIX_RECEIPTS_PROFILE,meta_ads:`${env.META_API_VERSION||'v23.0'}-ad-day-none`,quiz:postHogScopeProfile(POSTHOG_DEFAULT_SCOPE,client),masterclass:postHogMasterclassProfile(client)};
 for(const d of definitions.filter(d=>enabled.includes(d.id))){
  const rows=await db.select('sync_runs',{eq:{source:d.source,source_namespace:namespaces[d.source]!,stream_key:d.stream,query_profile_key:profiles[d.id]},order:'started_at',descending:true,limit:5});
  runs.push(...rows);
 }
 const job=chooseSyncJob(runs,Date.now(),enabled);if(!job)return {status:'complete',job:null,reason:'Toutes les lectures prévues sont à jour ou en cours.'};
 const today=Temporal.Now.plainDateISO('Europe/Paris'),to=today.add({days:1}).toString(),from=today.with({day:1}).subtract({months:1}).toString();
 const result=job==='notion'||job==='meta'?await synchronize(job):job==='wix'?await synchronizeWix(from,to):job==='receipts'?await synchronizeWixTransactionCounts(from,to):job==='meta_ads'?await synchronizeMetaAds():job==='quiz'?await postHogPeriod(from,to):await postHogMasterclassPeriod(from,to);
 return {...result,job};
}
