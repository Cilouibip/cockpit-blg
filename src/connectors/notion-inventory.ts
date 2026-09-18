import {ConnectorError,object,readJson,text} from './http';
import {newBatch} from './types';
import type {NotionConfig} from './notion';
export interface NotionInventoryRow {kind:'inventory';source:'notion';accountId:string;externalId:string;sourceUpdatedAt:string;observedAt:string;archived:boolean;clientIds:string[];attendanceGroup:string|null}
/** Hourly membership + dependency projection. No name, email, notes or answers. */
export async function readNotionInventoryPage(config:NotionConfig){
 const batch=newBatch<NotionInventoryRow>('notion',config.dataSourceId??'','notion-inventory-v1',config.from,config.to);
 try{
  if(!config.dataSourceId||!/^[a-fA-F0-9-]{32,36}$/.test(config.dataSourceId)||!config.fields.clients||!config.fields.attendanceGroup)throw new ConnectorError('INVALID_CONFIGURATION');
  const url=new URL(`https://api.notion.com/v1/data_sources/${config.dataSourceId}/query`);
  for(const key of ['clients','attendanceGroup'] as const)url.searchParams.append('filter_properties[]',config.fields[key]!);
  const payload=object(await readJson(url,{method:'POST',headers:{Authorization:`Bearer ${config.token}`,'Notion-Version':'2025-09-03','Content-Type':'application/json'},body:JSON.stringify({page_size:100,...(config.cursor?{start_cursor:config.cursor}:{}),filter:{and:[{timestamp:'created_time',created_time:{on_or_after:config.from}},{timestamp:'created_time',created_time:{before:config.to}}]},sorts:[{timestamp:'created_time',direction:'ascending'}]})},{fetcher:config.fetcher,attempts:1,timeoutMs:15000}));
  if(!Array.isArray(payload.results)||payload.results.length>100||typeof payload.has_more!=='boolean')throw new ConnectorError('INVALID_SOURCE_PAGE');
  for(const raw of payload.results){
   const row=object(raw),props=object(row.properties),get=(key:'clients'|'attendanceGroup')=>object(props[config.fields[key]!]??Object.values(props).find(p=>object(p).id===config.fields[key]));
   const relation=get('clients'),formula=object(get('attendanceGroup').formula);
   if(relation.has_more===true||!Array.isArray(relation.relation))throw new ConnectorError('INCOMPLETE_SOURCE_RELATION');
   const clientIds=relation.relation.map(p=>text(object(p).id));
   if(clientIds.some(id=>!id)||!(typeof formula.string==='string'||formula.string===null)||typeof row.id!=='string'||!/^[a-fA-F0-9-]{32,36}$/.test(row.id)||typeof row.last_edited_time!=='string'||!Number.isFinite(Date.parse(row.last_edited_time)))throw new ConnectorError('INVALID_SOURCE_ROW');
   batch.records.push({kind:'inventory',source:'notion',accountId:config.dataSourceId,externalId:row.id,sourceUpdatedAt:row.last_edited_time,observedAt:config.now?.()??new Date().toISOString(),archived:row.archived===true||row.in_trash===true,clientIds:clientIds as string[],attendanceGroup:formula.string as string|null});
  }
  const next=payload.has_more?text(payload.next_cursor):null;
  if(payload.has_more&&(!next||next===config.cursor||next.length>4096))throw new ConnectorError('INVALID_SOURCE_CURSOR');
  batch.counts={read:batch.records.length,accepted:batch.records.length,rejected:0,pages:1};batch.checkpoint=next?{cursor:next}:{};batch.status=next?'partial':batch.records.length?'complete':'empty';batch.safeError=next?'PAGE_LIMIT_REACHED':undefined;batch.coverage.complete=!next;
 }catch(error){batch.status='failed';batch.safeError=error instanceof ConnectorError?error.code:'INVENTORY_READ_FAILED';}
 return batch;
}
