import {preparePostHogAnalytics,readPostHogAnalytics,readPostHogMasterclassAnalytics,postHogScopeProfile,postHogMasterclassProfile,postHogClientProfile,POSTHOG_DEFAULT_SCOPE,type PostHogAnalyticsConfig,type PostHogAnalyticsReport,type PostHogMasterclassReport,type PostHogAggregateQueryName,type PostHogReportExecution,type PostHogClientProfile,type PostHogDimensionScope} from '../connectors/posthog-analytics';
import {isDeepStrictEqual} from 'node:util';
import {ConnectorError,safeConnectorError} from '../connectors/http';
import type {PostHogQueryContinuation} from '../connectors/posthog-query';
import {database,type Database,type Row} from './db';
import {AppError} from './errors';
import {startOfParisDay} from '../domain/dates';
import {invalidateSourceSnapshots} from './source-snapshots';

type Report=PostHogAnalyticsReport|PostHogMasterclassReport;
type Kind='quiz'|'masterclass';
export type PostHogSyncBudget={remainingWorkMs:()=>number;remainingTotalMs:()=>number};
export type PostHogImportOptions={db?:Database;scope?:PostHogDimensionScope;client?:PostHogClientProfile;fetcher?:typeof fetch;env?:Record<string,string|undefined>;budget?:PostHogSyncBudget;resumeRunningPeriod?:boolean;prepare?:typeof preparePostHogAnalytics;reader?:((config:PostHogAnalyticsConfig)=>Promise<Report>)};
type SavedQuery={continuation:PostHogQueryContinuation;complete:boolean};
type Claim={busy:boolean;runId:string;lease?:string;observedAt?:string;expiresAt?:string;checkpoint?:{queries:Partial<Record<PostHogAggregateQueryName,SavedQuery>>};retryAt?:string;reason?:string};
const failureCodes=new Set(['NETWORK_ERROR','ACCESS_DENIED','ACCESS_DENIED_HTTP_401','ACCESS_DENIED_HTTP_403','UPSTREAM_HTTP_ERROR','POSTHOG_QUERY_MISSING','INVALID_POSTHOG_CONTINUATION','INVALID_POSTHOG_QUERY_ID','INVALID_POSTHOG_RESPONSE','POSTHOG_REQUEST_TIMEOUT','POSTHOG_CANCELLED','POSTHOG_DNS_ERROR','POSTHOG_CONNECTION_RESET','POSTHOG_TRANSPORT_ERROR','POSTHOG_RESULT_LIMIT','POSTHOG_SCHEMA_PAGE_LIMIT','RESPONSE_TOO_LARGE','POSTHOG_TOTALS_CHANGED','POSTHOG_DISTINCT_COUNTS_MISMATCH','POSTHOG_QUERY_FAILED','POSTHOG_TIME_BUDGET','POSTHOG_QUERY_EXPIRED']);
function failureCode(code:string|undefined){const normalized=code?.replace(/[()]/g,'').replace(/ +/g,'_');return normalized&&failureCodes.has(normalized)?normalized:'POSTHOG_IMPORT_FAILED';}
function unavailable(kind:Kind,config:PostHogAnalyticsConfig,status:'pending'|'failed',code?:string):Report {
 const common={source:'posthog' as const,from:config.from,to:config.to,observedAt:null,status,safeError:code,byEvent:[],coverage:{queryComplete:false,reason:status==='pending'?'Lecture en cours ; dernier rapport complet conservé.':'Lecture incomplète ; dernier rapport complet conservé.'}};
 if(kind==='masterclass')return {...common,profile:postHogMasterclassProfile(config.client),coverage:{...common.coverage,hostVerified:false}};
 return {...common,connectorVersion:postHogScopeProfile(config.scope,config.client),projectId:config.projectId!,timezone:'Europe/Paris',overview:null,daily:[],byHostEvent:[],questions:[],schema:{sessionIdAvailable:false,questionNumberProperty:null},scope:config.scope,client:config.client,coverage:{...common.coverage,allTrafficComplete:false,firstObservedAt:null,lastObservedAt:null,observedTrackedEvents:null,excludedHostEvents:null,missingHostEvents:null,conflictingHostEvents:null,identifiableTestEvents:null},semantics:{visitorIdentity:'distinct_id',sessionIdentity:'$session_id',verifiedBackendLeads:false,sequentialFunnel:false}};
}

