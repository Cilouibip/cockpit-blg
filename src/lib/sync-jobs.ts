import { synchronizeKpi } from './sync-kpi';
import { KPI_PROFILE } from './kpi-source-store';
import {Temporal} from '@js-temporal/polyfill';
import {database,type Database,type Row} from './db';
import {synchronize,synchronizeMetaAds} from './sync';
import {syncMetaCatalog} from './sync-catalog';
import {META_CATALOG_PROFILE} from '../connectors/meta-catalog';
import {synchronizeWix} from './sync-wix';
import {synchronizeWixTransactionCounts} from './wix-transaction-counts';
import {postHogPeriod,postHogMasterclassPeriod} from './posthog-dashboard';
import {synchronizeLeadEntries} from './sync-lead-entries';
import {refreshNotionCommerce,type CommerceRefreshResult} from './sync-notion-commerce';
import {commerceReaderMode,type CommerceReaderMode} from './config';
import {NOTION_BUSINESS_VERSION} from '../connectors/notion-business';
import {META_ACCOUNT_PROFILE} from '../connectors/meta-account-analytics';
import {WIX_PAYMENTS_ANALYTICS_MAPPING} from '../connectors/wix-payments-analytics';
import {WIX_RECEIPTS_PROFILE} from './wix-transaction-counts';
import {postHogScopeProfile,postHogMasterclassProfile,postHogClientProfile,POSTHOG_DEFAULT_SCOPE} from '../connectors/posthog-analytics';
import {leadEntryProfile,wixLeadEntryConfig} from '../connectors/wix-lead-entries';
import {notionClientHistoryConfig} from '../connectors/notion-client-history';
import {notionCommerceConfig,notionCommerceProfile} from '../connectors/notion-commerce';
import {invalidateSourceSnapshots} from './source-snapshots';
import {ConnectorError} from '../connectors/http';
import {AppError} from './errors';
import {createSyncExecutionBudget} from './sync-budget';
import {randomUUID} from 'node:crypto';
export type SyncJob='notion'|'meta'|'wix'|'receipts'|'meta_ads'|'meta_catalog'|'quiz'|'masterclass'|'forms'|'quiz_entries'|'client_history'|'commerce'|'kpi_meta'|'kpi_posthog'|'kpi_email';
/** Unités de lecture planifiables. `resumable` : la lecture reprend son point enregistré en base et peut enchaîner plusieurs unités par tick tant qu'elle est partielle.
 * `cadence` : cadence de base (une heure). `pilot` : flux qui conditionne le pilotage Masterclass et dont chaque passage reste borné
 * (fenêtre datée ou delta) ; sa cadence suit BLG_REFRESH_CADENCE_MINUTES (60 minutes par défaut, 30 sur activation explicite). */
