import {Temporal} from '@js-temporal/polyfill';
import {database,type Database,type Row} from './db';
import {synchronize,synchronizeMetaAds} from './sync';
import {synchronizeWix} from './sync-wix';
import {synchronizeWixTransactionCounts} from './wix-transaction-counts';
import {postHogPeriod,postHogMasterclassPeriod} from './posthog-dashboard';
import {synchronizeLeadEntries} from './sync-lead-entries';
import {refreshNotionCommerce} from './sync-notion-commerce';
import {NOTION_BUSINESS_VERSION} from '../connectors/notion-business';
import {META_ACCOUNT_PROFILE} from '../connectors/meta-account-analytics';
import {WIX_PAYMENTS_ANALYTICS_MAPPING} from '../connectors/wix-payments-analytics';
import {WIX_RECEIPTS_PROFILE} from './wix-transaction-counts';
import {postHogScopeProfile,postHogMasterclassProfile,postHogClientProfile,POSTHOG_DEFAULT_SCOPE} from '../connectors/posthog-analytics';
import {leadEntryProfile,wixLeadEntryConfig} from '../connectors/wix-lead-entries';
import {notionClientHistoryConfig} from '../connectors/notion-client-history';
import {notionCommerceConfig,notionCommerceProfile} from '../connectors/notion-commerce';
import {AppError} from './errors';
import {createSyncExecutionBudget} from './sync-budget';
export type SyncJob='notion'|'meta'|'wix'|'receipts'|'meta_ads'|'quiz'|'masterclass'|'forms'|'quiz_entries'|'client_history'|'commerce';
/** Unités de lecture planifiables. `resumable` : la lecture reprend son point enregistré en base et peut enchaîner plusieurs unités par tick tant qu'elle est partielle. */
const definitions:{id:SyncJob;source:string;stream:string;cadence:number;resumable?:boolean}[]=[
 {id:'notion',source:'notion',stream:'prospects_business',cadence:3600000,resumable:true},
 {id:'meta',source:'meta',stream:'meta_account_daily',cadence:3600000},
 {id:'wix',source:'wix',stream:'payments_analytics',cadence:3600000},
 {id:'receipts',source:'wix',stream:'receipt_observations',cadence:3600000},
 {id:'meta_ads',source:'meta',stream:'ad_daily',cadence:3600000},
 {id:'quiz',source:'posthog',stream:'quiz_observations',cadence:3600000},
 {id:'masterclass',source:'posthog',stream:'masterclass_observations',cadence:3600000},
 // Inscriptions Wix (masterclass, quiz), antériorité Client (Notion) et ventes payées : mêmes lecteurs que le bouton Actualiser, sans agent.
 {id:'forms',source:'wix',stream:'lead_entries_forms',cadence:3600000,resumable:true},
 {id:'quiz_entries',source:'wix',stream:'lead_entries_quiz',cadence:3600000,resumable:true},
 {id:'client_history',source:'notion',stream:'lead_entries_client_history',cadence:3600000,resumable:true},
 {id:'commerce',source:'notion',stream:'commerce_declared_snapshot',cadence:3600000,resumable:true},
];
const RESUMABLE=new Set<SyncJob>(definitions.filter(d=>d.resumable).map(d=>d.id));
const MAX_CHUNKS=4;
export function chooseSyncJob(runs:Row[],now:number,enabled:SyncJob[]):SyncJob|null {
 const due=definitions.filter(d=>enabled.includes(d.id)).flatMap(d=>{
  const streamRuns=runs.filter(r=>r.source===d.source&&r.stream_key===d.stream);
  if(streamRuns.some(r=>r.status==='running'&&Date.parse(String(r.lease_until??r.started_at))>now-(r.lease_until?0:120000)))return [];
  const latest=[...streamRuns].sort((a,b)=>Date.parse(String(b.lease_until??b.finished_at??b.started_at))-Date.parse(String(a.lease_until??a.finished_at??a.started_at)))[0];
  const touched=latest?Date.parse(String(latest.lease_until??latest.finished_at??latest.started_at)):0;
  const cadence=latest?.status==='running'&&RESUMABLE.has(d.id)?0:latest?.status==='failed'?300000:d.cadence;
  return !latest||now-touched>=cadence?[{id:d.id,touched}]:[];
 });
 return due.sort((a,b)=>a.touched-b.touched)[0]?.id??null;
}
const sourceTimeoutMs:Record<SyncJob,number>={notion:20_000,meta:25_000,wix:25_000,receipts:25_000,meta_ads:30_000,quiz:30_000,masterclass:30_000,forms:25_000,quiz_entries:25_000,client_history:25_000,commerce:25_000};
type Budget=Pick<ReturnType<typeof createSyncExecutionBudget>,'sourceFetch'|'canStart'|'dispose'>;
type TickResult={status:string};
type TickSummary={status:string;job:SyncJob|null;jobs:SyncJob[];units:number;unitResults:{job:SyncJob;status:string}[];reason?:string};
type TickOptions={now?:()=>number;budget?:Budget;execute?:(job:SyncJob,options:{db:Database;env:NodeJS.ProcessEnv;fetcher:typeof fetch})=>Promise<TickResult>};
/** Espace de noms et profil d'une unité, tels qu'enregistrés dans sync_runs ; null = unité non configurée (elle n'est pas planifiée, jamais un zéro). */
export function jobScope(job:SyncJob,env:NodeJS.ProcessEnv):{namespace:string;profile:string}|null {
 const client=postHogClientProfile(env);
 const wix=(()=>{try{return wixLeadEntryConfig(env.WIX_LEAD_ENTRY_CONFIG);}catch{return null;}})();
 const history=notionClientHistoryConfig(env);
 const commerce=(()=>{try{return notionCommerceConfig(env.NOTION_COMMERCE_CONFIG);}catch{return null;}})();
 const meta=env.META_AD_ACCOUNT_ID?.replace(/^act_/,'');
 const scope=(namespace:string|undefined|null,profile:string|null,ready=true)=>namespace&&profile&&ready?{namespace,profile}:null;
 switch(job){
  case 'notion':return scope(env.NOTION_DATA_SOURCE_ID,NOTION_BUSINESS_VERSION);
  case 'meta':return scope(meta,META_ACCOUNT_PROFILE);
  case 'meta_ads':return scope(meta,`${env.META_API_VERSION||'v23.0'}-ad-day-none`);
  case 'wix':return scope(env.WIX_SITE_ID,WIX_PAYMENTS_ANALYTICS_MAPPING.version);
  case 'receipts':return scope(env.WIX_SITE_ID,WIX_RECEIPTS_PROFILE);
  case 'quiz':return scope(env.POSTHOG_PROJECT_ID,postHogScopeProfile(POSTHOG_DEFAULT_SCOPE,client));
  case 'masterclass':return scope(env.POSTHOG_PROJECT_ID,postHogMasterclassProfile(client));
  case 'forms':return scope(env.WIX_SITE_ID,wix?leadEntryProfile('forms',wix):null,!!wix?.formIds.length&&!!env.WIX_API_KEY);
  case 'quiz_entries':return scope(env.WIX_SITE_ID,wix?leadEntryProfile('quiz',wix):null,!!wix?.quiz&&!!env.WIX_API_KEY);
  case 'client_history':return scope(history?.dataSourceId,history?leadEntryProfile('client_history',history):null,!!env.NOTION_TOKEN);
  case 'commerce':return scope(commerce?.parcours.dataSourceId,commerce?notionCommerceProfile(commerce):null,!!commerce?.schedule&&!!env.NOTION_TOKEN);
 }
}
async function executeSyncJob(job:SyncJob,from:string,to:string,options:{db:Database;env:NodeJS.ProcessEnv;fetcher:typeof fetch}):Promise<TickResult>{
 const {db,env}=options;
 switch(job){
  case 'notion':case 'meta':return synchronize(job,undefined,undefined,options) as Promise<TickResult>;
  case 'wix':return synchronizeWix(from,to,options) as Promise<TickResult>;
  case 'receipts':return synchronizeWixTransactionCounts(from,to,options) as Promise<TickResult>;
  case 'meta_ads':return synchronizeMetaAds(undefined,undefined,options) as Promise<TickResult>;
  case 'quiz':return (await postHogPeriod(from,to,options))??{status:'failed'};
  case 'masterclass':return (await postHogMasterclassPeriod(from,to,options))??{status:'failed'};
  case 'forms':return synchronizeLeadEntries('forms',{db,env,maxPages:3});
  case 'quiz_entries':return synchronizeLeadEntries('quiz',{db,env,maxPages:3});
  case 'client_history':return synchronizeLeadEntries('client_history',{db,env,maxPages:3});
  case 'commerce':return refreshNotionCommerce({db,config:notionCommerceConfig(env.NOTION_COMMERCE_CONFIG)!,token:env.NOTION_TOKEN??'',identitySecret:env.IDENTITY_HMAC_SECRET??'',fetcher:options.fetcher,maxPages:3});
 }
}
/** A tick runs small persisted units while its shared budget permits it. No scheduler is enabled here.
 * Database calls have no abort signal today, so their own client timeout remains
 * the limit; the 45 s budget cannot yet guarantee an end-to-end hard cutoff. */
