import { readPostHogAnalytics, postHogScopeProfile, postHogClientProfile, POSTHOG_DEFAULT_SCOPE, type PostHogAnalyticsReport, type PostHogDimensionScope, type PostHogClientProfile, readPostHogMasterclassAnalytics, postHogMasterclassProfile, type PostHogMasterclassReport, type MasterclassObservation } from '../connectors/posthog-analytics';
import { startOfParisDay } from '../domain/dates';
import { database, type Database, type Row } from './db';
import { readSourceSnapshot, invalidateSourceSnapshots,sourceAttempt } from './source-snapshots';
import type { DashboardResponse, DashboardFilters, JourneyStep } from './ui-contract';
import { Temporal } from '@js-temporal/polyfill';

export function postHogScopeFromFilters(filters:Pick<DashboardFilters,'source'|'campaign'>):PostHogDimensionScope|null {
 const campaign=filters.campaign;
 if(!campaign||campaign==='all')return {source:filters.source,campaignId:null};
 const match=/^meta:(\d{1,30})$/.exec(campaign);
 return match?{source:filters.source,campaignId:match[1]}:null;
}

const pending=new Map<string,Promise<PostHogAnalyticsReport|null>>();
export async function postHogPeriod(from:string,to:string,options:{db?:Database;reader?:typeof readPostHogAnalytics;scope?:PostHogDimensionScope;client?:PostHogClientProfile}={}):Promise<PostHogAnalyticsReport|null> {
 if(!process.env.POSTHOG_PERSONAL_API_KEY||!process.env.POSTHOG_HOST||!process.env.POSTHOG_PROJECT_ID)return null;
 // Explicit refresh must query the source again, including after a failure.
 // Concurrent requests in one instance still share their in-flight work.
 const scope=options.scope??POSTHOG_DEFAULT_SCOPE,client=options.client??postHogClientProfile(),profile=postHogScopeProfile(scope,client);
 const key=`${process.env.POSTHOG_HOST}:${process.env.POSTHOG_PROJECT_ID}:${profile}:${from}:${to}`;
 if(pending.has(key))return pending.get(key)!;
 const work=(async()=>{
  const db=options.db??database(),namespace=process.env.POSTHOG_PROJECT_ID!,start=startOfParisDay(from),end=startOfParisDay(to);
  let runId:string|undefined;
  try {
   runId=await db.rpc<string>('begin_sync_stream',{p_stream:'quiz_observations',p_source:'posthog',p_namespace:namespace,p_from:start,p_to:end,p_profile:profile,p_coverage_kind:'aggregate_period',p_date_from:from,p_date_to:to});
   const report=await (options.reader??readPostHogAnalytics)({host:process.env.POSTHOG_HOST,projectId:namespace,personalApiKey:process.env.POSTHOG_PERSONAL_API_KEY,from:start,to:end,scope,client});
   if(report.coverage.queryComplete){
    const rows:Row[]=[];
    const add=(key:string,dimensions:Row,counts:{events:number;visitors:number|null;sessions:number|null})=>{
     for(const metric of ['events','visitors','sessions'] as const)rows.push({source:'posthog',source_namespace:namespace,metric_key:`posthog_${metric}`,
      period_from:start,period_to:end,dimensions_key:key,report_profile_key:profile,sync_run_id:runId,
      timezone:'Europe/Paris',coverage_state:'complete',value:counts[metric],unit:'count',currency:null,currency_exponent:null,tax_basis:'unknown',dimensions,
      definition_version:profile,source_locator:`posthog:aggregate:${key}`});
    };
    if(report.overview)add('all',{scope,client,coverage:report.coverage},report.overview);
    for(const row of report.byEvent)add(`event:${row.event}`,{event:row.event},row);
    for(const row of report.byHostEvent)add(`${row.host}:${row.event}`,{host:row.host,event:row.event},{events:row.events,visitors:row.visitors,sessions:row.sessions});
    for(const row of report.questions)add(`question:${row.questionNumber??'unknown'}`,{questionNumber:row.questionNumber},{events:row.events,visitors:row.visitors,sessions:row.sessions});
    await db.upsert('source_aggregates',rows,'source,source_namespace,metric_key,period_from,period_to,dimensions_key,report_profile_key,sync_run_id');
   }
   await db.rpc('finish_sync',{p_run:runId,p_status:report.status==='not_configured'?'failed':report.status,p_read:report.overview?.events??0,p_rejected:0,
    p_complete:report.coverage.queryComplete,p_error:report.safeError?.replace(/[^A-Za-z0-9_ -]/g,'').slice(0,100)??null});
   invalidateSourceSnapshots(db);
   return report;
  } catch {
   if(runId)await db.rpc('finish_sync',{p_run:runId,p_status:'failed',p_read:0,p_rejected:0,p_complete:false,p_error:'POSTHOG_IMPORT_FAILED'}).catch(()=>undefined);
   return null;
  }
 })();pending.set(key,work);try{return await work;}finally{pending.delete(key);}
}

