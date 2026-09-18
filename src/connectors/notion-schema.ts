import {createHash} from 'node:crypto';
import {BLG_NOTION_FIELDS,type NotionConfig} from './notion';
import {ConnectorError,object,readJson} from './http';
// Reviewed schema: the attendance formula depends only on this page's Etat.
// Any change falls back to complete inventory until its dependencies are reviewed.
const attendanceFormula='if(prop("Etat")=="Noshow",style("Noshow","b","red"),if(prop("Etat")=="Ancien client"ORprop("Etat")=="RDV Terminé"ORprop("Etat")=="Closé"ORprop("Etat")=="Perdu"ORprop("Etat")=="À relancer"ORprop("Etat")=="Plus de réponses"ORprop("Etat")=="Plus tard",style("Show up","b","green"),""))';
const compact=(v:string)=>v.replace(/\s/g,'');
const expectedTypes:Record<string,string[]>={name:['title'],status:['select','status'],responsible:['select','people','relation'],closer:['select','people','relation'],appointmentAt:['date'],nextFollowUpAt:['date'],email:['email'],emailBis:['email'],clients:['relation'],createdAt:['created_time'],acquisitionReal:['date'],acquisitionLegacy:['date'],acquisitionWix:['date'],bookedAt:['date'],closedAt:['date'],attendanceGroup:['formula'],channels:['multi_select'],tunnels:['multi_select']};
export interface NotionSchemaProof {digest:string;deltaSafe:boolean}
/** Read metadata only. IDs bound query projections to the reviewed allowlist. */
export async function readNotionBusinessSchema(config:Pick<NotionConfig,'token'|'dataSourceId'|'fetcher'>):Promise<{proof:NotionSchemaProof;fields:NotionConfig['fields']}>{
 if(!config.dataSourceId||!/^[a-fA-F0-9-]{32,36}$/.test(config.dataSourceId))throw new ConnectorError('INVALID_CONFIGURATION');
 const schema=object(await readJson(new URL(`https://api.notion.com/v1/data_sources/${config.dataSourceId}`),{headers:{Authorization:`Bearer ${config.token}`,'Notion-Version':'2025-09-03'}},{fetcher:config.fetcher,attempts:1,timeoutMs:15000}));
 if(String(schema.id).replace(/-/g,'')!==config.dataSourceId.replace(/-/g,''))throw new ConnectorError('SOURCE_IDENTITY_MISMATCH');
 const properties=object(schema.properties),fields:NotionConfig['fields']={},shapes:unknown[]=[];let deltaSafe=true;
 for(const [key,name] of Object.entries(BLG_NOTION_FIELDS)){
  const prop=object(properties[name]);if(typeof prop.id!=='string'||typeof prop.type!=='string'||!expectedTypes[key]?.includes(prop.type))throw new ConnectorError('SOURCE_SCHEMA_CHANGED');
  fields[key as keyof typeof fields]=prop.id;
  if(key==='attendanceGroup')deltaSafe=typeof object(prop.formula).expression==='string'&&compact(String(object(prop.formula).expression))===compact(attendanceFormula);
  shapes.push([key,prop.id,prop.type,prop.formula??null,prop.relation??null]);
 }
 return {proof:{digest:createHash('sha256').update(JSON.stringify(shapes)).digest('hex'),deltaSafe},fields};
}
