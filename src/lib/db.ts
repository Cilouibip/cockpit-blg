import { Pool, types } from 'pg';
types.setTypeParser(1082, value=>value);
types.setTypeParser(1184, value=>new Date(value).toISOString());
import { getConfig, type Config } from './config';
import { AppError } from './errors';
export const TABLES = ['tracked_links','link_revisions','people','person_identities','events','lead_registrations','prospects','appointments','commercial_history','deals','payments','ads','ad_daily','meta_conversions_daily','sync_runs','source_mappings','source_aggregates','attribution_runs','attribution_results','v_ad_daily','v_events_canonical','v_meta_conversions_daily','v_attribution_published'] as const;
export type TableName = typeof TABLES[number];
export type Row = Record<string, unknown>;
export type SelectOptions = { order?:string; descending?:boolean; from?:number; limit?:number; eq?:Record<string,string>; };
export interface Database {
  select(table:TableName,options?:SelectOptions):Promise<Row[]>;
  upsert(table:TableName,rows:Row[],conflict?:string):Promise<void>;
  rpc<T=unknown>(name:string,args:Row):Promise<T>;
  probe():Promise<void>;
}
const validIdentifier=(s:string)=>/^[a-z_][a-z0-9_]*$/.test(s);
function checkIdentifier(s:string) { if(!validIdentifier(s)) throw new AppError('Champ interne invalide.',500); return '"'+s+'"'; }
const allowedRPC = new Set(['import_meta_creative_metadata','cockpit_claim_lead_entries','cockpit_stage_lead_entries','cockpit_release_lead_entries','cockpit_publish_lead_entries','cockpit_lead_entry_rollup','cockpit_lead_entry_rollup_v2','cockpit_source_window','begin_sync_stream','cockpit_claim_notion','cockpit_stage_notion','cockpit_release_notion','cockpit_publish_notion','cockpit_business_rollup','save_tracked_link','archive_tracked_link','consume_rate_limit','ingest_browser_event','register_lead','import_notion_page','import_meta_page','begin_sync','finish_sync','publish_attribution','cockpit_dashboard_rollup','cockpit_dashboard_lists','cockpit_prospects_page','cockpit_attribution_snapshot','cockpit_attribution_detail','cockpit_connection_status']);
function dbError(code:unknown):never {
  if(code==='55P03') throw new AppError('Une actualisation de cette source est déjà en cours.',409,'source_busy');
  if(code==='40001') throw new AppError('Le lien a changé. Recharge sa dernière version.',409,'version_conflict');
  if(code==='55000') throw new AppError('L’état de cette opération a changé. Recharge puis réessaie.',409,'state_changed');
  if(code==='P0002') throw new AppError('Élément introuvable.',404,'not_found');
  if(['42P01','42883','PGRST202','PGRST205'].includes(String(code))) throw new AppError('Les tables du cockpit doivent être installées.',503,'schema_missing');
  if(code==='23505') throw new AppError('Cet enregistrement existe déjà.',409,'duplicate');
  if(['23514','23503','22P02'].includes(String(code))) throw new AppError('Les données reçues ne respectent pas le contrat.',422,'invalid_record');
  throw new AppError('La base de données est indisponible.',503,'database_unavailable');
}
export function postgresDatabase(url:string):Database {
  const pool=new Pool({connectionString:url,max:4,connectionTimeoutMillis:5000,idleTimeoutMillis:5000});
  async function query(sql:string,values:unknown[]=[]) { try { return await pool.query(sql,values); } catch(e) { return dbError((e as {code?:string}).code); } }
  return {
    async select(table,options={}) {
      const params:unknown[]=[];
      const where=Object.entries(options.eq||{}).map(([key,value])=>{params.push(value);return `${checkIdentifier(key)}=$${params.length}`;});
      params.push(Math.min(options.limit||1000,1000),options.from||0);
      const order=(options.order||'id').split(',').map(k=>checkIdentifier(k)+(options.descending?' DESC':' ASC')).join(',');
      return (await query(`SELECT * FROM public.${checkIdentifier(table)} ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY ${order} LIMIT $${params.length-1} OFFSET $${params.length}`,params)).rows;
    },
    async upsert(table,rows,conflict='id') {
      if(!rows.length)return;
      // Batch is all-or-nothing. Dynamic identifiers only originate in fixed server mappings.
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        for(const row of rows) {
          const keys=Object.keys(row); const conflicts=conflict.split(','); const mutable=keys.filter(k=>!conflicts.includes(k));
          const sql=`INSERT INTO public.${checkIdentifier(table)} (${keys.map(checkIdentifier).join(',')}) VALUES (${keys.map((_,i)=>'$'+(i+1)).join(',')}) ON CONFLICT (${conflicts.map(checkIdentifier).join(',')}) DO ${mutable.length?'UPDATE SET '+mutable.map(k=>`${checkIdentifier(k)}=excluded.${checkIdentifier(k)}`).join(','):'NOTHING'}`;
          await client.query(sql,Object.values(row).map(v=>v!==null&&typeof v==='object'?JSON.stringify(v):v));
        }
        await client.query('COMMIT');
      } catch(e) { await client.query('ROLLBACK'); dbError((e as {code?:string}).code); } finally {client.release();}
    },
    async rpc<T>(name:string,args:Row) {
      if(!allowedRPC.has(name)) throw new AppError('Opération interne inconnue.',500);
      const keys=Object.keys(args);const values=Object.values(args).map(v=>v!==null&&typeof v==='object'?JSON.stringify(v):v);
      const result=await query(`SELECT public.${checkIdentifier(name)}(${keys.map((key,i)=>`${checkIdentifier(key)} => $${i+1}`).join(',')}) AS result`,values);
      return result.rows[0].result as T;
    },
    async probe(){ await query('SELECT id FROM public.tracked_links LIMIT 1'); }
  };
}
export function supabaseDatabase(config:Config,fetcher:typeof fetch=fetch):Database {
  let url:URL;
  try {url=new URL(config.supabaseUrl);} catch {throw new AppError('Supabase doit être configuré.',503,'database_missing');}
  if(url.protocol!=='https:' || !url.hostname.endsWith('.supabase.co') || url.username || url.password || !config.supabaseSecret) throw new AppError('Configuration Supabase incomplète.',503,'database_missing');
  async function call(path:string,method='GET',body?:unknown,extra:Record<string,string>={}) {
    let response:Response;
    try {response=await fetcher(new URL('/rest/v1/'+path,url),{method,headers:{apikey:config.supabaseSecret,'Content-Type':'application/json',...extra},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000)});} catch {throw new AppError('Supabase ne répond pas.',503,'database_unavailable');}
    if(!response.ok){let code='';try{code=(await response.json()).code;}catch{}dbError(code);}
    const text=await response.text();return text?JSON.parse(text):null;
  }
  return {
    async select(table,o={}){const params=new URLSearchParams({select:'*',order:(o.order||'id').split(',').map(k=>{checkIdentifier(k);return k+(o.descending?'.desc':'.asc');}).join(','),limit:String(Math.min(o.limit||1000,1000)),offset:String(o.from||0)});for(const [k,v] of Object.entries(o.eq||{})){checkIdentifier(k);params.set(k,'eq.'+v);}return call(table+'?'+params);},
    async upsert(table,rows,conflict='id'){if(rows.length)await call(table+'?on_conflict='+encodeURIComponent(conflict),'POST',rows,{Prefer:'resolution=merge-duplicates,return=minimal'});},
    async rpc<T>(name:string,args:Row){if(!allowedRPC.has(name))throw new AppError('Opération interne inconnue.',500);return call('rpc/'+name,'POST',args) as Promise<T>;},
    async probe(){await call('tracked_links?select=id&limit=1');}
  };
}
let instance: Database|undefined;
export function database(){ if(!instance){const c=getConfig(); instance=c.mode==='demo'?postgresDatabase(c.databaseUrl):supabaseDatabase(c);}return instance; }
export async function allRows(db:Database,table:TableName,limit=10000) {
  const rows:Row[]=[];
  for(let from=0;from<limit;from+=1000){const page=await db.select(table,{from,limit:1000});rows.push(...page);if(page.length<1000)return rows;}
  throw new AppError('Cette vue dépasse la capacité de lecture. La couverture est incomplète.',422,'read_limit');
}