type DashboardCounts = {events:number;visitors:number|null;sessions:number|null};
export type DashboardPostHogReport = Pick<PostHogAnalyticsReport,'from'|'to'|'observedAt'|'status'|'scope'|'client'> & {
 coverage:{queryComplete:boolean};latestAttempt?:import('./ui-contract').SourceAttempt|null;
 byEvent:(DashboardCounts & Pick<PostHogAnalyticsReport['byEvent'][number],'event'>)[];
 byHostEvent:(DashboardCounts & Pick<PostHogAnalyticsReport['byHostEvent'][number],'host'|'event'>)[];
 questions:(DashboardCounts & {questionNumber:number|null})[];
};
/** Read a previously imported exact-period report. Distinct counts from
 * different periods or hosts are never added to manufacture a missing report. */
export async function readPostHogPeriod(db:Database,from:string,to:string,options:{scope?:PostHogDimensionScope;client?:PostHogClientProfile}={}):Promise<DashboardPostHogReport|null>{
 const namespace=process.env.POSTHOG_PROJECT_ID;if(!namespace)return null;
 const scope=options.scope??POSTHOG_DEFAULT_SCOPE,client=options.client??postHogClientProfile(),profile=postHogScopeProfile(scope,client);
 const start=startOfParisDay(from),end=startOfParisDay(to),snapshot=await readSourceSnapshot(db,'posthog',namespace,{stream:'quiz_observations',profile,from,to,timezone:'Europe/Paris',currency:null,currencyExponent:null,kind:'exact_report'});
 const run=snapshot.runs.filter(r=>r.id===snapshot.exactRunId&&r.query_profile_key===profile&&Date.parse(String(r.period_from))===Date.parse(start)&&Date.parse(String(r.period_to))===Date.parse(end)&&snapshot.aggregates.some(a=>a.sync_run_id===r.id&&a.dimensions_key==='all'&&a.metric_key==='posthog_events'&&a.value!==null))
  .sort((a,b)=>String(b.finished_at).localeCompare(String(a.finished_at))||String(b.id).localeCompare(String(a.id)))[0];
 if(!run)return null;
 const groups=new Map<string,{dimensions:Row;events:number|null;visitors:number|null;sessions:number|null}>();
 for(const row of snapshot.aggregates.filter(r=>r.sync_run_id===run.id&&r.report_profile_key===profile&&r.unit==='count'&&r.timezone==='Europe/Paris'&&Date.parse(String(r.period_from))===Date.parse(start)&&Date.parse(String(r.period_to))===Date.parse(end))){
  const key=String(row.dimensions_key);let group=groups.get(key);if(!group){group={dimensions:row.dimensions as Row,events:null,visitors:null,sessions:null};groups.set(key,group);}
  const metric=String(row.metric_key).replace('posthog_','');
  if(['events','visitors','sessions'].includes(metric)&&row.value!==null&&Number.isSafeInteger(Number(row.value))&&Number(row.value)>=0)group[metric as 'events'|'visitors'|'sessions']=Number(row.value);
 }
 const report:DashboardPostHogReport={scope,client,latestAttempt:sourceAttempt(snapshot),from:start,to:end,observedAt:String(run.source_as_of??run.started_at),status:run.status==='empty'?'empty':'complete',byEvent:[],byHostEvent:[],questions:[],coverage:{queryComplete:true}};
 for(const [key,g] of groups){
  if(g.events===null)continue;
  const counts={events:g.events,visitors:g.visitors,sessions:g.sessions};
  if(key.startsWith('question:'))report.questions.push({questionNumber:typeof g.dimensions.questionNumber==='number'?g.dimensions.questionNumber:null,...counts});
  else if(g.dimensions.host&&g.dimensions.event)report.byHostEvent.push({host:g.dimensions.host as PostHogAnalyticsReport['byHostEvent'][number]['host'],event:g.dimensions.event as PostHogAnalyticsReport['byEvent'][number]['event'],...counts});
  else if(key.startsWith('event:')&&g.dimensions.event)report.byEvent.push({event:g.dimensions.event as PostHogAnalyticsReport['byEvent'][number]['event'],...counts});
 }
 report.questions.sort((a,b)=>(a.questionNumber??99)-(b.questionNumber??99));
 return report;
}

