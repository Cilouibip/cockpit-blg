import {createHash,createHmac} from 'node:crypto';
import {Temporal} from '@js-temporal/polyfill';
import {object,readJson,ConnectorError} from './http';
import {entryIdentity} from './wix-lead-entries';
import {NOTION_COMMERCE_VERSION,type CommerceClient,type CommercePayment,type CommerceParcours,type CommerceSnapshot} from '../lib/notion-commerce-report';
type Family='clients'|'payments'|'parcours';
const defaults={clients:{email:'E-mail',emailBis:'E-mail (BIS)',started:'Démarrage',prospect:'Prospect',binome:'Binôme'},payments:{client:'Client',email:'E-mail',date:'Date',amount:'Montant',status:'Status',provider:'Transaction',invoice:'Invoice Id'},parcours:{client:'Client',order:'Ordre',format:'Format',start:'Début',closing:'Date de closing',status:'Statut'}};
export interface NotionCommerceConfig {clients:{dataSourceId:string;fields:typeof defaults.clients};payments:{dataSourceId:string;fields:typeof defaults.payments};parcours:{dataSourceId:string;fields:typeof defaults.parcours}}
export function notionCommerceConfig(raw:string|undefined):NotionCommerceConfig|null{
 if(!raw)return null;try{const c=object(JSON.parse(raw)),result:Record<string,unknown>={};for(const family of ['clients','payments','parcours'] as const){const s=object(c[family]);if(typeof s.dataSourceId!=='string'||!s.dataSourceId)throw Error();const fields={...defaults[family],...(s.fields?object(s.fields):{})};if(Object.keys(fields).some(k=>!(k in defaults[family]))||Object.values(fields).some(v=>typeof v!=='string'||!v))throw Error();result[family]={dataSourceId:s.dataSourceId,fields};}return result as unknown as NotionCommerceConfig;}catch{throw new ConnectorError('INVALID_COMMERCE_CONFIGURATION');}
}
export function notionCommerceProfile(config:NotionCommerceConfig){return NOTION_COMMERCE_VERSION+'-'+createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0,20);}
function prop(p:Record<string,unknown>,name:string){return p[name]?object(p[name]):{};}
function relations(p:Record<string,unknown>,name:string):string[]{const r=prop(p,name);if(r.has_more)throw new ConnectorError('TRUNCATED_SOURCE_RELATION');if(!Array.isArray(r.relation))return [];const ids=r.relation.map(x=>object(x).id);if(ids.some(x=>typeof x!=='string'))throw new ConnectorError('INVALID_SOURCE_RELATION');return [...ids as string[]].sort();}
function rawDate(p:Record<string,unknown>,name:string):string|null {const date=prop(p,name).date;if(!date)return null;const start=object(date).start;return typeof start==='string'?start:null;}
function day(raw:string|null):string|null{if(!raw)return null;try{return raw.length===10?Temporal.PlainDate.from(raw).toString():Temporal.Instant.from(raw).toZonedDateTimeISO('Europe/Paris').toPlainDate().toString();}catch{return null;}}
function selected(p:Record<string,unknown>,name:string){const r=prop(p,name),v=r.select??r.status;return v?String(object(v).name):null;}
function text(p:Record<string,unknown>,name:string){const r=prop(p,name),v=r.title??r.rich_text;return Array.isArray(v)?v.map(x=>String(object(x).plain_text??'')).join(''):'';}
/** Only fields necessary for the declared commercial report are retained. */
export function normalizeNotionCommerce(raw:unknown,family:Family,config:NotionCommerceConfig,secret:string):CommerceClient|CommercePayment|CommerceParcours{
 const r=object(raw),p=object(r.properties);if(typeof r.id!=='string')throw new ConnectorError('SOURCE_ID_MISSING');
 if(family==='clients'){const f=config.clients.fields;return {id:r.id,emailKey:entryIdentity(prop(p,f.email).email,secret).key,emailBisKey:entryIdentity(prop(p,f.emailBis).email,secret).key,startedDay:day(rawDate(p,f.started)),prospectIds:relations(p,f.prospect),binomeIds:relations(p,f.binome)};}
 if(family==='payments'){const f=config.payments.fields,date=rawDate(p,f.date),amount=prop(p,f.amount).number,provider=text(p,f.provider),invoice=text(p,f.invoice),reference=[provider,invoice].find(v=>/^(pi|ch)_[A-Za-z0-9]+$/.test(v));return {id:r.id,clientIds:relations(p,f.client),emailKey:entryIdentity(prop(p,f.email).email,secret).key,providerId:reference??null,day:day(date),rawDate:date,amountMinor:typeof amount==='number'&&Number.isFinite(amount)&&Math.abs(amount*100-Math.round(amount*100))<0.000001?Math.round(amount*100):null,status:selected(p,f.status)??'unknown'};}
 const f=config.parcours.fields,start=rawDate(p,f.start),closing=rawDate(p,f.closing),order=prop(p,f.order).number;return {id:r.id,clientIds:relations(p,f.client),order:typeof order==='number'&&Number.isInteger(order)?order:null,format:selected(p,f.format),startDay:day(start),closingDay:day(closing),rawStart:start,rawClosing:closing,status:selected(p,f.status)};
}
export interface CommerceReadCheckpoint {version:1;profile:string;identityConfigKey:string;startedAt:string;familyIndex:number;cursor:string|null;pages:number;completedAt?:string;snapshot:Omit<CommerceSnapshot,'observedAt'|'paginationComplete'>}
/** Supervised initial reader. Checkpoints contain minimized source facts, never full pages or raw contact details. */
export async function readNotionCommerceSnapshot(options:{config:NotionCommerceConfig;token:string;identitySecret:string;checkpoint?:CommerceReadCheckpoint;onCheckpoint?:(checkpoint:CommerceReadCheckpoint)=>Promise<void>;fetcher?:typeof fetch;maxPages?:number}):Promise<{complete:boolean;checkpoint:CommerceReadCheckpoint;snapshot:CommerceSnapshot|null}>{
 if(!options.token||options.identitySecret.length<32)throw new ConnectorError('SOURCE_NOT_CONFIGURED');
 const profile=notionCommerceProfile(options.config),identityConfigKey=createHmac('sha256',options.identitySecret).update('commerce-checkpoint-identity-v1').digest('hex');
 const start=new Date().toISOString();const checkpoint:CommerceReadCheckpoint=options.checkpoint?structuredClone(options.checkpoint):{version:1,profile,identityConfigKey,startedAt:start,familyIndex:0,cursor:null,pages:0,snapshot:{clients:[],payments:[],parcours:[],startedAt:start,sourceCounts:{}}};
 if(checkpoint.version!==1||checkpoint.profile!==profile||checkpoint.identityConfigKey!==identityConfigKey||checkpoint.familyIndex<0||checkpoint.familyIndex>3)throw new ConnectorError('INVALID_SOURCE_CHECKPOINT');
 const headers={Authorization:'Bearer '+options.token,'Notion-Version':'2025-09-03','Content-Type':'application/json'},families=['clients','payments','parcours'] as const;let budget=options.maxPages??6;
 while(checkpoint.familyIndex<families.length&&budget>0){
  const family=families[checkpoint.familyIndex],config=options.config[family],schema=object(await readJson(new URL('https://api.notion.com/v1/data_sources/'+config.dataSourceId),{headers},{fetcher:options.fetcher})),props=object(schema.properties),fields=Object.values(config.fields);if(fields.some(f=>!props[f]))throw new ConnectorError('SOURCE_SCHEMA_CHANGED');
  const url=new URL('https://api.notion.com/v1/data_sources/'+config.dataSourceId+'/query');for(const field of fields)url.searchParams.append('filter_properties[]',String(object(props[field]).id));
  const body={page_size:100,sorts:[{timestamp:'created_time',direction:'ascending'}],...(checkpoint.cursor?{start_cursor:checkpoint.cursor}:{})};
  const response=object(await readJson(url,{method:'POST',headers,body:JSON.stringify(body)},{fetcher:options.fetcher}));
  if(!Array.isArray(response.results)||response.results.length>100||typeof response.has_more!=='boolean')throw new ConnectorError('INVALID_SOURCE_PAGE');
  const rows=response.results.map(r=>normalizeNotionCommerce(r,family,options.config,options.identitySecret)),existing=checkpoint.snapshot[family] as {id:string}[];if(new Set([...existing,...rows].map(r=>r.id)).size!==existing.length+rows.length)throw new ConnectorError('DUPLICATE_SOURCE_ROWS');
  if(existing.length+rows.length>=10000)throw new ConnectorError('SOURCE_PARTITION_SATURATED');
  (existing as unknown[]).push(...rows);checkpoint.snapshot.sourceCounts[family]=existing.length;checkpoint.pages++;budget--;
  if(response.has_more){if(typeof response.next_cursor!=='string'||!response.next_cursor||response.next_cursor===checkpoint.cursor)throw new ConnectorError('INVALID_SOURCE_CURSOR');checkpoint.cursor=response.next_cursor;}else{checkpoint.familyIndex++;checkpoint.cursor=null;}
  if(checkpoint.familyIndex===families.length)checkpoint.completedAt=new Date().toISOString();
  await options.onCheckpoint?.(structuredClone(checkpoint));
 }
 return {complete:checkpoint.familyIndex===families.length,checkpoint,snapshot:checkpoint.familyIndex===families.length?{...checkpoint.snapshot,observedAt:checkpoint.completedAt??checkpoint.startedAt,paginationComplete:true}:null};
}
