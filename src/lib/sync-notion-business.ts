import { Temporal } from '@js-temporal/polyfill';
import { BLG_NOTION_FIELDS, syncNotion, type NotionConfig } from '../connectors/notion';
import { NOTION_BUSINESS_VERSION } from '../connectors/notion-business';
import { database, type Database } from './db';
import { AppError } from './errors';
import { invalidateSourceSnapshots } from './source-snapshots';

interface Interval {from:string;to:string;read:number;cursor?:string;depth?:number}
interface Claim {busy:boolean;runId:string;lease?:string;checkpoint?:{intervals:Interval[]};from?:string;to?:string;rowsRead?:number}
/** One short worker invocation. Stable bounds + page staging survive interruption;
 * only the terminal database transaction replaces the published business mirror. */
export async function synchronizeNotionChunk(options:{db?:Database;env?:Record<string,string|undefined>;reader?:(config:NotionConfig)=>ReturnType<typeof syncNotion>;maxPages?:number;fetcher?:typeof fetch}={}) {
 const env=options.env??process.env,db=options.db??database();
 if(env.COCKPIT_MODE==='demo')throw new AppError('La synchronisation réelle est désactivée en démonstration.',409,'demo_mode');
 if(!env.NOTION_TOKEN||!env.NOTION_DATA_SOURCE_ID)throw new AppError('La connexion Notion doit être renseignée.',503,'source_missing');
 if(!env.IDENTITY_HMAC_SECRET||env.IDENTITY_HMAC_SECRET.length<32)throw new AppError('La clé privée de rapprochement des contacts doit être configurée.',503,'identity_key_missing');
 const claim=await db.rpc<Claim>('cockpit_claim_notion',{p_namespace:env.NOTION_DATA_SOURCE_ID,p_profile:NOTION_BUSINESS_VERSION});
 if(claim.busy)return {status:'partial',counts:{read:0,accepted:0,rejected:0,pages:0},coverage:{complete:false,reason:'Une lecture Notion est déjà en cours.'},runId:claim.runId};
 const lease=claim.lease!,intervals=claim.checkpoint!.intervals.map(i=>({...i}));
 let read=0,pages=0;
 try {
  for(;pages<Math.min(options.maxPages??3,5)&&intervals.length;pages++){
   const interval=intervals[0];
   const result=await (options.reader??syncNotion)({token:env.NOTION_TOKEN,dataSourceId:env.NOTION_DATA_SOURCE_ID,fields:BLG_NOTION_FIELDS,mappingVersion:NOTION_BUSINESS_VERSION,identitySecret:env.IDENTITY_HMAC_SECRET,timezone:'Europe/Paris',queryTimestamp:'created_time',from:interval.from,to:interval.to,cursor:interval.cursor,maxPages:1,fetcher:options.fetcher});
   if(result.counts.rejected||result.safeError&&result.safeError!=='PAGE_LIMIT_REACHED'||!result.counts.pages)throw new AppError('La lecture Notion reprendra à la dernière page enregistrée.',502,result.safeError??'notion_page_failed');
   read+=result.counts.read;interval.read+=result.counts.read;
   if(result.checkpoint.cursor)interval.cursor=result.checkpoint.cursor;
   else {
    intervals.shift();
    if(interval.read>=10000){
     const from=Temporal.Instant.from(interval.from),to=Temporal.Instant.from(interval.to),depth=(interval.depth??0)+1;
     if(depth>24||to.epochMilliseconds-from.epochMilliseconds<2000)throw new AppError('Une partition Notion dépasse la capacité de lecture.',422,'notion_partition_saturated');
     const middle=Temporal.Instant.fromEpochMilliseconds(Math.floor((from.epochMilliseconds+to.epochMilliseconds)/2)).toString();
     intervals.unshift({from:interval.from,to:middle,read:0,depth},{from:middle,to:interval.to,read:0,depth});
    }
   }
   await db.rpc('cockpit_stage_notion',{p_run:claim.runId,p_lease:lease,p_records:result.records,p_checkpoint:{intervals},p_read:result.counts.read});
  }
  if(!intervals.length){
   const result=await db.rpc<{status:'complete'|'empty'|'failed';count:number;reason?:string}>('cockpit_publish_notion',{p_run:claim.runId,p_lease:lease});
   invalidateSourceSnapshots(db);
   return {status:result.status,counts:{read:(claim.rowsRead??0)+read,accepted:result.count,rejected:0,pages},coverage:{complete:result.status!=='failed',from:claim.from,to:claim.to,reason:result.reason??'Suivi Notion courant publié. Dates métier connues et dates de création seules séparées.'},runId:claim.runId};
  }
  await db.rpc('cockpit_release_notion',{p_run:claim.runId,p_lease:lease,p_error:null});
  return {status:'partial',counts:{read:(claim.rowsRead??0)+read,accepted:read,rejected:0,pages},coverage:{complete:false,from:claim.from,to:claim.to,reason:'Lecture Notion en cours ; prochaine exécution au checkpoint enregistré. La dernière publication reste affichée.'},runId:claim.runId};
 }catch(error){
  await db.rpc('cockpit_release_notion',{p_run:claim.runId,p_lease:lease,p_error:'NOTION_PAGE_RETRY'}).catch(()=>undefined);
  throw error;
 }
}
