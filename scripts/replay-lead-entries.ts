/**
 * Relecture des inscriptions Wix (formulaires masterclass, quiz) et de l'antériorité Client (Notion) vers la base du cockpit.
 * Deux modes, jamais de secret imprimé, cible Supabase vérifiée avant toute écriture :
 *
 *   --mode server      la clé serveur Wix / le jeton Notion lisent la source page par page (droits Forms + CMS + Contacts requis).
 *   --mode pages --pages DIR   import SUPERVISÉ : DIR contient les pages brutes exportées par un agent (MCP Wix) au format JSON de l'API
 *                      (forms : {submissions:[...]} ; quiz : {dataItems:[...]}), une page par fichier, triées par nom.
 *   --dry-run          normalise et compte seulement ; aucune écriture.
 *
 * Rejeu de l'historique (règle 009) : la première lecture après un changement de mapping doit repartir du début de l'historique.
 * Passer --from 1970-01-01T00:00:00Z (mode server) ou fournir TOUTES les pages (mode pages) ; sinon la publication est refusée
 * avec MAPPING_REPLAY_INCOMPLETE et la dernière publication reste en place (aucune perte).
 *
 * Exemples :
 *   node --import tsx scripts/replay-lead-entries.ts --family forms --mode pages --pages ../../snapshots/wix/forms-2026-09-17 --dry-run
 *   node --import tsx scripts/replay-lead-entries.ts --family quiz  --mode server --from 1970-01-01T00:00:00Z
 */
import {readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {loadEnvFile} from 'node:process';
import {setDefaultResultOrder} from 'node:dns';
import {getConfig} from '../src/lib/config';
import {database} from '../src/lib/db';
import {synchronizeLeadEntries,type LeadPageReader} from '../src/lib/sync-lead-entries';
import {runSupervisedLeadImport} from '../src/lib/supervised-lead-import';
import {normalizeWixLeadEntry,wixLeadEntryConfig,type EntryPage,type LeadEntryFamily} from '../src/connectors/wix-lead-entries';

setDefaultResultOrder('ipv4first');
const TARGET='https://awzjxtxtfdlgqiuitqqc.supabase.co';
const args=process.argv.slice(2);
const option=(name:string)=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined;};
const family=option('--family') as LeadEntryFamily|undefined,mode=option('--mode')??'pages',dir=option('--pages'),dryRun=args.includes('--dry-run'),from=option('--from');
const rootEnv=option('--env')??'../../../.env.cockpit-blg.local';
if(!family||!['forms','quiz','client_history'].includes(family))throw new Error('USAGE: --family forms|quiz|client_history --mode server|pages [--pages DIR] [--dry-run] [--from ISO]');
if(mode==='pages'&&family==='client_history')throw new Error('client_history se relit en mode server (jeton Notion) uniquement.');

try{loadEnvFile('.env.local');}catch{/* variables déjà présentes */}
try{loadEnvFile(rootEnv);}catch{/* variables déjà présentes */}
process.env.COCKPIT_MODE='live';
const config=getConfig();
if(config.supabaseUrl!==TARGET)throw new Error('TARGET_MISMATCH : seule la base existante du cockpit est autorisée.');
const secret=process.env.IDENTITY_HMAC_SECRET??'';if(secret.length<32)throw new Error('IDENTITY_HMAC_SECRET manquante : les identités ne peuvent pas être rapprochées.');
const siteId=process.env.WIX_SITE_ID??'';const wix=wixLeadEntryConfig(process.env.WIX_LEAD_ENTRY_CONFIG);
const summary=(label:string,value:unknown)=>console.log(JSON.stringify({[label]:value}));

async function pagesReader(directory:string):Promise<{reader:LeadPageReader;files:string[]}>{
 if(!wix||!siteId)throw new Error('WIX_LEAD_ENTRY_CONFIG ou WIX_SITE_ID manquante.');
 const files=(await readdir(directory)).filter(f=>f.endsWith('.json')).sort();
 if(!files.length)throw new Error('Aucune page JSON dans '+directory);
 const reader:LeadPageReader=async({family:fam,cursor})=>{
  if(fam!=='forms'&&fam!=='quiz')throw new Error('Famille non supervisable : '+fam);
  const index=cursor?Number(cursor):0;
  const raw=JSON.parse(await readFile(join(directory,files[index]),'utf8')) as Record<string,unknown>;
  const rows=(raw[fam==='forms'?'submissions':'dataItems']??raw.items??[]) as unknown[];
  if(!Array.isArray(rows)||rows.length>100)throw new Error(`Page ${files[index]} invalide : tableau attendu, 100 lignes maximum.`);
  const records:EntryPage['records']=[];let ignored=0;
  for(const row of rows){const observation=normalizeWixLeadEntry(row,fam,wix,siteId,secret);if(observation)records.push(observation);else ignored++;}
  if(new Set(records.map(r=>r.externalId)).size!==records.length)throw new Error(`Page ${files[index]} : identifiants source en double.`);
  const done=index>=files.length-1;
  return {records,read:rows.length,ignored,cursor:done?null:String(index+1),done};
 };
 return {reader,files};
}

if(mode==='pages'){
 if(!dir)throw new Error('--mode pages exige --pages DIR (dossier de pages JSON).');
 const {reader,files}=await pagesReader(dir);
 summary('pages',files.length);
 if(dryRun){
  let read=0,records=0,ignored=0,withFirst=0,withVisitor=0,eligible=0;
  for(let i=0;i<files.length;i++){const page=await reader({family,from:'',to:'',cursor:i?String(i):null});read+=page.read;records+=page.records.length;ignored+=page.ignored;for(const r of page.records){if(r.eligible)eligible++;if(r.properties.firstTouch)withFirst++;if((r.properties.origin as Record<string,unknown>)?.visitor)withVisitor++;}}
  summary('dry_run',{read,records,ignored,eligible,withFirstTouch:withFirst,withVisitor});
 }else{
  const outcome=await runSupervisedLeadImport({db:database(),env:process.env as Record<string,string|undefined>,readers:{[family]:reader},families:[family],authorization:'reviewed-supervised-import'});
  summary('import',outcome);
 }
}else{
 if(dryRun)throw new Error('--dry-run ne s’applique qu’au mode pages.');
 const db=database();let result;let rounds=0;
 do{result=await synchronizeLeadEntries(family,{db,env:process.env as Record<string,string|undefined>,maxPages:5,...(rounds===0&&from?{from}:{})});rounds++;summary('round',{rounds,status:result.status,counts:result.counts,coverage:result.coverage});}
 while(result.status==='partial'&&rounds<250);
 if(result.status!=='complete'&&result.status!=='empty')process.exitCode=2;
}
