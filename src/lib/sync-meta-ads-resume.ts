import { Temporal } from '@js-temporal/polyfill';
import { syncMeta } from '../connectors/meta';
import { ConnectorError } from '../connectors/http';
import { AppError } from './errors';
import type { Database, Row } from './db';
type Account={accountId:string;currency:string;timezone:string};
type Checkpoint={metaAdsVersion:1;partitions:{from:string;to:string}[];index:number;page:number;totalPages:number;cursor:string|null;done:boolean;account?:Account};
type Claim={busy:boolean;runId:string;lease:string;from:string;to:string;observedAt:string;checkpoint:Checkpoint;read:number};
type Options={db:Database;env:NodeJS.ProcessEnv;fetcher?:typeof fetch;signal?:AbortSignal;budget?:{remainingWorkMs:()=>number;remainingTotalMs:()=>number}};
function validate(c:Claim){
 const cp=c.checkpoint;
 if(!c.lease||!Number.isFinite(Date.parse(c.observedAt))||cp?.metaAdsVersion!==1||!Array.isArray(cp.partitions)||!cp.partitions.length||!Number.isInteger(cp.index)||cp.index<0||cp.index>cp.partitions.length||!Number.isInteger(cp.page)||cp.page<0||!Number.isInteger(cp.totalPages)||cp.totalPages<0||cp.totalPages>20+cp.partitions.length-1||!Number.isSafeInteger(c.read)||c.read<0||c.read>2000||cp.done!==(cp.index===cp.partitions.length))throw new ConnectorError('INVALID_META_CONTINUATION');
 let day=c.from;
 for(const p of cp.partitions){if(p.from!==day||p.to<=p.from||Temporal.PlainDate.from(p.from).until(Temporal.PlainDate.from(p.to)).days>7)throw new ConnectorError('INVALID_META_CONTINUATION');day=p.to;}
 if(day!==c.to||Temporal.PlainDate.from(c.from).until(Temporal.PlainDate.from(c.to)).days>93)throw new ConnectorError('INVALID_META_CONTINUATION');
}
/** Bounded invocations resume the same frozen whole scope. Every page and cursor
 * share a database transaction; current readers keep their previous publication. */
export async function synchronizeMetaAdsResumable(from:string,to:string,resume:boolean,options:Options){
 const {db,env}=options,namespace=(env.META_AD_ACCOUNT_ID||'').replace(/^act_/,''),version=env.META_API_VERSION||'v23.0';
 const started=performance.now(),work=()=>Math.min(40_000-(performance.now()-started),options.budget?.remainingWorkMs()??40_000),total=()=>Math.min(45_000-(performance.now()-started),options.budget?.remainingTotalMs()??45_000);
 let claim:Claim|undefined,persistenceFailed=false;
 const rpc=async<T>(name:string,args:Row)=>{
  const timeoutMs=Math.max(1,Math.floor(Math.min(5_000,total())));
  try{return await db.rpc<T>(name,args,{timeoutMs});}catch(error){persistenceFailed=true;throw error;}
 };
 const counts=()=>({read:claim?.read??0,accepted:claim?.read??0,rejected:0,pages:claim?.checkpoint?.totalPages??0});
 const incomplete=(status:'pending'|'failed',safeError?:string)=>({status,runId:claim?.runId,counts:counts(),coverage:{from:claim?.from??from,to:claim?.to??to,complete:false},...(safeError?{safeError}:{})});
 try{
  claim=await rpc<Claim>('cockpit_claim_meta_ads',{p_namespace:namespace,p_profile:`${version}-ad-day-none`,p_from:from,p_to:to,p_resume:resume});
  if(claim.busy)return {status:'waiting',runId:claim.runId,coverage:{from,to,complete:false}};
  validate(claim);
  while(!claim.checkpoint.done){
   // Reserve source/DB margins, keeping both the existing tick's deadline and
   // any caller cancellation. A new page is attempted only with 20 seconds left.
   if(work()<20_000||options.signal?.aborted)break;
   if(claim.checkpoint.totalPages>=20+claim.checkpoint.partitions.length-1)throw new ConnectorError('PAGE_LIMIT_REACHED');
   const cp=claim.checkpoint,part=cp.partitions[cp.index],controller=new AbortController();
   const timer=setTimeout(()=>controller.abort(),Math.max(1,Math.min(20_000,work()-5_000)));
   const signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
   let staged=false,account:Account|undefined;
   try{
    const result=await syncMeta({accessToken:env.META_ACCESS_TOKEN,accountId:namespace,apiVersion:version,from:part.from,to:part.to,cursor:cp.cursor??undefined,maxPages:1,requireValidPages:true,fetcher:options.fetcher,signal,now:()=>claim!.observedAt,
     onAccount:value=>{if(cp.account&&(cp.account.accountId!==value.accountId||cp.account.currency!==value.currency||cp.account.timezone!==value.timezone))throw new ConnectorError('META_ACCOUNT_CHANGED');account=value;},
     commitPage:async(page)=>{
      if(!account)throw new ConnectorError('INVALID_META_ACCOUNT');
      const saved=await rpc<{checkpoint:Checkpoint;read:number}>('cockpit_stage_meta_ads',{p_run:claim!.runId,p_lease:claim!.lease,p_index:cp.index,p_page:cp.page,p_before:cp.cursor,p_records:page.records,p_next:page.checkpoint.cursor??null,p_terminal:page.terminal,p_account:account});
      claim!.checkpoint=saved.checkpoint;claim!.read=saved.read;staged=true;
     }});
    if(result.counts.rejected)throw new ConnectorError('INVALID_META_ROW');
    if(!staged){
     if(result.safeError==='CONNECTOR_ABORTED')break;
     // A generic request HTTP400 is terminal; the reviewed transient400 retry
     // remains exclusively in meta-http. Preserve only network/429/5xx work.
     const code=/^UPSTREAM_HTTP_ERROR \(HTTP 4\d\d\)$/.test(result.safeError??'')&&result.safeError!=='UPSTREAM_HTTP_ERROR (HTTP 429)'?'META_REQUEST_REJECTED':result.safeError?.split(' ')[0];
     throw new ConnectorError(code&&/^[A-Z_]{1,60}$/.test(code)?code:'META_IMPORT_FAILED');
    }
    // maxPages=1 intentionally yields PAGE_LIMIT_REACHED after a saved
    // nonterminal page; its cursor advances in the next bounded invocation.
   }finally{clearTimeout(timer);controller.abort();}
  }
  if(!claim.checkpoint.done){await rpc('cockpit_release_meta_ads',{p_run:claim.runId,p_lease:claim.lease,p_error:null});return incomplete('pending');}
  const published=await rpc<{status:'empty'|'complete'}>('cockpit_publish_meta_ads',{p_run:claim.runId,p_lease:claim.lease});
  return {status:published.status,runId:claim.runId,counts:counts(),coverage:{from:claim.from,to:claim.to,complete:true,observedAt:claim.observedAt}};
 }catch(error){
  const code=error instanceof ConnectorError?error.code:error instanceof AppError?error.code:'META_IMPORT_FAILED';
  if(claim&&!claim.busy&&!persistenceFailed)await rpc('cockpit_release_meta_ads',{p_run:claim.runId,p_lease:claim.lease,p_error:/^[A-Z_]{1,60}$/.test(code)?code:'META_IMPORT_FAILED'}).catch(()=>undefined);
  return incomplete('failed',code);
 }
}