/** Browser observations never become backend registrations or CRM people. */
export function applyPostHogQuiz(data:DashboardResponse,report:DashboardPostHogReport|null,filters:DashboardFilters):DashboardResponse {
 if(!report?.coverage.queryComplete||!['complete','empty'].includes(report.status)||filters.tunnel==='masterclass')return data;
 const selectedScope=postHogScopeFromFilters(filters),actualScope=report.scope??POSTHOG_DEFAULT_SCOPE;
 if(!selectedScope||selectedScope.source!==actualScope.source||selectedScope.campaignId!==actualScope.campaignId)return data;
 if(Date.parse(report.from)!==Date.parse(startOfParisDay(filters.from))||Date.parse(report.to)!==Date.parse(startOfParisDay(Temporal.PlainDate.from(filters.to).add({days:1}).toString())))return data;
 const quizHost=(report.client??postHogClientProfile()).quizHost;
 const events=report.byHostEvent.filter(row=>row.host===quizHost);
 if(!events.length)return data;
 const get=(event:string)=>events.find(row=>row.event===event);
 const step=(id:string,label:string,event:string):JourneyStep=>({id,label,value:get(event)?.visitors??null,source:'PostHog',coverage:'Visiteurs identifiés distincts sur la période'});
 const quiz={id:'quiz',title:'Quiz',description:'Visiteurs identifiés distincts à chaque étape du quiz ; sélection appliquée aux propriétés UTM observées.',steps:[
  step('arrival','Page du quiz vue','$pageview'),step('start','Quiz commencé','quiz_demarre'),
  step('contacts','Écran coordonnées vu','ecran_coordonnees'),step('sent','Coordonnées envoyées','coordonnees_envoyees'),
  step('saved','Enregistrement confirmé à l’écran','enregistrement_ok'),step('result','Résultat vu','resultat_affiche'),
  step('calendar','Calendrier ouvert','calendrier_affiche'),
 ]};
 const questionsOnlyOnQuiz=!report.byHostEvent.some(row=>row.event==='question_repondue'&&row.host!==quizHost&&row.events>0);
 data.journeys=data.journeys.map(j=>j.id==='quiz'?quiz:j.id==='questions'&&questionsOnlyOnQuiz?{...j,description:'Visiteurs ayant répondu, par question.',steps:report.questions.filter(q=>q.questionNumber!==null).map(q=>({id:`q${q.questionNumber}`,label:`Question ${q.questionNumber}`,value:q.visitors,source:'PostHog',coverage:'Visiteurs distincts ayant répondu'}))}:j);
 const pages=filters.tunnel==='quiz'?get('$pageview'):report.byEvent.find(row=>row.event==='$pageview');
 if(pages?.sessions!==null&&pages?.sessions!==undefined){
  data.pillars=data.pillars.map(p=>p.id!=='content'?p:{...p,metrics:p.metrics.map(m=>m.id!=='arrivals'?m:{...m,value:pages.sessions,source:filters.tunnel==='quiz'?'PostHog · quiz':'PostHog · sites de production',definition:'Sessions PostHog ayant vu une page du périmètre sur la période.',coverage:'Hôtes de production ; tests identifiables exclus ; source et campagne issues des UTM observées. Les sessions sans identifiant SDK restent hors du compte.',updatedAt:report.observedAt,latestAttempt:report.latestAttempt,unavailableReason:undefined})});
 }
 return data;
}