const definitions:{id:SyncJob;source:string;stream:string;workStream?:string;cadence:number;resumable?:boolean;pilot?:true}[]=[
 // Chaque nouveau passage Notion relit l'inventaire complet de la base (et tout le miroir une fois par 24 h) : il reste à une heure.
 {id:'notion',source:'notion',stream:'prospects_business',cadence:3600000,resumable:true},
 {id:'meta',source:'meta',stream:'meta_account_daily',cadence:3600000},
 {id:'wix',source:'wix',stream:'payments_analytics',cadence:3600000},
 {id:'receipts',source:'wix',stream:'receipt_observations',cadence:3600000},
 {id:'meta_ads',source:'meta',stream:'ad_daily',cadence:3600000,pilot:true},
 // Le catalogue relit toutes les publicités du compte à chaque passage : il reste à une heure.
 {id:'meta_catalog',source:'meta',stream:'ad_catalog',cadence:3600000},
 {id:'quiz',source:'posthog',stream:'quiz_observations',cadence:3600000,resumable:true},
 {id:'masterclass',source:'posthog',stream:'masterclass_observations',cadence:3600000,resumable:true,pilot:true},
 // Inscriptions Wix (masterclass, quiz), antériorité Client (Notion) et ventes payées : mêmes lecteurs que le bouton Actualiser, sans agent.
 {id:'forms',source:'wix',stream:'lead_entries_forms',cadence:3600000,resumable:true,pilot:true},
 {id:'quiz_entries',source:'wix',stream:'lead_entries_quiz',cadence:3600000,resumable:true},
 {id:'client_history',source:'notion',stream:'lead_entries_client_history',cadence:3600000,resumable:true},
 {id:'kpi_meta',source:'meta',stream:'kpi_meta_daily',cadence:3600000,pilot:true},
 {id:'kpi_posthog',source:'posthog',stream:'kpi_posthog_daily',cadence:3600000,pilot:true},
 {id:'kpi_email',source:'wix',stream:'kpi_wix_daily',cadence:3600000,pilot:true},
 {id:'commerce',source:'notion',stream:'commerce_declared_snapshot',workStream:'commerce_reader_checkpoint',cadence:3600000,resumable:true},
];
const RESUMABLE=new Set<SyncJob>(definitions.filter(d=>d.resumable).map(d=>d.id));
const MAX_CHUNKS=4;
const HOUR_MS=3_600_000;
/** Flux du pilotage Masterclass soumis au réglage de cadence ; tous les autres restent à une heure. */
export const PILOT_REFRESH_JOBS:readonly SyncJob[]=definitions.filter(d=>d.pilot).map(d=>d.id);
/** Réglage serveur unique BLG_REFRESH_CADENCE_MINUTES. Défaut de transition : absent, vide, `60` ou toute valeur
 * autre que `30` = 60 minutes (cadence horaire antérieure, à l'identique). `30` (espaces ignorés) est une activation
 * explicite, à poser seulement après les conditions de docs/ACTUALISATION.md §2. Aucune valeur ne descend sous 30 minutes. */
export function refreshCadenceMinutes(env:Record<string,string|undefined>=process.env):30|60 {return env.BLG_REFRESH_CADENCE_MINUTES?.trim()==='30'?30:60;}
export type RefreshCadences=Record<SyncJob,number>;
/** Cadence en millisecondes de chaque flux, d'après le seul réglage serveur. */
export function refreshCadences(env:Record<string,string|undefined>=process.env):RefreshCadences {
 const pilot=refreshCadenceMinutes(env)*60_000;
 return Object.fromEntries(definitions.map(d=>[d.id,d.pilot?pilot:d.cadence])) as RefreshCadences;
}
export type StreamState={job:SyncJob;state:'due'|'waiting'|'failed'|'complete';retryAt?:string;errorCode?:string;lastSuccessAt:string|null;dataAsOf:string|null;stale:boolean};
const touchedAt=(r:Row)=>Date.parse(String(r.lease_until??r.finished_at??r.started_at))||0;
const safeCode=(value:unknown)=>typeof value==='string'&&/^[A-Za-z_][A-Za-z0-9_ ()-]{0,99}$/.test(value)?value:'SYNC_UNIT_FAILED';
/** Inspect persisted work, including leases and failed cooldowns. No work selected
 * is not equivalent to a successful publication. */
