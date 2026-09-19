import type {Database,Row} from '../../src/lib/db';
import {AppError} from '../../src/lib/errors';

type Call={name:string;args:Row};
type Checkpoint=Record<string,{continuation:Row;complete:boolean}>;
type Run={id:string;lease:string;status:'running'|'pending'|'failed'|'complete'|'empty';checkpoint:Checkpoint;published?:Row[];error?:unknown};

/** In-memory contract double. It stores only resumable query metadata, never
 * a PostHog result, and exposes each RPC so a test can assert ordering. */
export function postHogSyncMemory(options:{busy?:boolean;failPublishAck?:boolean}={}) {
 const calls:Call[]=[];const runs:Run[]=[];let serial=0;
 const db:Database={
  probe:async()=>{},select:async()=>[],upsert:async()=>{},
  rpc:async<T>(name:string,args:Row)=>{
   calls.push({name,args});
   if(name==='cockpit_claim_posthog'){
    if(options.busy)return {busy:true,runId:'busy'} as T;
    const previous=runs.find(candidate=>candidate.status==='pending');
    const run=previous??{id:`run-${++serial}`,lease:`lease-${serial}`,status:'running' as const,checkpoint:{}};
    if(previous){previous.status='running';}else runs.push(run);
    const observedAt='2026-02-01T00:00:00.000Z',expiresAt=new Date(Date.now()+60_000).toISOString();
    return {busy:false,runId:run.id,lease:run.lease,checkpoint:{queries:run.checkpoint},observedAt,expiresAt} as T;
   }
   const run=runs.find(candidate=>candidate.id===args.p_run);
   if(!run)throw Error(`unknown synthetic run for ${name}`);
   if(name==='cockpit_save_posthog_query'){
    run.checkpoint[String(args.p_name)]={continuation:args.p_continuation as Row,complete:args.p_complete===true};return true as T;
   }
   if(name==='cockpit_release_posthog'){
    run.error=args.p_error;run.status=args.p_error===null?'pending':'failed';return true as T;
   }
   if(name==='cockpit_publish_posthog'){
    run.published=args.p_records as Row[];run.status='complete';
    if(options.failPublishAck&&calls.filter(call=>call.name==='cockpit_publish_posthog').length===1)throw new AppError('synthetic lost publication acknowledgement',503,'database_unavailable');
    return true as T;
   }
   if(name==='cockpit_source_window')return {runs:[],aggregates:[],selections:[],validations:{},exactRunId:null,latestAttempt:null} as T;
   throw Error(`unexpected RPC ${name}`);
  },
 };
 return {db,calls,runs,receivedRPCcounts:(rpc:string)=>calls.filter(call=>call.name===rpc).length,storedRows:()=>runs.flatMap(run=>run.published??[])};
}

export const syntheticPostHogEnv={POSTHOG_HOST:'https://eu.posthog.com',POSTHOG_PROJECT_ID:'123',POSTHOG_PERSONAL_API_KEY:'synthetic'};
