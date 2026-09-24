import {readNotionInventoryPage} from '../connectors/notion-inventory';
import {readNotionBusinessSchema} from '../connectors/notion-schema';
import { Temporal } from '@js-temporal/polyfill';
import { syncNotion, type NotionConfig } from '../connectors/notion';
import { NOTION_BUSINESS_VERSION } from '../connectors/notion-business';
import { database, type Database } from './db';
import { AppError } from './errors';
import { invalidateSourceSnapshots } from './source-snapshots';

interface Interval {kind?:'delta'|'inventory';from:string;to:string;read:number;cursor?:string;depth?:number}
/** Partition d'inventaire created_time [from, to). `inventoriedAt` (migration 021) : coupure du dernier passage qui l'a relue en entier. */
interface Partition {from:string;to:string;inventoriedAt?:string}
/** Mesures de la tranche d'inventaire d'un passage delta (migration 021), recopiées dans la réponse. */
interface InventoryPlan {partitions:number;pages:number;budget:number;fraction:number;trancheCount:number;tranchePages:number;overdue:number;newPartition:boolean;oldestInventoriedAt?:string;cursor?:string}
interface Claim {busy:boolean;runId:string;lease?:string;checkpoint?:{intervals:Interval[];version?:number;mode?:'full'|'delta';page?:number;inventoryThrough?:string;partitions?:Partition[];tranche?:{from:string;to:string}[];inventoryPlan?:InventoryPlan};from?:string;to?:string;rowsRead?:number}
/** Réglage serveur BLG_NOTION_FULL_HOURS (migration 023) : fenêtre horaire « de-à » (heures entières 0-23, Europe/Paris, de <= à)
 * pendant laquelle la relecture Notion complète quotidienne est autorisée ; hors fenêtre, elle attend (au plus 36 h en tout).
 * Absent ou vide : règle 021 inchangée (relecture complète dès 24 h). Valeur invalide : erreur explicite (l'unité Notion échoue
 * avec ce code, rien n'est réclamé), jamais une valeur par défaut choisie à la place du réglage. */
export function notionFullHours(env:Record<string,string|undefined>=process.env):[number,number]|null {
 const raw=env.BLG_NOTION_FULL_HOURS?.trim();
 if(!raw)return null;
 const match=/^([01]?\d|2[0-3])-([01]?\d|2[0-3])$/.exec(raw);
 if(!match||Number(match[1])>Number(match[2]))throw new AppError('Le réglage BLG_NOTION_FULL_HOURS doit être de la forme « 2-4 » (heures 0-23, Europe/Paris, début <= fin).',503,'notion_full_hours_invalid');
 return [Number(match[1]),Number(match[2])];
}
/** One short worker invocation. Stable bounds + page staging survive interruption;
 * only the terminal database transaction replaces the published business mirror.
 * Delta (migration 021) : l'intervalle des modifications (last_edited_time) puis la seule tranche d'inventaire choisie à la
 * réclamation (created_time). Les partitions non relues arrivent dans `partitions` avec leur inventoriedAt et sont renvoyées
 * telles quelles ; chaque intervalle d'inventaire terminé y est ajouté ; la base date la tranche à la publication. */
