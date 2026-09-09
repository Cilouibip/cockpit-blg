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
import {createSyncExecutionBudget} from './sync-budget';
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
  const latest=[...streamRuns].sort((a,b)=>Date.parse(String(b.lease_until??b.finished_at??b.started_at))-Date.parse(String(a.lease_until??a.finished_at??a.started_at)))[0];
  const touched=latest?Date.parse(String(latest.lease_until??latest.finished_at??latest.started_at)):0;
  const cadence=latest?.status==='running'&&d.id==='notion'?0:latest?.status==='failed'?300000:d.cadence;
  return !latest||now-touched>=cadence?[{id:d.id,touched}]:[];
 });
 return due.sort((a,b)=>a.touched-b.touched)[0]?.id??null;
}
const sourceTimeoutMs:Record<SyncJob,number>={notion:20_000,meta:25_000,wix:25_000,receipts:25_000,meta_ads:30_000,quiz:30_000,masterclass:30_000};
type Budget=Pick<ReturnType<typeof createSyncExecutionBudget>,'sourceFetch'|'canStart'|'dispose'>;
type TickResult={status:string};
type TickSummary={status:string;job:SyncJob|null;jobs:SyncJob[];units:number;unitResults:{job:SyncJob;status:string}[];reason?:string};
type TickOptions={now?:()=>number;budget?:Budget;execute?:(job:SyncJob,options:{db:Database;env:NodeJS.ProcessEnv;fetcher:typeof fetch})=>Promise<TickResult>};
async function executeSyncJob(job:SyncJob,from:string,to:string,options:{db:Database;env:NodeJS.ProcessEnv;fetcher:typeof fetch}):Promise<TickResult>{
 return (job==='notion'||job==='meta'?await synchronize(job,undefined,undefined,options):job==='wix'?await synchronizeWix(from,to,options):job==='receipts'?await synchronizeWixTransactionCounts(from,to,options):job==='meta_ads'?await synchronizeMetaAds(undefined,undefined,options):job==='quiz'?await postHogPeriod(from,to,options)??{status:'failed'}:await postHogMasterclassPeriod(from,to,options)??{status:'failed'}) as TickResult;
}
/** A tick runs small persisted units while its shared budget permits it. No scheduler is enabled here.
 * Database calls have no abort signal today, so their own client timeout remains
 * the limit; the 45 s budget cannot yet guarantee an end-to-end hard cutoff. */
export async function tickSyncJobs(db:Database=database(),env:NodeJS.ProcessEnv=process.env,options:TickOptions={}):Promise<TickSummary>{
 if(env.COCKPIT_MODE==='demo')throw new AppError('Données de démonstration.',409,'demo_mode');
 const namespaces:Record<string,string|undefined>={notion:env.NOTION_DATA_SOURCE_ID,meta:env.META_AD_ACCOUNT_ID?.replace(/^act_/,''),wix:env.WIX_SITE_ID,posthog:env.POSTHOG_PROJECT_ID};
 const enabled=definitions.filter(d=>namespaces[d.source]).map(d=>d.id);
 const client=postHogClientProfile(env);
 const profiles:Record<SyncJob,string>={notion:NOTION_BUSINESS_VERSION,meta:META_ACCOUNT_PROFILE,wix:WIX_PAYMENTS_ANALYTICS_MAPPING.version,receipts:WIX_RECEIPTS_PROFILE,meta_ads:`${env.META_API_VERSION||'v23.0'}-ad-day-none`,quiz:postHogScopeProfile(POSTHOG_DEFAULT_SCOPE,client),masterclass:postHogMasterclassProfile(client)};
 const loadRuns=async()=>{const runs:Row[]=[];for(const d of definitions.filter(d=>enabled.includes(d.id)))runs.push(...await db.select('sync_runs',{eq:{source:d.source,source_namespace:namespaces[d.source]!,stream_key:d.stream,query_profile_key:profiles[d.id]},order:'started_at',descending:true,limit:5}));return runs;};
 const budget=options.budget??createSyncExecutionBudget(),now=options.now??Date.now,jobs:SyncJob[]=[],results:TickResult[]=[];let notionChunks=0,last:TickResult|undefined,budgetStopped=false;const failed=new Set<SyncJob>();
 const today=Temporal.Now.plainDateISO('Europe/Paris'),to=today.add({days:1}).toString(),from=today.with({day:1}).subtract({months:1}).toString();
 try {
  for(;;){
   const runnable=enabled.filter(id=>!failed.has(id)&&!(id==='notion'&&notionChunks>=4)),runs=await loadRuns();
   const job=chooseSyncJob(runs,now(),runnable.filter(id=>budget.canStart(sourceTimeoutMs[id])));
   if(!job){if(chooseSyncJob(runs,now(),runnable))budgetStopped=true;break;}
   let result:TickResult;
   try {result=await (options.execute??((selected,ctx)=>executeSyncJob(selected,from,to,ctx)))(job,{db,env,fetcher:budget.sourceFetch});}
   catch {result={status:'failed'};failed.add(job);}
   jobs.push(job);results.push(result);last=result;if(job==='notion')notionChunks++;
   if(job!=='notion'||result.status==='failed')failed.add(job);
  }
  const unitResults=results.map((result,index)=>({job:jobs[index],status:result.status}));
  if(!last)return {status:budgetStopped?'partial':'complete',job:null,jobs,units:0,unitResults,reason:budgetStopped?'Le budget restant ne permet aucune unité due ; reprise au prochain tick.':'Toutes les lectures prévues sont à jour ou en cours.'};
  return {status:failed.size||budgetStopped?'partial':last.status,job:jobs.at(-1)!,jobs,units:results.length,unitResults,...(budgetStopped?{reason:'Le budget restant ne permet aucune autre unité due ; reprise au prochain tick.'}:{})};
 } finally {budget.dispose();}
}
