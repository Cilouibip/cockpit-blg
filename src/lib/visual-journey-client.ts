import type {VisualJourneyReport} from './visual-journey-contract';
type Options={url:string;signal:AbortSignal;transport:(url:string,signal:AbortSignal)=>Promise<VisualJourneyReport>;onReport:(report:VisualJourneyReport)=>void;sleep?:(ms:number,signal:AbortSignal)=>Promise<void>;budgetMs?:number;now?:()=>number};
const delay=(ms:number,signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{const stop=()=>{clearTimeout(timer);reject(new Error('aborted'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve();},ms);if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true});});
/** Poll only the signed continuation for the current filter. Completed CRM stages stay visible. */
export async function loadVisualJourney(options:Options):Promise<void>{
 const controller=new AbortController(),stop=()=>controller.abort(),budget=Math.min(120000,options.budgetMs??120000),now=options.now??Date.now,deadline=now()+budget;
 if(options.signal.aborted)controller.abort();else options.signal.addEventListener('abort',stop,{once:true});const timer=setTimeout(stop,budget);
 let resume:string|undefined;
 try{
  for(let attempt=0;attempt<8&&!controller.signal.aborted;attempt++){
   const url=options.url+(resume?'&resume='+encodeURIComponent(resume):'');
   const report=await options.transport(url,controller.signal);if(controller.signal.aborted)return;
   options.onReport(report);if(!report.loading)return;
   resume=report.loading.resume;
   const wait=Math.max(1000,Math.min(15000,report.loading.retryAfterMs));
   if(now()+wait>=deadline)break;
   await (options.sleep??delay)(wait,controller.signal);
  }
  if(!options.signal.aborted)throw new Error('La lecture des visites prend plus de temps que prévu. Les autres chiffres restent disponibles. Réessaie dans un instant.');
 }catch(error){
  if(controller.signal.aborted&&!options.signal.aborted)throw new Error('La lecture des visites prend plus de temps que prévu. Les autres chiffres restent disponibles. Réessaie dans un instant.');
  throw error;
 }finally{clearTimeout(timer);options.signal.removeEventListener('abort',stop);controller.abort();}
}
