import type {VisualJourneyReport} from './visual-journey-contract';
type Options={url:string;signal:AbortSignal;transport:(url:string,signal:AbortSignal)=>Promise<VisualJourneyReport>;onReport:(report:VisualJourneyReport)=>void;sleep?:(ms:number,signal:AbortSignal)=>Promise<void>;budgetMs?:number;now?:()=>number};
/** Total browser wait and call count. The signed resume token lives 5 min from the
 * first pending answer and a PostHog continuation 10 min: both outlast this budget. */
export const VISUAL_JOURNEY_BUDGET_MS=240_000,VISUAL_JOURNEY_MAX_CALLS=14;
export const VISUAL_JOURNEY_UNFINISHED='Lecture des visites non terminée';
/** The browser stopped waiting for PostHog; completed CRM stages stay on screen. */
export class VisualJourneyUnfinished extends Error{
 constructor(){super(VISUAL_JOURNEY_UNFINISHED+'. Les autres chiffres restent disponibles. Réessaie dans un instant.');this.name='VisualJourneyUnfinished';}
}
const delay=(ms:number,signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{const stop=()=>{clearTimeout(timer);reject(new Error('aborted'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve();},ms);if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true});});
/** Poll only the signed continuation for the current filter. Completed CRM stages stay visible. */
export async function loadVisualJourney(options:Options):Promise<void>{
 const controller=new AbortController(),stop=()=>controller.abort(),budget=Math.min(VISUAL_JOURNEY_BUDGET_MS,options.budgetMs??VISUAL_JOURNEY_BUDGET_MS),now=options.now??Date.now,deadline=now()+budget;
 if(options.signal.aborted)controller.abort();else options.signal.addEventListener('abort',stop,{once:true});const timer=setTimeout(stop,budget);
 let resume:string|undefined;
 try{
  for(let attempt=0;attempt<VISUAL_JOURNEY_MAX_CALLS&&!controller.signal.aborted;attempt++){
   const url=options.url+(resume?'&resume='+encodeURIComponent(resume):'');
   const report=await options.transport(url,controller.signal);if(options.signal.aborted)return;
   // A report that lands as the budget expires is still shown; only a filter change discards it.
   options.onReport(report);if(!report.loading)return;
   if(controller.signal.aborted)break;
   resume=report.loading.resume;
   const wait=Math.max(1000,Math.min(15000,report.loading.retryAfterMs));
   if(now()+wait>=deadline)break;
   await (options.sleep??delay)(wait,controller.signal);
  }
  if(!options.signal.aborted)throw new VisualJourneyUnfinished();
 }catch(error){
  if(controller.signal.aborted&&!options.signal.aborted)throw new VisualJourneyUnfinished();
  throw error;
 }finally{clearTimeout(timer);options.signal.removeEventListener('abort',stop);controller.abort();}
}
/** Once the browser stops waiting, a `running` PostHog read becomes `unfinished`: the
 * pending wording is replaced everywhere, no count is filled in, other sources are kept. */
export function unfinishedVisualJourney(report:VisualJourneyReport,reason:string):VisualJourneyReport{
 const posthog=report.freshness.posthog;
 if(posthog.status!=='running')return report;
 const settled=JSON.parse(JSON.stringify(report),(_key,value:unknown)=>posthog.reason&&value===posthog.reason?reason:value) as VisualJourneyReport;
 delete settled.loading;
 settled.freshness.posthog={...settled.freshness.posthog,status:'unfinished',reason};
 return settled;
}
