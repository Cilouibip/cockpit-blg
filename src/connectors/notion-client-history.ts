import {Temporal} from '@js-temporal/polyfill';
import {ConnectorError,object,readJson} from './http';
import {entryIdentity,entryInstant,withEntryDigest,sourceFieldProofs,type EntryPage,type LeadEntryObservation} from './wix-lead-entries';
export interface NotionClientHistoryConfig {dataSourceId:string;prospectNamespace:string;emailField:string;emailBisField:string;startedField:string;prospectField:string}
export function notionClientHistoryConfig(env:Record<string,string|undefined>):NotionClientHistoryConfig|null {
 if(!env.NOTION_CLIENT_DATA_SOURCE_ID||!env.NOTION_DATA_SOURCE_ID)return null;
 return {dataSourceId:env.NOTION_CLIENT_DATA_SOURCE_ID,prospectNamespace:env.NOTION_DATA_SOURCE_ID,emailField:'E-mail',emailBisField:'E-mail (BIS)',startedField:'Démarrage',prospectField:'Prospect'};
}
/** Client start is a bound on prior existence, never an inferred acquisition date. */
export function normalizeNotionClientHistory(raw:unknown,config:NotionClientHistoryConfig,secret:string):LeadEntryObservation {
 const r=object(raw),p=object(r.properties);const prop=(name:string)=>p[name]?object(p[name]):{};
 const primary=prop(config.emailField).email,bis=prop(config.emailBisField).email;
 const identity=entryIdentity(primary||bis,secret);
 const rawStarted=prop(config.startedField).date;
 const started=rawStarted?object(rawStarted).start:null;
 let occurredAt:string|null=null;
 if(typeof started==='string')try{occurredAt=started.length===10?Temporal.PlainDate.from(started).toZonedDateTime('Europe/Paris').toInstant().toString():entryInstant(started);}catch{throw new ConnectorError('INVALID_SOURCE_DATE');}
 const relation=prop(config.prospectField);
 if(relation.has_more)throw new ConnectorError('TRUNCATED_SOURCE_RELATION');
 const ids=Array.isArray(relation.relation)?relation.relation.map(x=>object(x).id).sort():[];
 if(ids.some(x=>typeof x!=='string'))throw new ConnectorError('INVALID_SOURCE_RELATION');
 if(typeof r.id!=='string')throw new ConnectorError('SOURCE_ID_MISSING');
 const consulted=Object.fromEntries([config.emailField,config.emailBisField,config.startedField,config.prospectField].map(name=>[JSON.stringify(['properties',name]),prop(name)]));
 return withEntryDigest({source:'notion',sourceNamespace:config.dataSourceId,family:'client_history',externalId:r.id,containerId:config.dataSourceId,contactId:null,sourceStatus:r.archived?'archived':'current',occurredAt,sourceUpdatedAt:entryInstant(r.last_edited_time),identityKey:identity.key,eligible:occurredAt!==null,properties:{dateBasis:'client_program_started_bound',rawStartedAt:started??null,identityBasis:identity.basis,prospectIds:ids,prospectNamespace:config.prospectNamespace,sourceArchived:r.archived===true,sourceFields:sourceFieldProofs(consulted,secret)}},{archived:r.archived===true});
}
export async function readNotionClientHistoryPage(options:{config:NotionClientHistoryConfig;token:string;identitySecret:string;from:string;to:string;cursor?:string|null;fetcher?:typeof fetch}):Promise<EntryPage> {
 const {config}=options;const headers={Authorization:'Bearer '+options.token,'Notion-Version':'2025-09-03','Content-Type':'application/json'};
 // Metadata only; property IDs avoid fetching complete client pages or health fields.
 const schema=object(await readJson(new URL('https://api.notion.com/v1/data_sources/'+config.dataSourceId),{headers},{fetcher:options.fetcher}));
 const props=object(schema.properties),fields=[config.emailField,config.emailBisField,config.startedField,config.prospectField];
 if(fields.some(k=>!props[k]))throw new ConnectorError('SOURCE_SCHEMA_CHANGED');
 const url=new URL('https://api.notion.com/v1/data_sources/'+config.dataSourceId+'/query');for(const name of fields)url.searchParams.append('filter_properties[]',String(object(props[name]).id));
 const body={page_size:100,filter:{and:[{timestamp:'last_edited_time',last_edited_time:{on_or_after:options.from}},{timestamp:'last_edited_time',last_edited_time:{before:options.to}}]},sorts:[{timestamp:'last_edited_time',direction:'ascending'}],...(options.cursor?{start_cursor:options.cursor}:{})};
 const response=object(await readJson(url,{method:'POST',headers,body:JSON.stringify(body)},{fetcher:options.fetcher}));
 if(!Array.isArray(response.results)||response.results.length>100||typeof response.has_more!=='boolean')throw new ConnectorError('INVALID_SOURCE_PAGE');
 const done=!response.has_more,cursor=done?null:response.next_cursor;
 if(!done&&(typeof cursor!=='string'||!cursor||cursor===options.cursor))throw new ConnectorError('INVALID_SOURCE_CURSOR');
 const records=response.results.map(x=>normalizeNotionClientHistory(x,config,options.identitySecret));
 return {records,read:records.length,ignored:0,cursor:cursor as string|null,done};
}
