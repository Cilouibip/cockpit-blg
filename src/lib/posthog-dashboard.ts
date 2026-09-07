import { readPostHogAnalytics, POSTHOG_ANALYTICS_VERSION, type PostHogAnalyticsReport } from '../connectors/posthog-analytics';
import { startOfParisDay } from '../domain/dates';
import { database, type Row } from './db';
import type { DashboardResponse, DashboardFilters, JourneyStep } from './ui-contract';
import { Temporal } from '@js-temporal/polyfill';

const pending=new Map<string,Promise<PostHogAnalyticsReport|null>>();
const cache=new Map<string,{at:number;report:PostHogAnalyticsReport|null}>();
export async function postHogPeriod(from:string,to:string):Promise<PostHogAnalyticsReport|null> {
 if(!process.env.POSTHOG_PERSONAL_API_KEY||!process.env.POSTHOG_HOST||!process.env.POSTHOG_PROJECT_ID)return null;
 const key=`${process.env.POSTHOG_PROJECT_ID}:${from}:${to}`,cached=cache.get(key);
 if(cached&&Date.now()-cached.at<15*60_000)return cached.report;
 if(pending.has(key))return pending.get(key)!;
 const work=(async()=>{
  const db=database(),namespace=process.env.POSTHOG_PROJECT_ID!,start=startOfParisDay(from),end=startOfParisDay(to);
  let runId:string|undefined;
  try {
   runId=await db.rpc<string>('begin_sync',{p_source:'posthog',p_namespace:namespace,p_from:start,p_to:end,p_profile:POSTHOG_ANALYTICS_VERSION,p_coverage_kind:'aggregate_period',p_date_from:from,p_date_to:to});
   const report=await readPostHogAnalytics({host:process.env.POSTHOG_HOST,projectId:namespace,personalApiKey:process.env.POSTHOG_PERSONAL_API_KEY,from:start,to:end});
   if(report.coverage.queryComplete){
    const rows:Row[]=[];
    const add=(key:string,dimensions:Row,counts:{events:number;visitors:number|null;sessions:number|null})=>{
     for(const metric of ['events','visitors','sessions'] as const)rows.push({source:'posthog',source_namespace:namespace,metric_key:`posthog_${metric}`,
      period_from:start,period_to:end,dimensions_key:key,report_profile_key:POSTHOG_ANALYTICS_VERSION,sync_run_id:runId,
      timezone:'Europe/Paris',coverage_state:'complete',value:counts[metric],unit:'count',currency:null,currency_exponent:null,tax_basis:'unknown',dimensions,
      definition_version:POSTHOG_ANALYTICS_VERSION,source_locator:`posthog:aggregate:${key}`});
    };
    if(report.overview)add('all',{},report.overview);
    for(const row of report.byHostEvent)add(`${row.host}:${row.event}`,{host:row.host,event:row.event},{events:row.events,visitors:row.visitors,sessions:row.sessions});
    for(const row of report.questions)add(`question:${row.questionNumber??'unknown'}`,{questionNumber:row.questionNumber},{events:row.events,visitors:row.visitors,sessions:row.sessions});
    await db.upsert('source_aggregates',rows,'source,source_namespace,metric_key,period_from,period_to,dimensions_key,report_profile_key,sync_run_id');
   }
   await db.rpc('finish_sync',{p_run:runId,p_status:report.status==='not_configured'?'failed':report.status,p_read:report.overview?.events??0,p_rejected:0,
    p_complete:report.coverage.queryComplete,p_error:report.safeError?.replace(/[^A-Za-z0-9_ -]/g,'').slice(0,100)??null});
   cache.set(key,{at:Date.now(),report});if(cache.size>50)cache.delete(cache.keys().next().value!);return report;
  } catch {
   if(runId)await db.rpc('finish_sync',{p_run:runId,p_status:'failed',p_read:0,p_rejected:0,p_complete:false,p_error:'POSTHOG_IMPORT_FAILED'}).catch(()=>undefined);
   cache.set(key,{at:Date.now(),report:null});return null;
  }
 })();pending.set(key,work);try{return await work;}finally{pending.delete(key);}
}

/** Browser observations never become backend registrations or CRM people. */
export function applyPostHogQuiz(data:DashboardResponse,report:PostHogAnalyticsReport|null,filters:DashboardFilters):DashboardResponse {
 if(!report?.coverage.queryComplete||report.status!=='complete'||filters.source!=='all'||(filters.campaign&&filters.campaign!=='all')||filters.tunnel==='masterclass')return data;
 if(Date.parse(report.from)!==Date.parse(startOfParisDay(filters.from))||Date.parse(report.to)!==Date.parse(startOfParisDay(Temporal.PlainDate.from(filters.to).add({days:1}).toString())))return data;
 const events=report.byHostEvent.filter(row=>row.host==='quizz.blg-studio.fr');
 if(!events.length)return data;
 const get=(event:string)=>events.find(row=>row.event===event);
 const step=(id:string,label:string,event:string):JourneyStep=>({id,label,value:get(event)?.visitors??null,source:'PostHog',coverage:'Visiteurs distincts sur la période'});
 const quiz={id:'quiz',title:'Quiz',description:'Visiteurs distincts à chaque étape du quiz.',steps:[
  step('arrival','Page du quiz vue','$pageview'),step('start','Quiz commencé','quiz_demarre'),
  step('contacts','Écran coordonnées vu','ecran_coordonnees'),step('sent','Coordonnées envoyées','coordonnees_envoyees'),
  step('saved','Enregistrement confirmé à l’écran','enregistrement_ok'),step('result','Résultat vu','resultat_affiche'),
  step('calendar','Calendrier ouvert','calendrier_affiche'),
 ]};
 const questionsOnlyOnQuiz=!report.byHostEvent.some(row=>row.event==='question_repondue'&&row.host!=='quizz.blg-studio.fr'&&row.events>0);
 data.journeys=data.journeys.map(j=>j.id==='quiz'?quiz:j.id==='questions'&&questionsOnlyOnQuiz?{...j,description:'Visiteurs ayant répondu, par question.',steps:report.questions.filter(q=>q.questionNumber!==null).map(q=>({id:`q${q.questionNumber}`,label:`Question ${q.questionNumber}`,value:q.visitors,source:'PostHog',coverage:'Visiteurs distincts ayant répondu'}))}:j);
 const pages=filters.tunnel==='quiz'?get('$pageview'):report.byEvent.find(row=>row.event==='$pageview');
 if(pages?.sessions!==null&&pages?.sessions!==undefined){
  data.pillars=data.pillars.map(p=>p.id!=='content'?p:{...p,metrics:p.metrics.map(m=>m.id!=='arrivals'?m:{...m,value:pages.sessions,source:filters.tunnel==='quiz'?'PostHog · quiz':'PostHog · sites de production',definition:'Sessions PostHog ayant vu une page du périmètre sur la période.',coverage:'Hôtes de production ; tests identifiables exclus.',updatedAt:report.observedAt,unavailableReason:undefined})});
 }
 return data;
}