export function syncStreamStates(runs:Row[],now:number,enabled:SyncJob[],cadences:RefreshCadences=refreshCadences()):StreamState[]{
 return definitions.filter(d=>enabled.includes(d.id)).map(d=>{
  const cadence=cadences[d.id]??d.cadence;
  const rows=runs.filter(r=>r.source===d.source&&r.stream_key===d.stream).sort((a,b)=>touchedAt(b)-touchedAt(a));
  // A saved Commerce page lives in another stream. It is work evidence only:
  // never a published snapshot, last success, or data-freshness observation.
  const work=d.workStream?runs.filter(r=>r.source===d.source&&r.stream_key===d.workStream):[];
  const attempts=[...rows,...work].sort((a,b)=>touchedAt(b)-touchedAt(a));
  const latestAttempt=attempts[0];
  const latest=rows[0],success=rows.find(r=>['complete','empty'].includes(String(r.status))&&r.pagination_complete!==false);
  const lastSuccessAt=success?String(success.finished_at??success.started_at):null;
  // Publication time and source coverage are different for a long Notion scan.
  const bounds=success?[success.started_at,success.finished_at,d.id==='notion'?success.period_to:success.source_as_of].map(value=>Date.parse(String(value))).filter(value=>Number.isFinite(value)&&value<=now):[];
  const dataAsOf=bounds.length?new Date(Math.min(...bounds)).toISOString():null;
  const base={job:d.id,lastSuccessAt,dataAsOf,stale:!dataAsOf||now-Date.parse(dataAsOf)>=cadence};
  const active=attempts.find(r=>r.status==='running'&&(r.lease_until?Date.parse(String(r.lease_until)):Date.parse(String(r.started_at))+600000)>now);
  if(active)return {...base,state:'waiting' as const,retryAt:new Date(active.lease_until?Date.parse(String(active.lease_until)):Date.parse(String(active.started_at))+600000).toISOString()};
  if(latestAttempt?.status==='failed'||latestAttempt?.error_code){
   const retry=touchedAt(latestAttempt)+300000;
   return {...base,state:(now>=retry?'due':'failed') as 'due'|'failed',retryAt:new Date(retry).toISOString(),errorCode:safeCode(latestAttempt.error_code)};
  }
  if(!latest)return {...base,state:'due' as const};
  if(latest.status==='running')return {...base,state:'due' as const};
  // Due from the attempt start: finishing a long import must not defer the next run. Entering the next
  // UTC slot of the cadence (hour, or half hour) is also due, so a few seconds of trigger jitter never skip a slot.
  const started=Date.parse(String(latest.started_at));
  return {...base,state:(base.stale||now-started>=cadence||(HOUR_MS%cadence===0&&Math.floor(now/cadence)>Math.floor(started/cadence))?'due':'complete') as 'due'|'complete'};
 });
}
export function chooseSyncJob(runs:Row[],now:number,enabled:SyncJob[],cadences:RefreshCadences=refreshCadences()):SyncJob|null {
 const due=new Set(syncStreamStates(runs,now,enabled,cadences).filter(s=>s.state==='due').map(s=>s.job));
 return definitions.filter(d=>due.has(d.id)).map(d=>({id:d.id,touched:Math.max(0,...runs.filter(r=>r.source===d.source&&(r.stream_key===d.stream||(d.workStream&&r.stream_key===d.workStream))).map(touchedAt))})).sort((a,b)=>a.touched-b.touched)[0]?.id??null;
}
const sourceTimeoutMs:Record<SyncJob,number>={notion:20_000,meta:25_000,wix:25_000,receipts:25_000,meta_ads:30_000,meta_catalog:30_000,quiz:30_000,masterclass:30_000,forms:25_000,quiz_entries:25_000,client_history:25_000,commerce:25_000,kpi_meta:30_000,kpi_posthog:30_000,kpi_email:30_000};
type Budget=Pick<ReturnType<typeof createSyncExecutionBudget>,'sourceFetch'|'canStart'|'dispose'>&Partial<Pick<ReturnType<typeof createSyncExecutionBudget>,'remainingWorkMs'|'remainingTotalMs'>>;
type TickResult={status:string;safeError?:string};
export type TickSummary={status:string;job:SyncJob|null;jobs:SyncJob[];units:number;unitResults:{job:SyncJob;status:string}[];reason?:string;lock?:TickLockReport;cadence?:{pilotMinutes:30|60;pilotJobs:SyncJob[];otherMinutes:60};streams?:StreamState[];schedulerMeasurements?:{dbReads:number;dbMs:number;elapsedMs:number;rowsRead:number};measurements?:{job:SyncJob;elapsedMs:number;sourceRequests:number;sourceMs:number;dbReads:number;dbWrites:number;dbMs:number;rowsSubmitted:number}[]};
/** Verrou d'un passage. Le verrou par défaut vit dans la mémoire du processus : il empêche deux passages simultanés
 * sur la même instance, pas entre deux instances. Entre instances, le bail partagé en base (migration 017) s'ajoute
 * aux verrous par flux (begin_sync_stream, cockpit_claim_*), qui restent inchangés. */