/** Persist only query metadata between invocations. Results must be retrieved,
 * validated and reconciled together before the single atomic publication RPC. */
export async function synchronizePostHogReport(kind:Kind,from:string,to:string,options:PostHogImportOptions={}):Promise<Report|null>{
 const env=options.env??process.env,namespace=env.POSTHOG_PROJECT_ID;
 if(!namespace||!env.POSTHOG_HOST||!env.POSTHOG_PERSONAL_API_KEY)return null;
 const db=options.db??database(),scope=options.scope??POSTHOG_DEFAULT_SCOPE,client=options.client??postHogClientProfile(env);let start=startOfParisDay(from),end=startOfParisDay(to);
 const profile=kind==='quiz'?postHogScopeProfile(scope,client):postHogMasterclassProfile(client),stream=kind==='quiz'?'quiz_observations':'masterclass_observations';
 const started=performance.now(),remainingWork=()=>Math.min(40_000-(performance.now()-started),options.budget?.remainingWorkMs()??40_000),remainingTotal=()=>Math.min(45_000-(performance.now()-started),options.budget?.remainingTotalMs()??45_000);
 // A short read leaves room for claim/checkpoints/publication. The enclosing
 // tick retains its original 40/45-second limits; no timeout is increased.
 const sourceMs=Math.max(1,Math.min(20_000,remainingWork()-5_000)),deadline=Date.now()+sourceMs,controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),sourceMs);
 const config:PostHogAnalyticsConfig={host:env.POSTHOG_HOST,projectId:namespace,personalApiKey:env.POSTHOG_PERSONAL_API_KEY,from:start,to:end,scope,client,fetcher:options.fetcher,deadline,signal:controller.signal};
 let claim:Claim|undefined,persistenceFailed=false;
 const rpc=async<T>(name:string,args:Row):Promise<T>=>{
  const limit=Math.min(5_000,remainingTotal());
  if(limit<1)throw new AppError('La sauvegarde reprendra au prochain passage.',503,'database_unavailable');
  try{return await db.rpc<T>(name,args,{timeoutMs:Math.max(1,Math.floor(limit))});}catch(error){persistenceFailed=true;throw error;}
 };
 const claimRun=async(expectedQueries:string[])=>rpc<Claim>('cockpit_claim_posthog',{p_namespace:namespace,p_stream:stream,p_profile:profile,p_from:start,p_to:end,p_context:{origin:new URL(env.POSTHOG_HOST!).origin,scope,client,expectedQueries}});
 try{
  if(remainingWork()<6_000)return unavailable(kind,config,'pending');
  // Skip metadata requests during a lease or failure cooldown, including an
  // explicit refresh from another process. The later claim closes this race.
  const recent=await db.select('sync_runs',{eq:{source:'posthog',source_namespace:namespace,stream_key:stream,query_profile_key:profile},order:'started_at',descending:true,limit:1,columns:['status','started_at','finished_at','lease_until','period_from','period_to','checkpoint','error_code'],timeoutMs:Math.max(1,Math.floor(Math.min(5_000,remainingTotal())))});
  const previous=recent[0],stamp=Date.now();
  if(previous?.status==='failed'&&Date.parse(String(previous.finished_at))+300_000>stamp)return unavailable(kind,config,'failed',String(previous.error_code??'POSTHOG_IMPORT_FAILED'));
  if(previous?.status==='running'){
   const checkpoint=previous.checkpoint as {context?:{origin?:string;scope?:unknown;client?:unknown};expiresAt?:string}|undefined;
   const expires=Date.parse(checkpoint?.expiresAt??'')||Date.parse(String(previous.started_at))+600_000;
   if(expires<=stamp){claim=await claimRun(kind==='quiz'?['overview','byEvent','byHostEvent','daily']:['masterclass']);return unavailable(kind,config,'failed','POSTHOG_QUERY_EXPIRED');}
   // Scheduled work finishes the saved Paris window across midnight. Explicit
   // filtered requests keep their own window and never borrow this report.
   const contextMatches=checkpoint?.context&&isDeepStrictEqual(checkpoint.context.scope,scope)&&isDeepStrictEqual(checkpoint.context.client,client)&&checkpoint.context.origin===new URL(config.host!).origin;
   if(options.resumeRunningPeriod&&contextMatches&&Number.isFinite(Date.parse(String(previous.period_from)))&&Number.isFinite(Date.parse(String(previous.period_to)))){start=new Date(String(previous.period_from)).toISOString();end=new Date(String(previous.period_to)).toISOString();config.from=start;config.to=end;}
   const leased=previous.lease_until?Date.parse(String(previous.lease_until))>stamp:Date.parse(String(previous.started_at))+600_000>stamp;
   if(leased||Date.parse(String(previous.period_from))!==Date.parse(start)||Date.parse(String(previous.period_to))!==Date.parse(end)||
      (checkpoint?.context&&(!isDeepStrictEqual(checkpoint.context.scope,scope)||!isDeepStrictEqual(checkpoint.context.client,client)||checkpoint.context.origin!==new URL(config.host!).origin)))return unavailable(kind,config,'pending');
  }
  let prepared:Awaited<ReturnType<typeof preparePostHogAnalytics>>;
  try{prepared=await(options.prepare??preparePostHogAnalytics)(config,kind);}
  catch(error){
   // Record real metadata failures as attempts too. No aggregate query has been
   // submitted, so the default four-query plan cannot publish any result.
   claim=await claimRun(kind==='quiz'?['overview','byEvent','byHostEvent','daily']:['masterclass']);
   if(claim.busy)return unavailable(kind,config,claim.reason==='POSTHOG_QUERY_EXPIRED'||claim.reason==='POSTHOG_COOLDOWN'?'failed':'pending',claim.reason);
   const code=error instanceof ConnectorError?safeConnectorError(error):'POSTHOG_PREFLIGHT_FAILED';
   await rpc('cockpit_release_posthog',{p_run:claim.runId,p_lease:claim.lease,p_error:failureCode(code)});
   return unavailable(kind,config,'failed',code);
  }
  claim=await claimRun(Object.keys(prepared.queries));
  if(claim.busy)return unavailable(kind,config,claim.reason==='POSTHOG_QUERY_EXPIRED'||claim.reason==='POSTHOG_COOLDOWN'?'failed':'pending',claim.reason);
  if(!claim.lease||!claim.checkpoint||!claim.observedAt||!claim.expiresAt)throw new ConnectorError('INVALID_POSTHOG_CONTINUATION');
  // Expiry and source freshness retain the original run's observation time.
  prepared.deadline=Math.min(prepared.deadline,Date.parse(claim.expiresAt));
  const saved=claim.checkpoint.queries;
  const execution:PostHogReportExecution={resume:Object.fromEntries(Object.entries(saved).map(([name,entry])=>[name,entry!.continuation])),save:async(name,continuation,complete)=>{
   if(Date.now()>=Date.parse(claim!.expiresAt!))throw new ConnectorError('POSTHOG_QUERY_EXPIRED');
   const finished=complete||saved[name]?.complete===true;
   await rpc('cockpit_save_posthog_query',{p_run:claim!.runId,p_lease:claim!.lease,p_name:name,p_continuation:continuation,p_complete:finished});
   saved[name]={continuation,complete:finished};
  }};
  const reader=options.reader??(kind==='quiz'?readPostHogAnalytics:readPostHogMasterclassAnalytics);
  const report=await reader({...config,prepared,execution,now:()=>claim!.observedAt!});
  if(persistenceFailed)return unavailable(kind,config,'failed','database_unavailable');
  if(report.status==='pending'){
   await rpc('cockpit_release_posthog',{p_run:claim.runId,p_lease:claim.lease,p_error:null});
   return report;
  }
  if(!report.coverage.queryComplete||!['complete','empty'].includes(report.status)){
   await rpc('cockpit_release_posthog',{p_run:claim.runId,p_lease:claim.lease,p_error:failureCode(report.safeError)});
   return report;
  }
  if(Object.keys(prepared.queries).some(name=>saved[name as PostHogAggregateQueryName]?.complete!==true))throw new ConnectorError('INVALID_POSTHOG_CONTINUATION');
  report.observedAt=claim.observedAt;
  const records=aggregateRecords(kind,report,namespace,profile,start,end,scope,client);
  const read=kind==='quiz'?(report as PostHogAnalyticsReport).overview?.events??0:(report as PostHogMasterclassReport).byEvent.reduce((n,r)=>n+r.events,0);
  const publication={p_run:claim.runId,p_lease:claim.lease,p_records:records,p_read:read};
  try{await rpc('cockpit_publish_posthog',publication);}
  catch(error){
   // This is the same local transaction payload, not another PostHog POST.
   // A committed transaction returns its digest-idempotent acknowledgement.
   if(!(error instanceof AppError)||error.code!=='database_unavailable'||remainingTotal()<1_000)throw error;
   await rpc('cockpit_publish_posthog',publication);persistenceFailed=false;
  }
  invalidateSourceSnapshots(db);return report;
 }catch(error){
  // A missing DB acknowledgement may have committed a checkpoint/publication.
  // Keep its lease/checkpoint for recovery instead of replacing that outcome.
  if(claim&&!claim.busy&&!persistenceFailed)await rpc('cockpit_release_posthog',{p_run:claim.runId,p_lease:claim.lease,p_error:failureCode(error instanceof ConnectorError?error.code:undefined)}).catch(()=>undefined);
  return unavailable(kind,config,'failed',persistenceFailed?'database_unavailable':error instanceof ConnectorError?safeConnectorError(error):'POSTHOG_IMPORT_FAILED');
 }finally{clearTimeout(timer);controller.abort();}
}

