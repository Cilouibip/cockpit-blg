import {database,type Database} from './db';
import {AppError} from './errors';
import {readWixLeadEntryPage,wixLeadEntryConfig,leadEntryProfile,type EntryPage,type LeadEntryFamily} from '../connectors/wix-lead-entries';
import {notionClientHistoryConfig,readNotionClientHistoryPage} from '../connectors/notion-client-history';
import {safeConnectorError} from '../connectors/http';
interface Checkpoint {version:1;from:string;to:string;cursor:string|null;page:number;done:boolean}
interface Claim {busy:boolean;blocked?:boolean;reason?:string;runId:string;lease:string;checkpoint:Checkpoint;rowsRead:number}
interface Result {status:'complete'|'empty'|'failed';counts:{read:number;observations:number;changed:number;unchanged:number;stale:number;rejected:number;ignored:number};reason?:string}
export type LeadPageReader=(args:{family:LeadEntryFamily;from:string;to:string;cursor:string|null})=>Promise<EntryPage>;
/** Bounded worker; source reads never happen inside dashboard GET requests. */
export async function synchronizeLeadEntries(family:LeadEntryFamily,options:{db?:Database;env?:Record<string,string|undefined>;reader?:LeadPageReader;maxPages?:number;from?:string}={}) {
 const env=options.env??process.env,db=options.db??database();
 if(env.COCKPIT_MODE==='demo')throw new AppError('La synchronisation réelle est désactivée en démonstration.',409,'demo_mode');
 const secret=env.IDENTITY_HMAC_SECRET;if(!secret||secret.length<32)throw new AppError('La clé privée de rapprochement doit être configurée.',503,'identity_key_missing');
 const wix=wixLeadEntryConfig(env.WIX_LEAD_ENTRY_CONFIG),client=notionClientHistoryConfig(env);
 const namespace=family==='client_history'?client?.dataSourceId:env.WIX_SITE_ID;
 // A reviewed supervised backfill supplies its source pages in memory. It never
 // borrows the server credential merely to satisfy a configuration check.
 const needsSourceCredential=!options.reader;
 if(!namespace||(family==='client_history'?(!client||(needsSourceCredential&&!env.NOTION_TOKEN)):(!wix||(needsSourceCredential&&!env.WIX_API_KEY)||family==='forms'&&!wix.formIds.length||family==='quiz'&&!wix.quiz)))throw new AppError('Cette famille d’inscriptions n’est pas configurée.',503,'source_missing');
 const profile=leadEntryProfile(family,family==='client_history'?client:wix);
 const containers=family==='client_history'?[client!.dataSourceId]:family==='forms'?wix!.formIds:[wix!.quiz!.collectionId];
 const claim=await db.rpc<Claim>('cockpit_claim_lead_entries',{p_namespace:namespace,p_family:family,p_profile:profile,p_from:options.from??null,p_container_ids:containers});
 if(claim.blocked)return {status:'failed',runId:claim.runId,reason:claim.reason,counts:{read:0,pages:0},coverage:{complete:false,reason:'Le nouveau mapping ne permet pas de reconstituer une ancienne inscription conservée. La dernière publication reste disponible ; une reprise ciblée doit être revue.'}};
 if(claim.busy)return {status:'partial',runId:claim.runId,counts:{read:0,pages:0},coverage:{complete:false,reason:'Une lecture de cette source est déjà en cours.'}};
 const checkpoint={...claim.checkpoint};let pages=0,read=claim.rowsRead;
 const reader:LeadPageReader=options.reader??(args=>args.family==='client_history'?readNotionClientHistoryPage({config:client!,token:env.NOTION_TOKEN!,identitySecret:secret,from:args.from,to:args.to,cursor:args.cursor}):readWixLeadEntryPage({family:args.family,config:wix!,siteId:namespace,apiKey:env.WIX_API_KEY!,identitySecret:secret,from:args.from,to:args.to,cursor:args.cursor}));
 try{
  while(!checkpoint.done&&pages<Math.min(options.maxPages??3,5)){
   const page=await reader({family,from:checkpoint.from,to:checkpoint.to,cursor:checkpoint.cursor});
   if(page.read!==page.records.length+page.ignored||page.read>100||page.read<0||page.ignored<0||page.done===false&&!page.cursor)throw new AppError('La page source est incomplète.',502,'source_page_invalid');
   const result=await db.rpc<{read:number}>('cockpit_stage_lead_entries',{p_run:claim.runId,p_lease:claim.lease,p_page:checkpoint.page,p_records:page.records,p_next_cursor:page.cursor,p_done:page.done,p_read:page.read,p_ignored:page.ignored});
   read=result.read;checkpoint.cursor=page.cursor;checkpoint.done=page.done;checkpoint.page++;pages++;
  }
  if(checkpoint.done){
   if(family==='client_history'&&read>=10000)throw new AppError('Cette source nécessite une partition plus petite avant publication.',422,'source_partition_saturated');
   const result=await db.rpc<Result>('cockpit_publish_lead_entries',{p_run:claim.runId,p_lease:claim.lease});
   return {...result,counts:{...result.counts,pages},runId:claim.runId,coverage:{complete:result.status!=='failed',from:checkpoint.from,to:checkpoint.to,reason:result.reason??'Dernières observations publiées. La couverture historique et les identités non rapprochées restent précisées séparément.'}};
  }
  await db.rpc('cockpit_release_lead_entries',{p_run:claim.runId,p_lease:claim.lease,p_error:null});
  return {status:'partial',runId:claim.runId,counts:{read,pages},coverage:{complete:false,from:checkpoint.from,to:checkpoint.to,reason:'Lecture en cours ; reprise à la page enregistrée. La dernière publication reste affichée.'}};
 }catch(error){
  const code=safeConnectorError(error).replace(/[^A-Za-z0-9_ -]/g,'').slice(0,100);
  await db.rpc('cockpit_release_lead_entries',{p_run:claim.runId,p_lease:claim.lease,p_error:code}).catch(()=>undefined);
  throw error;
 }
}