export type TickLock={acquire():(()=>void)|null};
/** Durée du bail partagé : au-dessus des 60 s de la route, avec marge ; jamais renouvelé pendant un passage. */
export const TICK_LEASE_SECONDS=90;
/** Protection réellement appliquée au passage, exposée dans la réponse du tick (`lock`). */
export type TickLockReport={kind:'shared';leaseSeconds:number}|{kind:'process-only';reason:string};
type LeaseClaim={state:'acquired';release:()=>Promise<unknown>}|{state:'refused'}|{state:'missing';reason:string};
/** Bail partagé de niveau passage. */
export type SharedTickLease={claim():Promise<LeaseClaim>};
/** Bail en base : cockpit_claim_tick(détenteur aléatoire, 90 s) puis cockpit_release_tick du même détenteur.
 * Seule l'absence des fonctions est tolérée : db.ts ne traduit en `schema_missing` que les codes « fonction ou table
 * inconnue » (42883, PGRST202, 42P01, PGRST205) ; pour cet appel, c'est la migration 017 non appliquée. Toute autre
 * erreur remonte telle quelle (aucune lecture n'a eu lieu). */
export function databaseTickLease(db:Database,holder:()=>string=randomUUID):SharedTickLease {
 return {async claim(){
  const id=holder();let acquired:unknown;
  try{acquired=await db.rpc<boolean>('cockpit_claim_tick',{p_holder:id,p_seconds:TICK_LEASE_SECONDS});}
  catch(error){
   if(error instanceof AppError&&error.code==='schema_missing')return {state:'missing',reason:'Verrou partagé absent de la base (migration 017 non appliquée) : seul le verrou de cette instance protège ce passage ; les verrous par flux en base restent actifs.'};
   throw error;
  }
  return acquired===true?{state:'acquired',release:()=>db.rpc('cockpit_release_tick',{p_holder:id})}:{state:'refused'};
 }};
}
/** Un détenteur bloqué au-delà de `staleMs` (au-dessus de la durée maximale de la route, 60 s) n'empêche plus les passages suivants. */
export function createProcessTickLock(staleMs=120_000,clock:()=>number=Date.now):TickLock {
 let held:{token:symbol;since:number}|null=null;
 return {acquire(){
  const at=clock();
  if(held&&at-held.since<staleMs)return null;
  const token=Symbol('tick');held={token,since:at};
  return ()=>{if(held?.token===token)held=null;};
 }};
}
const processTickLock=createProcessTickLock();
type TickOptions={lock?:TickLock;sharedLease?:SharedTickLease|null;now?:()=>number;budget?:Budget;execute?:(job:SyncJob,options:{db:Database;env:NodeJS.ProcessEnv;fetcher:typeof fetch;budget?:import('./sync-posthog-reports').PostHogSyncBudget})=>Promise<TickResult>};
/** Espace de noms et profil d'une unité planifiable ; null = unité non configurée ou suspendue (elle n'est pas planifiée, jamais un zéro).
 * Le lecteur financier Notion reste hors planning tant que BLG_COMMERCE_READER n'est pas `active`. */
export function jobScope(job:SyncJob,env:NodeJS.ProcessEnv):{namespace:string;profile:string}|null {
 if(job==='commerce'&&commerceReaderMode(env)==='paused')return null;
 return configuredJobScope(job,env);
}
/** Espace de noms et profil tels qu'enregistrés dans sync_runs, d'après la seule configuration.
 * Sert à relire les publications existantes, y compris celles d'une lecture suspendue. */
