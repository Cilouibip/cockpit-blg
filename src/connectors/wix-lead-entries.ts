import {createHash,createHmac} from 'node:crypto';
import {Temporal} from '@js-temporal/polyfill';
import {emailIdentity} from '../domain/identity';
import {ConnectorError,object,readJson} from './http';

export const LEAD_ENTRY_VERSION='source-entry-v4';
/** Clés d'origine acceptées. `origin` = arrivée de l'inscription (B si retour par une autre pub), `firstTouch` = première origine mesurable A conservée par le navigateur. */
export const ORIGIN_KEYS=['source','medium','campaign','ad','adset','linkId','pagePath','visitor','session'] as const;
export const FIRST_TOUCH_KEYS=['source','medium','campaign','ad','adset','linkId','page','at','tunnel'] as const;
const PAGE_PARAMS:Record<string,string>={utm_source:'source',utm_medium:'medium',utm_campaign:'campaign',utm_content:'ad',utm_term:'adset',blg_link_id:'linkId'};
const CONTEXT_JSON_KEYS:Record<string,string>={...PAGE_PARAMS,link_id:'linkId',ad_id:'ad',adset_id:'adset',campaign_id:'campaign',at:'at',page:'page',tunnel:'tunnel'};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type LeadEntryFamily='forms'|'quiz'|'client_history';
export interface LeadEntryObservation {
 source:'wix'|'notion';sourceNamespace:string;family:LeadEntryFamily;externalId:string;containerId:string;
 contactId:string|null;sourceStatus:string|null;occurredAt:string|null;sourceUpdatedAt:string;
 identityKey:string|null;eligible:boolean;properties:Record<string,unknown>;payloadHash:string;sourcePayloadHash:string;
}
export interface WixLeadEntryConfig {
 formNamespace:string;formIds:string[];ignoredFormIds:string[];formEmailField:string;
 /** Champs cachés du formulaire masterclass : visitor (UUID), first (JSON première origine A), current (JSON arrivée), session. Absents = inscription sans origine, jamais une erreur. */
 formOriginFields?:{visitor?:string;first?:string;current?:string;session?:string};
 quiz?:{collectionId:string;emailField:string;statusField:string;completedStatus:string;originFields:Record<string,string>;firstTouchFields?:Record<string,string>};
}
export interface EntryPage {records:LeadEntryObservation[];read:number;ignored:number;cursor:string|null;done:boolean}
export function wixLeadEntryConfig(raw:string|undefined):WixLeadEntryConfig|null {
 if(!raw)return null;
 try{
  const c=object(JSON.parse(raw)),forms=Array.isArray(c.formIds)?c.formIds:[],ignored=Array.isArray(c.ignoredFormIds)?c.ignoredFormIds:[];
  if([...forms,...ignored].some(x=>typeof x!=='string'||!x.length)||new Set([...forms,...ignored]).size!==forms.length+ignored.length)throw Error();
  const q=c.quiz===undefined?undefined:object(c.quiz);
  if(q&&(!q.collectionId||typeof q.collectionId!=='string'))throw Error();
  const origins=q?.originFields===undefined?{}:object(q.originFields),firstTouch=q?.firstTouchFields===undefined?{}:object(q.firstTouchFields);
  if(Object.entries(origins).some(([k,v])=>!(ORIGIN_KEYS as readonly string[]).includes(k)||typeof v!=='string'||!v))throw Error();
  if(Object.entries(firstTouch).some(([k,v])=>!(FIRST_TOUCH_KEYS as readonly string[]).includes(k)||typeof v!=='string'||!v))throw Error();
  const formOrigin=c.formOriginFields===undefined?{}:object(c.formOriginFields);
  if(Object.entries(formOrigin).some(([k,v])=>!['visitor','first','current','session'].includes(k)||typeof v!=='string'||!v))throw Error();
  return {formNamespace:typeof c.formNamespace==='string'?c.formNamespace:'wix.form_app.form',formIds:[...forms as string[]].sort(),ignoredFormIds:[...ignored as string[]].sort(),formEmailField:typeof c.formEmailField==='string'?c.formEmailField:'email',formOriginFields:formOrigin as WixLeadEntryConfig['formOriginFields'],quiz:q?{collectionId:String(q.collectionId),emailField:typeof q.emailField==='string'?q.emailField:'email',statusField:typeof q.statusField==='string'?q.statusField:'status',completedStatus:typeof q.completedStatus==='string'?q.completedStatus:'completed',originFields:origins as Record<string,string>,firstTouchFields:firstTouch as Record<string,string>}:undefined};
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
/** Paramètres de campagne lus dans une URL d'arrivée : seuls les noms connus sont conservés, jamais une valeur personnelle passée dans l'adresse. */
export function pageParamsOrigin(url:string|null):Record<string,string|boolean> {
 if(!url)return {};
 let parsed:URL;try{parsed=new URL(url);}catch{return {};}
 const out:Record<string,string|boolean>={};
 for(const [param,key] of Object.entries(PAGE_PARAMS)){const v=parsed.searchParams.get(param);if(v&&v.length<=180&&!/[\u0000-\u001f\u007f]/.test(v))out[key]=key==='linkId'?(UUID.test(v)?v.toLowerCase():''):v;}
 if(out.linkId==='')delete out.linkId;
 if(parsed.searchParams.has('fbclid'))out.fbclid=true;
 return out;
}
/** JSON d'origine écrit par les pages (blg_origine / blg_arrivee) : clés connues seulement, valeurs bornées. */
export function contextJsonOrigin(raw:unknown):Record<string,string>|null {
 if(typeof raw!=='string'||!raw||raw.length>2000)return null;
 let parsed:unknown;try{parsed=JSON.parse(raw);}catch{return null;}
 if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return null;
 const out:Record<string,string>={};
 for(const [key,name] of Object.entries(CONTEXT_JSON_KEYS)){const v=(parsed as Record<string,unknown>)[key];if(typeof v==='string'&&v&&v.length<=200&&!/[\u0000-\u001f\u007f]/.test(v)&&out[name]===undefined)out[name]=name==='linkId'?v.toLowerCase():v;}
 if(out.linkId&&!UUID.test(out.linkId))delete out.linkId;
 return Object.keys(out).length?out:null;
}
const visitorId=(v:unknown)=>typeof v==='string'&&UUID.test(v)?v.toLowerCase():null;
export function withEntryDigest(record:Omit<LeadEntryObservation,'payloadHash'|'sourcePayloadHash'>,sourceMetadata:unknown):LeadEntryObservation {
 const {sourceUpdatedAt,...content}=record;
 const sourceContent={source:record.source,namespace:record.sourceNamespace,family:record.family,id:record.externalId,container:record.containerId,metadata:sourceMetadata};
 return {...record,payloadHash:createHash('sha256').update(canonical(content)).digest('hex'),sourcePayloadHash:createHash('sha256').update(canonical(sourceContent)).digest('hex')};
}
/** Source input exists only in server memory; emitted observations contain no answers or contact coordinates. */
export function normalizeWixLeadEntry(raw:unknown,family:'forms'|'quiz',config:WixLeadEntryConfig,siteId:string,identitySecret:string):LeadEntryObservation|null {
 const r=object(raw);let data:Record<string,unknown>,container:string,id:string,at:string,updated:string,status:string|null,rawEmail:unknown,contactId:string|null=null,eligible:boolean,origin:Record<string,unknown>={},firstTouch:Record<string,unknown>|null=null;let sourceMetadata:unknown;const consulted:Record<string,unknown>={};
 if(family==='forms'){
  container=value(r.formId)!;
  if(config.ignoredFormIds.includes(container))return null;
  if(!config.formIds.includes(container))throw new ConnectorError('UNCONFIGURED_SOURCE_FORM');
  if(r.namespace!==config.formNamespace)throw new ConnectorError('SOURCE_NAMESPACE_MISMATCH');
  data=object(r.submissions);id=value(r.id)!;at=entryInstant(r.createdDate);updated=entryInstant(r.updatedDate);status=value(r.status);contactId=value(r.contactId);rawEmail=data[config.formEmailField];eligible=status==='CONFIRMED';
  sourceMetadata={namespace:r.namespace,createdDate:r.createdDate,status:r.status,contactId:r.contactId??null};
  consulted[JSON.stringify(['submissions',config.formEmailField])]=rawEmail;
  // Champs cachés d'origine (masterclass) : absents sur les anciennes soumissions, jamais une erreur.
  const f=config.formOriginFields??{};
  if(f.current){const current=contextJsonOrigin(data[f.current]);if(current)Object.assign(origin,current);consulted[JSON.stringify(['submissions',f.current])]=data[f.current]??null;}
  if(f.visitor){const v=visitorId(data[f.visitor]);if(v)origin.visitor=v;}
  if(f.session){const s=data[f.session];if(typeof s==='string'&&/^[a-zA-Z0-9-]{1,120}$/.test(s))origin.session=s;}
  if(f.first){firstTouch=contextJsonOrigin(data[f.first]);consulted[JSON.stringify(['submissions',f.first])]=data[f.first]??null;}
 }else{
  if(!config.quiz)throw new ConnectorError('QUIZ_SOURCE_NOT_CONFIGURED');
  data=object(r.data);container=config.quiz.collectionId;id=value(r.id??data._id)!;
  const dateValue=(v:unknown)=>v&&typeof v==='object'?object(v).$date:v;
  at=entryInstant(dateValue(data._createdDate));updated=entryInstant(dateValue(data._updatedDate));status=value(data[config.quiz.statusField]);rawEmail=data[config.quiz.emailField];eligible=status===config.quiz.completedStatus;
  sourceMetadata={createdDate:dateValue(data._createdDate)};
  for(const field of [config.quiz.emailField,config.quiz.statusField,...Object.values(config.quiz.originFields),...Object.values(config.quiz.firstTouchFields??{})])consulted[JSON.stringify(['data',field])]=data[field];
  for(const [name,field]of Object.entries(config.quiz.originFields)){
   const v=value(data[field],name==='pagePath'?2000:256);
   if(name==='pagePath'&&v){try{const u=new URL(v);origin[name]=u.origin+u.pathname;}catch{origin[name]=null;}Object.assign(origin,{...pageParamsOrigin(v),...Object.fromEntries(Object.entries(origin).filter(([,x])=>x))});}
   else if(name==='visitor')origin[name]=visitorId(v);
   else if(name==='linkId')origin[name]=v&&UUID.test(v)?v.toLowerCase():null;
   else origin[name]=v;
  }
  const first:Record<string,string>={};
  for(const [name,field]of Object.entries(config.quiz.firstTouchFields??{})){const v=value(data[field],name==='page'?300:256);if(v&&(name!=='linkId'||UUID.test(v)))first[name]=name==='linkId'?v.toLowerCase():v;}
  firstTouch=['source','medium','campaign','ad','adset','linkId'].some(k=>first[k])?first:null;
 }
 if(!id||!container)throw new ConnectorError('SOURCE_ID_MISSING');
 const identity=entryIdentity(rawEmail,identitySecret);
 return withEntryDigest({source:'wix',sourceNamespace:siteId,family,externalId:id,containerId:container,contactId,sourceStatus:status,occurredAt:at,sourceUpdatedAt:updated,identityKey:identity.key,eligible,properties:{version:LEAD_ENTRY_VERSION,dateBasis:'submission_created',rawCreatedAt:family==='forms'?r.createdDate:data._createdDate,identityBasis:identity.basis,origin,firstTouch,sourceFields:sourceFieldProofs(consulted,identitySecret),eligibilityBasis:eligible?'explicit_source_completed':'source_status_not_completed'}},sourceMetadata);
}

/** Exactly one bounded page. Docs: Forms filter-and-sort and CMS query-data-items.
 * Increment on source updated date, never contact creation; no Contacts full scan. */
export async function readWixLeadEntryPage(options:{family:'forms'|'quiz';config:WixLeadEntryConfig;siteId:string;apiKey:string;identitySecret:string;from:string;to:string;cursor?:string|null;fetcher?:typeof fetch}):Promise<EntryPage> {
 const {family,config}=options;
 if(!options.apiKey||!options.siteId||options.identitySecret.length<32)throw new ConnectorError('SOURCE_NOT_CONFIGURED');
 const from=entryInstant(options.from),to=entryInstant(options.to);
 if(Temporal.Instant.compare(from,to)>=0)throw new ConnectorError('INVALID_SOURCE_INTERVAL');
 let url:string,body:unknown,cmsOffset:number|null=null;
 if(family==='forms'){
  if(!config.formIds.length)throw new ConnectorError('FORMS_SOURCE_NOT_CONFIGURED');
  url='https://www.wixapis.com/forms/v4/submissions/namespace/query';
  body={query:options.cursor?{cursorPaging:{limit:100,cursor:options.cursor}}:{filter:{$and:[{namespace:{$eq:config.formNamespace}},{formId:{$in:config.formIds}},{updatedDate:{$gte:from}},{updatedDate:{$lt:to}}]},sort:[{fieldName:'updatedDate',order:'ASC'},{fieldName:'id',order:'ASC'}],cursorPaging:{limit:100}},onlyYourOwn:false};
 }else{
  if(!config.quiz)throw new ConnectorError('QUIZ_SOURCE_NOT_CONFIGURED');
  const offset=options.cursor?Number(options.cursor):0;if(!Number.isSafeInteger(offset)||offset<0||offset>100000)throw new ConnectorError('INVALID_SOURCE_CURSOR');
  cmsOffset=offset;
  url='https://www.wixapis.com/data/v2/items/query';
  body={dataCollectionId:config.quiz.collectionId,consistentRead:true,returnTotalCount:true,query:{filter:{$and:[{_updatedDate:{$gte:{$date:from}}},{_updatedDate:{$lt:{$date:to}}}]},sort:[{fieldName:'_updatedDate',order:'ASC'},{fieldName:'_id',order:'ASC'}],paging:{limit:100,offset},fields:['_id','_createdDate','_updatedDate',config.quiz.emailField,config.quiz.statusField,...Object.values(config.quiz.originFields),...Object.values(config.quiz.firstTouchFields??{})]}};
 }
 const response=object(await readJson(new URL(url),{method:'POST',headers:{Authorization:options.apiKey,'wix-site-id':options.siteId,'Content-Type':'application/json'},body:JSON.stringify(body)},{fetcher:options.fetcher}));
 const rows=response[family==='forms'?'submissions':'dataItems'];if(!Array.isArray(rows)||rows.length>100)throw new ConnectorError('INVALID_SOURCE_PAGE');
 const metadata=object(response[family==='forms'?'metadata':'pagingMetadata']);
 let done:boolean,cursor:string|null=null;
 if(family==='forms'){
  if(typeof metadata.hasNext!=='boolean'||metadata.count!==rows.length)throw new ConnectorError('INVALID_SOURCE_PAGINATION');
  done=!metadata.hasNext;
  if(!done){cursor=value(object(metadata.cursors).next,16000);if(!cursor||!rows.length||cursor===options.cursor)throw new ConnectorError('INVALID_SOURCE_CURSOR');}
 }else{
  const offset=cmsOffset!,count=metadata.count,total=metadata.total,responseOffset=metadata.offset;
  /* CMS query-data-items exposes count/offset/total, never Forms hasNext.
     `returnTotalCount` is requested above, so an absent/approximate total is
     unsafe: a short page may still have more records. */
  if((metadata.tooManyToCount!==undefined&&metadata.tooManyToCount!==false)||!Number.isSafeInteger(count)||!Number.isSafeInteger(total)||!Number.isSafeInteger(responseOffset))throw new ConnectorError('INVALID_SOURCE_PAGINATION');
  const exactCount=count as number,exactTotal=total as number,exactOffset=responseOffset as number;
  if(exactCount!==rows.length||exactOffset!==offset||exactTotal<0||exactTotal>100000||offset+exactCount>exactTotal)throw new ConnectorError('INVALID_SOURCE_PAGINATION');
  done=offset+exactCount===exactTotal;
  if(!done){const next=offset+exactCount;if(!exactCount||next<=offset||next>100000)throw new ConnectorError('INVALID_SOURCE_CURSOR');cursor=String(next);}
 }
 const records:LeadEntryObservation[]=[];let ignored=0;
 for(const raw of rows){const observation=normalizeWixLeadEntry(raw,family,config,options.siteId,options.identitySecret);if(observation)records.push(observation);else ignored++;}
 if(new Set(records.map(r=>r.externalId)).size!==records.length)throw new ConnectorError('DUPLICATE_SOURCE_IDS');
 return {records,read:rows.length,ignored,cursor,done};
}
