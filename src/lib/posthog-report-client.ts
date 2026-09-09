import {Temporal} from '@js-temporal/polyfill';
import {createPostHogReportController,type ReportLoadingState,type ReportSelection} from './posthog-report-controller';
import type {PostHogReportState,PostHogReportType} from './posthog-report-request';
import type {DashboardFilters,DashboardResponse} from './ui-contract';

export type PostHogSlot='current'|'previous';
export type PostHogClientState=Partial<Record<PostHogSlot,ReportLoadingState>>;
export type PostHogDescriptor={key:string|null;supported:boolean};
type Options={
 descriptor:(url:string,signal:AbortSignal)=>Promise<PostHogDescriptor>;
 transport:(selection:ReportSelection,signal:AbortSignal)=>Promise<PostHogReportState>;
 dashboard:(url:string,signal:AbortSignal)=>Promise<DashboardResponse>;
 onData:(data:DashboardResponse)=>void;
 onState:(slot:PostHogSlot,state:ReportLoadingState)=>void;
};
export function postHogPreviousFilters(filters:DashboardFilters):DashboardFilters {
 const first=Temporal.PlainDate.from(filters.from),days=first.until(Temporal.PlainDate.from(filters.to)).days+1;
 return {...filters,from:first.subtract({days}).toString(),to:first.subtract({days:1}).toString(),compare:false};
}
const query=(filters:DashboardFilters)=>new URLSearchParams({...filters,compare:String(filters.compare)}).toString();

/** Guards the descriptor, POST and dashboard reload as one selection. Current
 * and previous reports have separate identities and execute in sequence, so a
 * comparison cannot compete with the current source query's time budget. */
export function createPostHogReportClient(options:Options){
 let generation=0;
 const controllers={current:createPostHogReportController({transport:options.transport}),previous:createPostHogReportController({transport:options.transport})};
 const reads=new Set<AbortController>();
 async function bounded<T>(read:(signal:AbortSignal)=>Promise<T>){
  const abort=new AbortController();reads.add(abort);const timer=setTimeout(()=>abort.abort(),20000);
  try{return await new Promise<T>((resolve,reject)=>{
   const stop=()=>reject(new Error('posthog_read_timeout'));abort.signal.addEventListener('abort',stop,{once:true});
   read(abort.signal).then(resolve,reject).finally(()=>abort.signal.removeEventListener('abort',stop));
  });}finally{clearTimeout(timer);reads.delete(abort);}
 }
 function clear(){generation++;controllers.current.clear();controllers.previous.clear();for(const read of reads)read.abort();}
 return {clear,async select(filters:DashboardFilters,type:PostHogReportType){
  clear();const selected=generation,current=()=>selected===generation;
  const fail=(key:string):ReportLoadingState=>({key,state:'failed',message:'Ces chiffres n’ont pas pu être chargés. Réessaie.'});
  const slots:PostHogSlot[]=filters.compare?['current','previous']:['current'];
  for(const slot of slots)options.onState(slot,{key:'',state:'loading',message:slot==='previous'?'Chargement de la comparaison…':'Chargement des chiffres…'});
  for(const slot of slots){
   if(!current())return;
   const period=slot==='current'?{...filters,compare:false}:postHogPreviousFilters(filters),url=`/api/reports/posthog?${query(period)}&type=${type}`;
   let key='';
   try{
    const descriptor=await bounded(signal=>options.descriptor(url,signal));if(!current())return;
    if(!descriptor.supported||!descriptor.key){options.onState(slot,{key:'',state:'unsupported',message:'Ces filtres ne sont pas encore disponibles pour ce parcours.'});continue;}
    key=descriptor.key;let result:ReportLoadingState|undefined;
    await controllers[slot].select({key,url},state=>{result=state;if(current()&&state.state!=='ready')options.onState(slot,state);});
    if(!current())return;
    if(result?.state!=='ready')continue;
    // The GET may land on another server with an earlier cached absence.
    const data=await bounded(signal=>options.dashboard(`/api/dashboard?${query(filters)}&refreshPosthog=1`,signal));
    if(!current())return;
    if(data.period.from!==filters.from||data.period.to!==filters.to)throw new Error('posthog_dashboard_period_mismatch');
    options.onData(data);options.onState(slot,result);
   }catch{if(current())options.onState(slot,fail(key));}
  }
 }};
}