export async function synchronizeNotionChunk(options:{db?:Database;env?:Record<string,string|undefined>;reader?:(config:NotionConfig)=>ReturnType<typeof syncNotion>;maxPages?:number;schemaReader?:typeof readNotionBusinessSchema;inventoryReader?:typeof readNotionInventoryPage;fetcher?:typeof fetch}={}) {
 const env=options.env??process.env,db=options.db??database();
 if(env.COCKPIT_MODE==='demo')throw new AppError('La synchronisation réelle est désactivée en démonstration.',409,'demo_mode');
 if(!env.NOTION_TOKEN||!env.NOTION_DATA_SOURCE_ID)throw new AppError('La connexion Notion doit être renseignée.',503,'source_missing');
 if(!env.IDENTITY_HMAC_SECRET||env.IDENTITY_HMAC_SECRET.length<32)throw new AppError('La clé privée de rapprochement des contacts doit être configurée.',503,'identity_key_missing');
 const schema=await (options.schemaReader??readNotionBusinessSchema)({token:env.NOTION_TOKEN,dataSourceId:env.NOTION_DATA_SOURCE_ID,fetcher:options.fetcher});
 // Migration 023 : fenêtre horaire de la relecture complète, transmise avec la preuve de schéma ; absente = règle 021 (24 h).
 const fullHours=notionFullHours(env);
 const claim=await db.rpc<Claim>('cockpit_claim_notion',{p_namespace:env.NOTION_DATA_SOURCE_ID,p_profile:NOTION_BUSINESS_VERSION,p_schema:schema.proof&&fullHours?{...schema.proof,fullHours}:schema.proof});
 if(claim.busy)return {status:'partial',counts:{read:0,accepted:0,rejected:0,pages:0},coverage:{complete:false,reason:'Une lecture Notion est déjà en cours.'},runId:claim.runId};
 const lease=claim.lease!,intervals=claim.checkpoint!.intervals.map(i=>({...i}));
 let read=0,pages=0,pageNumber=claim.checkpoint?.page??0;const partitions:Partition[]=[...(claim.checkpoint?.partitions??[])];
 try {
  for(;pages<Math.min(options.maxPages??3,5)&&intervals.length;pages++){
   const interval=intervals[0];
   const result=await (interval.kind==='inventory'?(options.inventoryReader??readNotionInventoryPage):(options.reader??syncNotion))({token:env.NOTION_TOKEN,dataSourceId:env.NOTION_DATA_SOURCE_ID,fields:schema.fields,mappingVersion:NOTION_BUSINESS_VERSION,identitySecret:env.IDENTITY_HMAC_SECRET,timezone:'Europe/Paris',queryTimestamp:interval.kind==='inventory'?'created_time':claim.checkpoint?.mode==='delta'?'last_edited_time':'created_time',from:interval.from,to:interval.to,cursor:interval.cursor,maxPages:1,fetcher:options.fetcher});
   if(result.counts.rejected||result.safeError&&result.safeError!=='PAGE_LIMIT_REACHED'||!result.counts.pages)throw new AppError('La lecture Notion reprendra à la dernière page enregistrée.',502,result.safeError??'notion_page_failed');
   read+=result.counts.read;interval.read+=result.counts.read;
   if(result.checkpoint.cursor){
    if(result.checkpoint.cursor===interval.cursor)throw new AppError('Curseur Notion répété.',502,'notion_cursor_repeated');
    interval.cursor=result.checkpoint.cursor;
   }
   else {
    intervals.shift();
    if(interval.read<10000&&interval.kind!=='delta')partitions.push({from:interval.from,to:interval.to});
    if(interval.read>=10000){
     const from=Temporal.Instant.from(interval.from),to=Temporal.Instant.from(interval.to),depth=(interval.depth??0)+1;
     if(depth>24||to.epochMilliseconds-from.epochMilliseconds<2000)throw new AppError('Une partition Notion dépasse la capacité de lecture.',422,'notion_partition_saturated');
     const middle=Temporal.Instant.fromEpochMilliseconds(Math.floor((from.epochMilliseconds+to.epochMilliseconds)/2)).toString();
     intervals.unshift({kind:interval.kind,from:interval.from,to:middle,read:0,depth},{kind:interval.kind,from:middle,to:interval.to,read:0,depth});
    }
   }
   await db.rpc('cockpit_stage_notion',{p_run:claim.runId,p_lease:lease,p_records:result.records,p_checkpoint:{intervals,partitions,...(claim.checkpoint?.version===2?{page:++pageNumber}:{})},p_read:result.counts.read});
  }
  if(!intervals.length){
   const result=await db.rpc<{status:'complete'|'empty'|'failed';count:number;reason?:string;changed?:number;mode?:string;inventoryThrough?:string;partitions?:{from:string;to:string}[]}>('cockpit_publish_notion',{p_run:claim.runId,p_lease:lease});
   invalidateSourceSnapshots(db);
   return {status:result.status,counts:{read:(claim.rowsRead??0)+read,accepted:result.count,rejected:0,pages,changed:result.changed},coverage:{complete:result.status!=='failed',mode:result.mode??claim.checkpoint?.mode??'full',inventoryThrough:result.inventoryThrough,inventoryPlan:claim.checkpoint?.inventoryPlan,from:claim.from,to:claim.to,reason:result.reason??(claim.checkpoint?.mode==='delta'?'Modifications Notion publiées ; inventaire relu par tranche (disparitions détectées jusqu’à inventoryThrough, 6 h au plus) et dates métier suivis séparément.':'Lecture Notion complète publiée ; partitions d’inventaire recalculées.')},runId:claim.runId};
  }
  await db.rpc('cockpit_release_notion',{p_run:claim.runId,p_lease:lease,p_error:null});
  return {status:'partial',counts:{read:(claim.rowsRead??0)+read,accepted:read,rejected:0,pages},coverage:{complete:false,from:claim.from,to:claim.to,reason:'Lecture Notion en cours ; prochaine exécution au checkpoint enregistré. La dernière publication reste affichée.'},runId:claim.runId};
 }catch(error){
  const code=error instanceof AppError&&/^[A-Za-z_][A-Za-z0-9_ ()-]{0,99}$/.test(error.code)?error.code:'NOTION_PAGE_RETRY';
  await db.rpc('cockpit_release_notion',{p_run:claim.runId,p_lease:lease,p_error:code}).catch(()=>undefined);
  throw error;
 }
}