export function configuredJobScope(job:SyncJob,env:NodeJS.ProcessEnv):{namespace:string;profile:string}|null {
 const client=postHogClientProfile(env);
 const wix=(()=>{try{return wixLeadEntryConfig(env.WIX_LEAD_ENTRY_CONFIG);}catch{return null;}})();
 const history=notionClientHistoryConfig(env);
 const commerce=(()=>{try{return notionCommerceConfig(env.NOTION_COMMERCE_CONFIG);}catch{return null;}})();
 const meta=env.META_AD_ACCOUNT_ID?.replace(/^act_/,'');
 const scope=(namespace:string|undefined|null,profile:string|null,ready=true)=>namespace&&profile&&ready?{namespace,profile}:null;
 switch(job){
  case 'kpi_meta':return scope(meta,KPI_PROFILE,!!env.META_ACCESS_TOKEN);
  case 'kpi_posthog':return scope(env.POSTHOG_PROJECT_ID,KPI_PROFILE,!!env.POSTHOG_PERSONAL_API_KEY);
  case 'kpi_email':return scope(env.WIX_SITE_ID,KPI_PROFILE,!!env.WIX_API_KEY&&!!env.IDENTITY_HMAC_SECRET);
  case 'notion':return scope(env.NOTION_DATA_SOURCE_ID,NOTION_BUSINESS_VERSION);
  case 'meta':return scope(meta,META_ACCOUNT_PROFILE);
  case 'meta_ads':return scope(meta,`${env.META_API_VERSION||'v23.0'}-ad-day-none`);
  case 'meta_catalog':return scope(meta,META_CATALOG_PROFILE,!!env.META_ACCESS_TOKEN);
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
async function executeSyncJob(job:SyncJob,from:string,to:string,options:{db:Database;env:NodeJS.ProcessEnv;fetcher:typeof fetch;budget?:import('./sync-posthog-reports').PostHogSyncBudget}):Promise<TickResult>{
 const {db,env}=options;
 switch(job){
  case 'kpi_meta':return synchronizeKpi('meta',options);
  case 'kpi_posthog':return synchronizeKpi('posthog',options);
  case 'kpi_email':return synchronizeKpi('wix',options);
  case 'notion':case 'meta':return synchronize(job,undefined,undefined,options) as Promise<TickResult>;
  case 'wix':return synchronizeWix(from,to,options) as Promise<TickResult>;
  case 'receipts':return synchronizeWixTransactionCounts(from,to,options) as Promise<TickResult>;
  case 'meta_ads':return synchronizeMetaAds(undefined,undefined,options) as Promise<TickResult>;
  case 'meta_catalog':return syncMetaCatalog(options) as Promise<TickResult>;
  case 'quiz':return (await postHogPeriod(from,to,{...options,resumeRunningPeriod:true}))??{status:'failed'};
  case 'masterclass':return (await postHogMasterclassPeriod(from,to,{...options,resumeRunningPeriod:true}))??{status:'failed'};
  case 'forms':return synchronizeLeadEntries('forms',{db,env,fetcher:options.fetcher,maxPages:3});
  case 'quiz_entries':return synchronizeLeadEntries('quiz',{db,env,fetcher:options.fetcher,maxPages:3});
  case 'client_history':return synchronizeLeadEntries('client_history',{db,env,fetcher:options.fetcher,maxPages:3});
  case 'commerce':return commerceUnit(options);
 }
}
/** Une unité bornée du lecteur financier Notion, identique dans le tick et le passage de contrôle. */
function commerceUnit(options:{db:Database;env:NodeJS.ProcessEnv;fetcher:typeof fetch}):Promise<CommerceRefreshResult>{
 const {db,env}=options;
 return refreshNotionCommerce({db,config:notionCommerceConfig(env.NOTION_COMMERCE_CONFIG)!,token:env.NOTION_TOKEN??'',identitySecret:env.IDENTITY_HMAC_SECRET??'',fetcher:options.fetcher,maxPages:3});
}
export type CommerceControlResult={job:'commerce';readerMode:CommerceReaderMode;status:string;safeError?:string;counts?:CommerceRefreshResult['counts'];coverage?:CommerceRefreshResult['coverage'];reason?:string};
/** Passage de contrôle réservé (GET /api/jobs/commerce avec le bearer CRON_SECRET) : exactement une unité
 * bornée du lecteur financier, y compris quand il est suspendu. Aucune autre voie ne contourne la pause. */
export async function commerceControlPass(db:Database=database(),env:NodeJS.ProcessEnv=process.env,options:{budget?:Budget}={}):Promise<CommerceControlResult>{
 if(env.COCKPIT_MODE==='demo')throw new AppError('Données de démonstration.',409,'demo_mode');
 if(!configuredJobScope('commerce',env))throw new AppError('Le rapprochement des ventes n’est pas configuré.',503,'commerce_missing');
 const budget=options.budget??createSyncExecutionBudget(),readerMode=commerceReaderMode(env);
 try{
  let result:CommerceControlResult;
  try{const unit=await commerceUnit({db,env,fetcher:budget.sourceFetch});result={job:'commerce',readerMode,status:unit.status,counts:unit.counts,coverage:unit.coverage,...(unit.reason?{reason:unit.reason}:{})};}
  catch(error){result={job:'commerce',readerMode,status:'failed',safeError:safeCode(error instanceof AppError||error instanceof ConnectorError?error.code:undefined)};}
  invalidateSourceSnapshots(db);
  return result;
 }finally{budget.dispose();}
}
/** A tick runs small persisted units while its shared budget permits it. No scheduler is enabled here.
 * Database calls have no abort signal today, so their own client timeout remains
 * the limit; the 45 s budget cannot yet guarantee an end-to-end hard cutoff.
 * Ordre des verrous : verrou de processus (aucun appel en base si cette instance travaille déjà), puis bail partagé en base.
 * Le bail en base est pris par défaut pour la base de production (appel sans base, seul appel réel : la route du tick) ;
 * une base injectée (tests, scripts) le reçoit explicitement par `sharedLease`, sinon la réponse l'indique (`process-only`). */
export async function tickSyncJobs(db?:Database,env:NodeJS.ProcessEnv=process.env,options:TickOptions={}):Promise<TickSummary>{
 if(env.COCKPIT_MODE==='demo')throw new AppError('Données de démonstration.',409,'demo_mode');
 const cadences=refreshCadences(env),cadence={pilotMinutes:refreshCadenceMinutes(env),pilotJobs:[...PILOT_REFRESH_JOBS],otherMinutes:60 as const};
 const release=(options.lock??processTickLock).acquire();
 // Aucun budget créé, aucune lecture : le passage déjà en cours sur cette instance garde la main.
 if(!release)return {status:'waiting',job:null,jobs:[],units:0,unitResults:[],cadence,reason:'Un autre passage est déjà en cours sur cette instance ; aucune unité lancée.'};
 try{
  const store=db??database();
  // Aucune source configurée : rien à lire ni à protéger, aucun appel en base (réponse « failed » inchangée).
  if(!definitions.some(d=>jobScope(d.id,env)))return await tickWithLock(store,env,options,cadences,cadence);
  const lease=options.sharedLease!==undefined?options.sharedLease:db===undefined?databaseTickLease(store):null;
  if(!lease)return {...await tickWithLock(store,env,options,cadences,cadence),lock:{kind:'process-only',reason:'Aucun bail partagé fourni à ce passage (base injectée) : seul le verrou de cette instance s’applique.'}};
  const claim=await lease.claim();
  // Bail détenu par un autre passage (autre instance) : ni lecture du journal, ni source, ni écriture.
  if(claim.state==='refused')return {status:'waiting',job:null,jobs:[],units:0,unitResults:[],cadence,streams:[],reason:'Un autre passage détient le verrou partagé en base (autre instance) ; aucune unité lancée, aucune lecture.'};
  if(claim.state==='missing')return {...await tickWithLock(store,env,options,cadences,cadence),lock:{kind:'process-only',reason:claim.reason}};
  // Libéré dans tous les cas ; une libération perdue expire seule au bout de 90 s.
  try{return {...await tickWithLock(store,env,options,cadences,cadence),lock:{kind:'shared',leaseSeconds:TICK_LEASE_SECONDS}};}
  finally{await claim.release().catch(()=>undefined);}
 }finally{release();}
}
async function tickWithLock(db:Database,env:NodeJS.ProcessEnv,options:TickOptions,cadences:RefreshCadences,cadence:NonNullable<TickSummary['cadence']>):Promise<TickSummary>{
 const scopes=new Map<SyncJob,{namespace:string;profile:string}>();
 for(const d of definitions){const scope=jobScope(d.id,env);if(scope)scopes.set(d.id,scope);}
 const enabled=definitions.filter(d=>scopes.has(d.id)).map(d=>d.id);
 const schedulerMeasurements={dbReads:0,dbMs:0,elapsedMs:0,rowsRead:0};
 const loadRuns=async()=>{
  const started=performance.now();
  const groups=await Promise.all(definitions.filter(d=>enabled.includes(d.id)).map(async d=>{
   const scope=scopes.get(d.id)!,eq={source:d.source,source_namespace:scope.namespace,stream_key:d.stream,query_profile_key:scope.profile};
   const select=async(options:Parameters<Database['select']>[1])=>{const at=performance.now();schedulerMeasurements.dbReads++;try{const rows=await db.select('sync_runs',options);schedulerMeasurements.rowsRead+=rows.length;return rows;}finally{schedulerMeasurements.dbMs+=performance.now()-at;}};
   // A healthy publication remains findable after any number of failed attempts.
   const [recent,published,work]=await Promise.all([
    select({eq,order:'started_at',descending:true,limit:5}),
    select({eq:{...eq,pagination_complete:'true'},in:{status:['complete','empty']},order:'finished_at',descending:true,limit:1}),
    d.workStream?select({eq:{...eq,stream_key:d.workStream},columns:['id','source','stream_key','query_profile_key','started_at','finished_at','status','lease_until','error_code'],order:'started_at',descending:true,limit:1}):Promise.resolve([]),
   ]);
   return [...recent,...published.filter(r=>['complete','empty'].includes(String(r.status))&&!recent.some(item=>item===r||(r.id&&item.id===r.id))),...work];
  }));
  schedulerMeasurements.elapsedMs+=performance.now()-started;return groups.flat();
 };
 const measurements:NonNullable<TickSummary['measurements']>=[];
 const budget=options.budget??createSyncExecutionBudget(),now=options.now??Date.now,jobs:SyncJob[]=[],results:TickResult[]=[];const chunks=new Map<SyncJob,number>();let budgetStopped=false;const excluded=new Set<SyncJob>();
 let finalRuns:Row[]=[];
 const today=Temporal.Now.plainDateISO('Europe/Paris'),to=today.add({days:1}).toString(),from=today.with({day:1}).subtract({months:1}).toString();
 try {
  for(;;){
   const runnable=enabled.filter(id=>!excluded.has(id)&&(chunks.get(id)??0)<(RESUMABLE.has(id)?MAX_CHUNKS:1)),runs=await loadRuns();
   finalRuns=runs;
   const job=chooseSyncJob(runs,now(),runnable.filter(id=>budget.canStart(sourceTimeoutMs[id])),cadences);
   if(!job){if(chooseSyncJob(runs,now(),runnable,cadences))budgetStopped=true;break;}
   let result:TickResult;
   const measure={job,elapsedMs:0,sourceRequests:0,sourceMs:0,dbReads:0,dbWrites:0,dbMs:0,rowsSubmitted:0},started=performance.now();
   const timed=async<T>(fn:()=>Promise<T>)=>{const at=performance.now();try{return await fn();}finally{measure.dbMs+=performance.now()-at;}};
   const measuredDb:Database={...db,select:(...args)=>{measure.dbReads++;return timed(()=>db.select(...args));},upsert:(...args)=>{measure.dbWrites++;measure.rowsSubmitted+=args[1].length;return timed(()=>db.upsert(...args));},rpc:<T>(name:string,args:Row,options?:Parameters<Database['rpc']>[2])=>{measure.dbWrites++;if(Array.isArray(args.p_records))measure.rowsSubmitted+=args.p_records.length;return timed(()=>db.rpc<T>(name,args,options));}};
   const fetcher:typeof fetch=async(...args)=>{const at=performance.now();measure.sourceRequests++;try{return await budget.sourceFetch(...args);}finally{measure.sourceMs+=performance.now()-at;}};
   try {result=await (options.execute??((selected,ctx)=>executeSyncJob(selected,from,to,ctx)))(job,{db:measuredDb,env,fetcher,...(budget.remainingWorkMs&&budget.remainingTotalMs?{budget:{remainingWorkMs:budget.remainingWorkMs,remainingTotalMs:budget.remainingTotalMs}}:{})});}
   // Flux déjà réclamé ailleurs (begin_sync_stream : 55P03 traduit en 409 source_busy) : rien n'a été écrit, le détenteur termine.
   catch(error) {result=error instanceof AppError&&error.status===409&&error.code==='source_busy'?{status:'waiting'}:{status:'failed',safeError:safeCode(error instanceof AppError||error instanceof ConnectorError?error.code:undefined)};excluded.add(job);}
   invalidateSourceSnapshots(db);
   measure.elapsedMs=Math.round(performance.now()-started);measure.dbMs=Math.round(measure.dbMs);measure.sourceMs=Math.round(measure.sourceMs);measurements.push(measure);
   jobs.push(job);results.push(result);chunks.set(job,(chunks.get(job)??0)+1);
   if(!RESUMABLE.has(job)||result.status==='failed')excluded.add(job);
  }
  const unitResults=results.map((result,index)=>({job:jobs[index],status:result.status}));
  const streams=syncStreamStates(finalRuns,now(),enabled,cadences);
  const finalStatuses=new Map(unitResults.map(unit=>[unit.job,unit.status]));
  for(const state of streams){
   const result=finalStatuses.get(state.job);
   if(result==='failed'){state.state='failed';state.errorCode=results.filter((_,index)=>jobs[index]===state.job).at(-1)?.safeError??state.errorCode??'SYNC_UNIT_FAILED';}
   else if((result==='partial'||result==='pending')&&state.state!=='waiting')state.state='due';
   else if(result==='waiting'&&state.state!=='complete')state.state='waiting';
  }
  const due=streams.some(s=>s.state==='due'),waiting=streams.some(s=>s.state==='waiting'),failed=streams.some(s=>s.state==='failed');
  const status=due||budgetStopped?'partial':waiting?'waiting':failed?'failed':enabled.length?'complete':'failed';
  return {status,job:jobs.at(-1)??null,jobs,units:results.length,unitResults,cadence,streams,measurements,schedulerMeasurements:Object.fromEntries(Object.entries(schedulerMeasurements).map(([k,v])=>[k,Math.round(v)])) as typeof schedulerMeasurements,
   reason:status==='complete'?'Toutes les sources configurées ont une publication complète récente.':status==='waiting'?'Une lecture possède encore le verrou ; aucune fin globale annoncée.':status==='failed'?'Une source reste en échec ou aucune source n’est configurée ; le dernier rapport valide est conservé.':'Des lectures restent à terminer ; reprise au point enregistré.'};
 } finally {budget.dispose();}
}
