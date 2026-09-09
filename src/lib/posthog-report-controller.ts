import type {PostHogReportState} from './posthog-report-request';
import type {DashboardFilters} from './ui-contract';
export function postHogReportSelectionKey(filters:Pick<DashboardFilters,'from'|'to'|'source'|'campaign'>,type:'quiz'|'masterclass',context:{namespace:string;profile:string}){
 return JSON.stringify(['posthog-report-request-v2',context.namespace,context.profile,type,filters.from,filters.to,filters.source,filters.campaign||'']);
}
export type ReportSelection={key:string;url:string};
export type ReportLoadingState=PostHogReportState|{key:string;state:'loading';message:string};
type Options={transport:(selection:ReportSelection,signal:AbortSignal)=>Promise<PostHogReportState>;
 sleep?:(ms:number)=>Promise<void>;now?:()=>number;budgetMs?:number;maxAttempts?:number};

/** One controller per visible PH slot (current/comparison). It owns no dashboard
 * values and cannot erase cash, Meta or CRM. Consumers reload only on its ready
 * callback; stale responses never produce that callback. */
export function createPostHogReportController(options:Options){
 const pending=new Map<string,Promise<PostHogReportState>>();let generation=0,activeKey:string|null=null;
 const now=options.now??Date.now,sleep=options.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
 const budget=Math.min(120000,Math.max(1000,options.budgetMs??120000)),maxAttempts=Math.min(8,Math.max(1,options.maxAttempts??8));
 const failed=(key:string):PostHogReportState=>({key,state:'failed',message:'Ces chiffres n’ont pas pu être chargés. Réessaie.'});
 async function work(selection:ReportSelection){
  const deadline=now()+budget,abort=new AbortController();const timer=setTimeout(()=>abort.abort(),budget);
  const untilAbort=<T>(promise:Promise<T>)=>new Promise<T>((resolve,reject)=>{
   const stop=()=>reject(new Error('report_time_budget'));
   if(abort.signal.aborted){stop();return;}
   abort.signal.addEventListener('abort',stop,{once:true});
   promise.then(resolve,reject).finally(()=>abort.signal.removeEventListener('abort',stop));
  });
  try{
   for(let attempt=0;attempt<maxAttempts&&!abort.signal.aborted;attempt++){
    if(activeKey!==selection.key)return failed(selection.key);
    const result=await untilAbort(options.transport(selection,abort.signal));
    if(result.key!==selection.key)return failed(selection.key);
    if(result.state!=='waiting')return result;
    const delay=Math.min(15000,Math.max(1000,result.retryAfterMs??15000));
    if(now()+delay>=deadline||attempt+1>=maxAttempts)return failed(selection.key);
    await untilAbort(sleep(delay));
   }
   return failed(selection.key);
  }catch{return failed(selection.key);}finally{clearTimeout(timer);}
 }
 return {
  async select(selection:ReportSelection,onState:(state:ReportLoadingState)=>void){
   const selected=++generation;activeKey=selection.key;onState({key:selection.key,state:'loading',message:'Chargement des chiffres…'});
   let operation=pending.get(selection.key);
   if(!operation){
    if(pending.size>=8){onState(failed(selection.key));return;}
    operation=work(selection);pending.set(selection.key,operation);
    void operation.finally(()=>{if(pending.get(selection.key)===operation)pending.delete(selection.key);});
   }
   const state=await operation;if(selected===generation)onState(state);
  },
  clear(){generation++;activeKey=null;},
 };
}
