import { object, readJson, ConnectorError } from '../connectors/http';
import { Temporal } from '@js-temporal/polyfill';
import type { ArchivedCommerceClient, CommerceReadCheckpoint, NotionCommerceConfig } from '../connectors/notion-commerce';
import { buildNotionCommerceReport } from './notion-commerce-report';

const sameId=(a:unknown,b:string)=>typeof a==='string'&&a.replace(/-/g,'')===b.replace(/-/g,'');

/** Preserve a missing Client only when a direct, read-only page response proves it is archived.
 * A missing, inaccessible, moved, or active page still blocks publication. */
export async function retainConfirmedArchivedClients(options:{current:CommerceReadCheckpoint;previous?:{runId:string;checkpoint:CommerceReadCheckpoint};config:NotionCommerceConfig;token:string;fetcher?:typeof fetch}):Promise<CommerceReadCheckpoint>{
 const {current,previous,config}=options;
 if(!current.completedAt)throw new ConnectorError('COMMERCE_SOURCE_INCOMPLETE');
 if(!previous)return {...current,retainedArchivedClients:[]};
 if(previous.checkpoint.identityConfigKey!==current.identityConfigKey)throw new ConnectorError('COMMERCE_ARCHIVE_IDENTITY_CHANGED');
 const baseline=new Map<string,{client:ArchivedCommerceClient['client'];runId:string}>();
 for(const proof of previous.checkpoint.retainedArchivedClients??[])baseline.set(proof.client.id,{client:proof.client,runId:proof.sourceCheckpointRunId});
 for(const client of previous.checkpoint.snapshot.clients)baseline.set(client.id,{client,runId:previous.runId});
 const visible=new Set(current.snapshot.clients.map(client=>client.id));
 const missing=[...baseline.values()].filter(({client})=>!visible.has(client.id));
 if(missing.length>10)throw new ConnectorError('COMMERCE_ARCHIVE_CHECK_LIMIT');
 const retainedArchivedClients:ArchivedCommerceClient[]=[];
 for(const {client,runId} of missing){
  if(!/^[a-fA-F0-9-]{32,36}$/.test(client.id))throw new ConnectorError('COMMERCE_ARCHIVE_ID_INVALID');
  const locator='https://api.notion.com/v1/pages/'+client.id;
  const page=object(await readJson(new URL(locator),{headers:{Authorization:'Bearer '+options.token,'Notion-Version':'2025-09-03'}},{fetcher:options.fetcher,attempts:1,timeoutMs:10000}));
  const parent=page.parent&&typeof page.parent==='object'?object(page.parent):{};
  const lastEditedAt=page.last_edited_time;
  if(page.object!=='page'||!sameId(page.id,client.id)||parent.type!=='data_source_id'||!sameId(parent.data_source_id,config.clients.dataSourceId)||page.archived!==true||page.in_trash!==true||typeof lastEditedAt!=='string')throw new ConnectorError('COMMERCE_HISTORICAL_SOURCE_MEMBER_MISSING');
  try{Temporal.Instant.from(lastEditedAt);}catch{throw new ConnectorError('COMMERCE_HISTORICAL_SOURCE_MEMBER_MISSING');}
  retainedArchivedClients.push({client:structuredClone(client),sourceCheckpointRunId:runId,confirmedAt:new Date().toISOString(),archived:true,inTrash:true,lastEditedAt,sourceLocator:locator});
 }
 return {...current,retainedArchivedClients};
}

export function reportFromCheckpoint(checkpoint:CommerceReadCheckpoint){
 if(!checkpoint.completedAt)throw new ConnectorError('COMMERCE_SOURCE_INCOMPLETE');
 const retained=checkpoint.retainedArchivedClients??[];
 const report=buildNotionCommerceReport({...checkpoint.snapshot,clients:[...checkpoint.snapshot.clients,...retained.map(item=>item.client)],observedAt:checkpoint.completedAt,paginationComplete:true});
 if(retained.length)report.coverage.retainedArchivedClients=retained.length;
 return report;
}
