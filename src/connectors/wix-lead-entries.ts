import {createHash,createHmac} from 'node:crypto';
import {Temporal} from '@js-temporal/polyfill';
import {emailIdentity} from '../domain/identity';
import {ConnectorError,object,readJson} from './http';

export const LEAD_ENTRY_VERSION='source-entry-v3';
export type LeadEntryFamily='forms'|'quiz'|'client_history';
export interface LeadEntryObservation {
 source:'wix'|'notion';sourceNamespace:string;family:LeadEntryFamily;externalId:string;containerId:string;
 contactId:string|null;sourceStatus:string|null;occurredAt:string|null;sourceUpdatedAt:string;
 identityKey:string|null;eligible:boolean;properties:Record<string,unknown>;payloadHash:string;sourcePayloadHash:string;
}
export interface WixLeadEntryConfig {
 formNamespace:string;formIds:string[];ignoredFormIds:string[];formEmailField:string;
 quiz?:{collectionId:string;emailField:string;statusField:string;completedStatus:string;originFields:Record<string,string>};
}
export interface EntryPage {records:LeadEntryObservation[];read:number;ignored:number;cursor:string|null;done:boolean}
export function wixLeadEntryConfig(raw:string|undefined):WixLeadEntryConfig|null {
 if(!raw)return null;
 try{
  const c=object(JSON.parse(raw)),forms=Array.isArray(c.formIds)?c.formIds:[],ignored=Array.isArray(c.ignoredFormIds)?c.ignoredFormIds:[];
  if([...forms,...ignored].some(x=>typeof x!=='string'||!x.length)||new Set([...forms,...ignored]).size!==forms.length+ignored.length)throw Error();
  const q=c.quiz===undefined?undefined:object(c.quiz);
  if(q&&(!q.collectionId||typeof q.collectionId!=='string'))throw Error();
  const origins=q?.originFields===undefined?{}:object(q.originFields);
  if(Object.entries(origins).some(([k,v])=>!['source','medium','campaign','ad','pagePath'].includes(k)||typeof v!=='string'))throw Error();
  return {formNamespace:typeof c.formNamespace==='string'?c.formNamespace:'wix.form_app.form',formIds:[...forms as string[]].sort(),ignoredFormIds:[...ignored as string[]].sort(),formEmailField:typeof c.formEmailField==='string'?c.formEmailField:'email',quiz:q?{collectionId:String(q.collectionId),emailField:typeof q.emailField==='string'?q.emailField:'email',statusField:typeof q.statusField==='string'?q.statusField:'status',completedStatus:typeof q.completedStatus==='string'?q.completedStatus:'completed',originFields:origins as Record<string,string>}:undefined};
 }catch{throw new ConnectorError('INVALID_LEAD_ENTRY_CONFIGURATION');}
}
function canonical(value:unknown):string {if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';return JSON.stringify(value);}
export function leadEntryProfile(family:LeadEntryFamily,config:unknown){return `${LEAD_ENTRY_VERSION}-${family}-${createHash('sha256').update(canonical(config)).digest('hex').slice(0,20)}`;}
function value(v:unknown,max=256):string|null {if(v===null||v===undefined||v==='')return null;if(typeof v!=='string'||v.length>max||/[\u0000-\u001f\u007f]/.test(v))throw new ConnectorError('INVALID_SOURCE_FIELD');return v;}
export function entryInstant(v:unknown):string {try{return Temporal.Instant.from(String(v)).toString();}catch{throw new ConnectorError('INVALID_SOURCE_DATE');}}
export function entryIdentity(raw:unknown,secret:string):{key:string|null;basis:string} {
 if(raw===null||raw===undefined||raw==='')return {key:null,basis:'email_missing'};
 if(typeof raw!=='string')return {key:null,basis:'email_invalid'};
 try{return {key:emailIdentity(raw,secret),basis:'email_hmac_v1'};}catch(e){if(e instanceof Error&&e.message==='INVALID_EMAIL')return {key:null,basis:'email_invalid'};throw e;}
}
export function sourceFieldProofs(fields:Record<string,unknown>,secret:string):Record<string,string> {
 return Object.fromEntries(Object.entries(fields).map(([path,raw])=>[path,createHmac('sha256',secret).update('lead-source-field:v1:'+canonical(raw??null)).digest('hex')]));
}
export function withEntryDigest(record:Omit<LeadEntryObservation,'payloadHash'|'sourcePayloadHash'>,sourceMetadata:unknown):LeadEntryObservation {
 const {sourceUpdatedAt,...content}=record;
 const sourceContent={source:record.source,namespace:record.sourceNamespace,family:record.family,id:record.externalId,container:record.containerId,metadata:sourceMetadata};
 return {...record,payloadHash:createHash('sha256').update(canonical(content)).digest('hex'),sourcePayloadHash:createHash('sha256').update(canonical(sourceContent)).digest('hex')};
}
/** Source input exists only in server memory; emitted observations contain no answers or contact coordinates. */
export function normalizeWixLeadEntry(raw:unknown,family:'forms'|'quiz',config:WixLeadEntryConfig,siteId:string,identitySecret:string):LeadEntryObservation|null {
 const r=object(raw);let data:Record<string,unknown>,container:string,id:string,at:string,updated:string,status:string|null,rawEmail:unknown,contactId:string|null=null,eligible:boolean,origin:Record<string,unknown>={};let sourceMetadata:unknown;const consulted:Record<string,unknown>={};
 if(family==='forms'){
  container=value(r.formId)!;
  if(config.ignoredFormIds.includes(container))return null;
  if(!config.formIds.includes(container))throw new ConnectorError('UNCONFIGURED_SOURCE_FORM');
  if(r.namespace!==config.formNamespace)throw new ConnectorError('SOURCE_NAMESPACE_MISMATCH');
  data=object(r.submissions);id=value(r.id)!;at=entryInstant(r.createdDate);updated=entryInstant(r.updatedDate);status=value(r.status);contactId=value(r.contactId);rawEmail=data[config.formEmailField];eligible=status==='CONFIRMED';
  sourceMetadata={namespace:r.namespace,createdDate:r.createdDate,status:r.status,contactId:r.contactId??null};
  consulted[JSON.stringify(['submissions',config.formEmailField])]=rawEmail;
 }else{
  if(!config.quiz)throw new ConnectorError('QUIZ_SOURCE_NOT_CONFIGURED');
  data=object(r.data);container=config.quiz.collectionId;id=value(r.id??data._id)!;
  const dateValue=(v:unknown)=>v&&typeof v==='object'?object(v).$date:v;
  at=entryInstant(dateValue(data._createdDate));updated=entryInstant(dateValue(data._updatedDate));status=value(data[config.quiz.statusField]);rawEmail=data[config.quiz.emailField];eligible=status===config.quiz.completedStatus;
  sourceMetadata={createdDate:dateValue(data._createdDate)};
  for(const field of [config.quiz.emailField,config.quiz.statusField,...Object.values(config.quiz.originFields)])consulted[JSON.stringify(['data',field])]=data[field];
  for(const [name,field]of Object.entries(config.quiz.originFields)){
   const v=value(data[field],name==='pagePath'?2000:256);
   if(name==='pagePath'&&v){try{const u=new URL(v);origin[name]=u.origin+u.pathname;}catch{origin[name]=null;}}else origin[name]=v;
  }
 }
 if(!id||!container)throw new ConnectorError('SOURCE_ID_MISSING');
 const identity=entryIdentity(rawEmail,identitySecret);
 return withEntryDigest({source:'wix',sourceNamespace:siteId,family,externalId:id,containerId:container,contactId,sourceStatus:status,occurredAt:at,sourceUpdatedAt:updated,identityKey:identity.key,eligible,properties:{version:LEAD_ENTRY_VERSION,dateBasis:'submission_created',rawCreatedAt:family==='forms'?r.createdDate:data._createdDate,identityBasis:identity.basis,origin,sourceFields:sourceFieldProofs(consulted,identitySecret),eligibilityBasis:eligible?'explicit_source_completed':'source_status_not_completed'}},sourceMetadata);
}

/** Exactly one bounded page. Docs: Forms filter-and-sort and CMS query-data-items.
 * Increment on source updated date, never contact creation; no Contacts full scan. */
export async function readWixLeadEntryPage(options:{family:'forms'|'quiz';config:WixLeadEntryConfig;siteId:string;apiKey:string;identitySecret:string;from:string;to:string;cursor?:string|null;fetcher?:typeof fetch}):Promise<EntryPage> {
 const {family,config}=options;
 if(!options.apiKey||!options.siteId||options.identitySecret.length<32)throw new ConnectorError('SOURCE_NOT_CONFIGURED');
 const from=entryInstant(options.from),to=entryInstant(options.to);
 if(Temporal.Instant.compare(from,to)>=0)throw new ConnectorError('INVALID_SOURCE_INTERVAL');
 let url:string,body:unknown;
 if(family==='forms'){
  if(!config.formIds.length)throw new ConnectorError('FORMS_SOURCE_NOT_CONFIGURED');
  url='https://www.wixapis.com/forms/v4/submissions/namespace/query';
  body={query:options.cursor?{cursorPaging:{limit:100,cursor:options.cursor}}:{filter:{$and:[{namespace:{$eq:config.formNamespace}},{updatedDate:{$gte:from}},{updatedDate:{$lt:to}}]},sort:[{fieldName:'updatedDate',order:'ASC'},{fieldName:'id',order:'ASC'}],cursorPaging:{limit:100}},onlyYourOwn:false};
 }else{
  if(!config.quiz)throw new ConnectorError('QUIZ_SOURCE_NOT_CONFIGURED');
  const offset=options.cursor?Number(options.cursor):0;if(!Number.isSafeInteger(offset)||offset<0||offset>100000)throw new ConnectorError('INVALID_SOURCE_CURSOR');
  url='https://www.wixapis.com/data/v2/items/query';
  body={dataCollectionId:config.quiz.collectionId,consistentRead:true,returnTotalCount:true,query:{filter:{$and:[{_updatedDate:{$gte:{$date:from}}},{_updatedDate:{$lt:{$date:to}}}]},sort:[{fieldName:'_updatedDate',order:'ASC'},{fieldName:'_id',order:'ASC'}],paging:{limit:100,offset},fields:['_id','_createdDate','_updatedDate',config.quiz.emailField,config.quiz.statusField,...Object.values(config.quiz.originFields)]}};
 }
 const response=object(await readJson(new URL(url),{method:'POST',headers:{Authorization:options.apiKey,'wix-site-id':options.siteId,'Content-Type':'application/json'},body:JSON.stringify(body)},{fetcher:options.fetcher}));
 const rows=response[family==='forms'?'submissions':'dataItems'];if(!Array.isArray(rows)||rows.length>100)throw new ConnectorError('INVALID_SOURCE_PAGE');
 const metadata=object(response[family==='forms'?'metadata':'pagingMetadata']);
 if(typeof metadata.hasNext!=='boolean'||metadata.count!==rows.length)throw new ConnectorError('INVALID_SOURCE_PAGINATION');
 const done=!metadata.hasNext;let cursor:string|null=null;
 if(!done){cursor=family==='forms'?value(object(metadata.cursors).next,16000):String((options.cursor?Number(options.cursor):0)+rows.length);if(!cursor||!rows.length||cursor===options.cursor)throw new ConnectorError('INVALID_SOURCE_CURSOR');}
 const records:LeadEntryObservation[]=[];let ignored=0;
 for(const raw of rows){const observation=normalizeWixLeadEntry(raw,family,config,options.siteId,options.identitySecret);if(observation)records.push(observation);else ignored++;}
 if(new Set(records.map(r=>r.externalId)).size!==records.length)throw new ConnectorError('DUPLICATE_SOURCE_IDS');
 return {records,read:rows.length,ignored,cursor,done};
}