export async function tickSyncJobs(db:Database=database(),env:NodeJS.ProcessEnv=process.env,options:TickOptions={}):Promise<TickSummary>{
 if(env.COCKPIT_MODE==='demo')throw new AppError('Données de démonstration.',409,'demo_mode');
 const scopes=new Map<SyncJob,{namespace:string;profile:string}>();
 for(const d of definitions){const scope=jobScope(d.id,env);if(scope)scopes.set(d.id,scope);}
 const enabled=definitions.filter(d=>scopes.has(d.id)).map(d=>d.id);
 const loadRuns=async()=>{const runs:Row[]=[];for(const d of definitions.filter(d=>enabled.includes(d.id))){const scope=scopes.get(d.id)!;runs.push(...await db.select('sync_runs',{eq:{source:d.source,source_namespace:scope.namespace,stream_key:d.stream,query_profile_key:scope.profile},order:'started_at',descending:true,limit:5}));}return runs;};
 const budget=options.budget??createSyncExecutionBudget(),now=options.now??Date.now,jobs:SyncJob[]=[],results:TickResult[]=[];const chunks=new Map<SyncJob,number>();let last:TickResult|undefined,budgetStopped=false;const excluded=new Set<SyncJob>();
 const today=Temporal.Now.plainDateISO('Europe/Paris'),to=today.add({days:1}).toString(),from=today.with({day:1}).subtract({months:1}).toString();
 try {
  for(;;){
   const runnable=enabled.filter(id=>!excluded.has(id)&&(chunks.get(id)??0)<(RESUMABLE.has(id)?MAX_CHUNKS:1)),runs=await loadRuns();
   const job=chooseSyncJob(runs,now(),runnable.filter(id=>budget.canStart(sourceTimeoutMs[id])));
   if(!job){if(chooseSyncJob(runs,now(),runnable))budgetStopped=true;break;}
   let result:TickResult;
   try {result=await (options.execute??((selected,ctx)=>executeSyncJob(selected,from,to,ctx)))(job,{db,env,fetcher:budget.sourceFetch});}
   catch {result={status:'failed'};excluded.add(job);}
   jobs.push(job);results.push(result);last=result;chunks.set(job,(chunks.get(job)??0)+1);
   if(!RESUMABLE.has(job)||result.status==='failed')excluded.add(job);
  }
  const unitResults=results.map((result,index)=>({job:jobs[index],status:result.status}));
  if(!last)return {status:budgetStopped?'partial':'complete',job:null,jobs,units:0,unitResults,reason:budgetStopped?'Le budget restant ne permet aucune unité due ; reprise au prochain tick.':'Toutes les lectures prévues sont à jour ou en cours.'};
  const finalStatuses=new Map(unitResults.map(unit=>[unit.job,unit.status]));
  const unfinished=[...finalStatuses.values()].some(status=>status!=='complete'&&status!=='empty');
  return {status:unfinished||budgetStopped?'partial':'complete',job:jobs.at(-1)!,jobs,units:results.length,unitResults,...(budgetStopped?{reason:'Le budget restant ne permet aucune autre unité due ; reprise au prochain tick.'}:{})};
 } finally {budget.dispose();}
}