/** Same stored metrics and dimensions as the original imports. No daily
 * distinct count is summed into a visitor count and no missing value is zeroed. */
function aggregateRecords(kind:Kind,report:Report,namespace:string,profile:string,start:string,end:string,scope:PostHogDimensionScope,client:PostHogClientProfile):Row[]{
 if(kind==='masterclass'){
  const mc=report as PostHogMasterclassReport;
  const base={source:'posthog',source_namespace:namespace,metric_key:'posthog_mc_events',period_from:start,period_to:end,report_profile_key:profile,timezone:'Europe/Paris',coverage_state:'complete',unit:'count',currency:null,currency_exponent:null,tax_basis:'unknown',definition_version:profile};
  return [{...base,dimensions_key:'all',value:mc.byEvent.reduce((n,r)=>n+r.events,0),dimensions:{coverage:mc.coverage,observedAt:mc.observedAt},source_locator:'posthog:masterclass:overview'},...mc.byEvent.map(row=>({...base,dimensions_key:`event:${row.event}`,value:row.events,dimensions:{...row},source_locator:`posthog:masterclass:${row.event}`}))];
 }
 const quiz=report as PostHogAnalyticsReport,records:Row[]=[];
 const add=(key:string,dimensions:Row,counts:{events:number;visitors:number|null;sessions:number|null})=>{
  for(const metric of ['events','visitors','sessions'] as const)records.push({source:'posthog',source_namespace:namespace,metric_key:`posthog_${metric}`,period_from:start,period_to:end,dimensions_key:key,report_profile_key:profile,timezone:'Europe/Paris',coverage_state:'complete',value:counts[metric],unit:'count',currency:null,currency_exponent:null,tax_basis:'unknown',dimensions,definition_version:profile,source_locator:`posthog:aggregate:${key}`});
 };
 if(quiz.overview)add('all',{scope,client,coverage:quiz.coverage},quiz.overview);
 for(const row of quiz.byEvent)add(`event:${row.event}`,{event:row.event},row);
 for(const row of quiz.byHostEvent)add(`${row.host}:${row.event}`,{host:row.host,event:row.event},row);
 for(const row of quiz.questions)add(`question:${row.questionNumber??'unknown'}`,{questionNumber:row.questionNumber},row);
 return records;
}