const masterclassPending=new Map<string,Promise<PostHogMasterclassReport|null>>();
/** Separate bounded import: never chained into the quiz refresh's time budget. */
export async function postHogMasterclassPeriod(from:string,to:string,options:{db?:Database;reader?:typeof readPostHogMasterclassAnalytics;client?:PostHogClientProfile}={}):Promise<PostHogMasterclassReport|null>{
 const namespace=process.env.POSTHOG_PROJECT_ID;if(!namespace||!process.env.POSTHOG_HOST||!process.env.POSTHOG_PERSONAL_API_KEY)return null;
 const client=options.client??postHogClientProfile(),profile=postHogMasterclassProfile(client),start=startOfParisDay(from),end=startOfParisDay(to),key=`${namespace}:${profile}:${from}:${to}`;
 if(masterclassPending.has(key))return masterclassPending.get(key)!;
 const work=(async()=>{
  const db=options.db??database();let runId:string|undefined;
  try{
   runId=await db.rpc<string>('begin_sync_stream',{p_source:'posthog',p_namespace:namespace,p_from:start,p_to:end,p_profile:profile,p_coverage_kind:'aggregate_period',p_stream:'masterclass_observations',p_date_from:from,p_date_to:to});
   const report=await(options.reader??readPostHogMasterclassAnalytics)({host:process.env.POSTHOG_HOST,projectId:namespace,personalApiKey:process.env.POSTHOG_PERSONAL_API_KEY,from:start,to:end,client});
   const complete=report.coverage.queryComplete&&['complete','empty'].includes(report.status);
   if(complete){
    const base={source:'posthog',source_namespace:namespace,metric_key:'posthog_mc_events',period_from:start,period_to:end,report_profile_key:profile,sync_run_id:runId,timezone:'Europe/Paris',coverage_state:'complete',unit:'count',currency:null,currency_exponent:null,tax_basis:'unknown',definition_version:profile};
    await db.upsert('source_aggregates',[{...base,dimensions_key:'all',value:report.byEvent.reduce((n,r)=>n+r.events,0),dimensions:{coverage:report.coverage,observedAt:report.observedAt},source_locator:'posthog:masterclass:overview'},...report.byEvent.map(row=>({...base,dimensions_key:`event:${row.event}`,value:row.events,dimensions:{...row},source_locator:`posthog:masterclass:${row.event}`}))],'source,source_namespace,metric_key,period_from,period_to,dimensions_key,report_profile_key,sync_run_id');
   }
   await db.rpc('finish_sync',{p_run:runId,p_status:complete?'complete':'failed',p_read:report.byEvent.reduce((n,r)=>n+r.events,0),p_rejected:0,p_complete:complete,p_error:report.safeError??null});
   invalidateSourceSnapshots(db);return report;
  }catch{
   if(runId)await db.rpc('finish_sync',{p_run:runId,p_status:'failed',p_read:0,p_rejected:0,p_complete:false,p_error:'POSTHOG_MASTERCLASS_IMPORT_FAILED'}).catch(()=>undefined);
   return null;
  }
 })();masterclassPending.set(key,work);try{return await work;}finally{masterclassPending.delete(key);}
}
export async function readPostHogMasterclassPeriod(db:Database,from:string,to:string,options:{client?:PostHogClientProfile}={}):Promise<PostHogMasterclassReport|null>{
 const namespace=process.env.POSTHOG_PROJECT_ID;if(!namespace)return null;
 const profile=postHogMasterclassProfile(options.client??postHogClientProfile()),start=startOfParisDay(from),end=startOfParisDay(to),snapshot=await readSourceSnapshot(db,'posthog',namespace,{stream:'masterclass_observations',profile,from,to,timezone:'Europe/Paris',currency:null,currencyExponent:null,kind:'exact_report'});
 const run=snapshot.runs.filter(r=>r.id===snapshot.exactRunId&&r.query_profile_key===profile&&r.stream_key==='masterclass_observations'&&Date.parse(String(r.period_from))===Date.parse(start)&&Date.parse(String(r.period_to))===Date.parse(end)&&snapshot.aggregates.some(a=>a.sync_run_id===r.id&&a.dimensions_key==='all'))
  .sort((a,b)=>String(b.finished_at).localeCompare(String(a.finished_at))||String(b.id).localeCompare(String(a.id)))[0];
 if(!run)return null;
 const rows=snapshot.aggregates.filter(r=>r.sync_run_id===run.id&&r.report_profile_key===profile&&r.metric_key==='posthog_mc_events'&&r.unit==='count'&&r.timezone==='Europe/Paris'&&Date.parse(String(r.period_from))===Date.parse(start)&&Date.parse(String(r.period_to))===Date.parse(end));
 const overview=rows.find(r=>r.dimensions_key==='all');if(!overview)return null;
 const byEvent=rows.filter(r=>String(r.dimensions_key).startsWith('event:')).map(r=>r.dimensions as unknown as MasterclassObservation);
 return {source:'posthog',profile,from:start,to:end,observedAt:String((overview.dimensions as Row).observedAt??run.finished_at),status:Number(overview.value)>0?'complete':'empty',byEvent,coverage:(overview.dimensions as Row).coverage as PostHogMasterclassReport['coverage']};
}
export function applyPostHogMasterclass(data:DashboardResponse,report:PostHogMasterclassReport|null,filters:DashboardFilters):DashboardResponse{
 const scope=postHogScopeFromFilters(filters);
 if(!report?.coverage.queryComplete||!['complete','empty'].includes(report.status)||!scope||scope.source!=='all'||scope.campaignId||filters.tunnel==='quiz'||Date.parse(report.from)!==Date.parse(startOfParisDay(filters.from))||Date.parse(report.to)!==Date.parse(startOfParisDay(Temporal.PlainDate.from(filters.to).add({days:1}).toString())))return data;
 const events=report.byEvent.reduce((n,r)=>n+r.events,0),unlocated=report.byEvent.reduce((n,r)=>n+r.unlocatedEvents,0),excluded=report.byEvent.reduce((n,r)=>n+r.excludedEvents,0),pages=report.byEvent.find(r=>r.event==='mc_page_view');
 data.journeys=data.journeys.map(j=>j.id!=='masterclass'?j:{...j,description:`${events} événement(s) reçus du kit masterclass sur la période ; ${unlocated} sans adresse de page et ${excluded} hors hôte de production autorisé. Ces observations ne certifient ni visites de production, ni contacts enregistrés, ni durée vidéo.`,steps:[{id:'kit_page_observations',label:'Événements de page reçus du kit',value:pages?.events??null,source:'PostHog · kit masterclass',coverage:'Comptage d’événements ; adresse de production à distinguer. Une valeur absente ne signifie pas zéro visite.'},...j.steps.filter(s=>s.id!=='kit_page_observations')]});
 return data;
}
