/** Shared, server-only acquisition evidence. Mirrors the reciprocal identity rule already published in migration 011. */
import type {Row} from './db';
import {businessDay} from './appointment-semantics';
import {isExcludedTestTraffic} from './traffic-scope';

const record=(value:unknown):Row=>value&&typeof value==='object'&&!Array.isArray(value)?value as Row:{};
const strings=(value:unknown):string[]=>Array.isArray(value)?value.filter((v):v is string=>typeof v==='string'):[];

export function reconcileAcquisitionPeople(observations:Row[],prospects:Row[],namespace?:string):Row[] {
 const relevant=prospects.filter(p=>!namespace||p.source==='notion'&&p.source_namespace===namespace);
 const requests=observations.filter(o=>['forms','quiz'].includes(String(o.family))&&o.eligible===true&&o.person_id&&o.identity_key);
 const clientsByIdentity=new Map<string,Row[]>(),prospectsByExternal=new Map<string,Row[]>();
 for(const client of observations.filter(o=>o.family==='client_history')){const key=String(client.identity_key),rows=clientsByIdentity.get(key)??[];rows.push(client);clientsByIdentity.set(key,rows);}
 for(const prospect of relevant){const key=String(prospect.external_id),rows=prospectsByExternal.get(key)??[];rows.push(prospect);prospectsByExternal.set(key,rows);}
 const targets=new Map<string,Set<string>>(),identityTargets=new Map<string,Set<string>>();
 for(const request of requests){
  for(const client of clientsByIdentity.get(String(request.identity_key))??[]){
   const props=record(client.properties);
   if(namespace&&props.prospectNamespace!==namespace)continue;
   for(const prospect of strings(props.prospectIds).flatMap(id=>prospectsByExternal.get(id)??[])){
    if(!prospect.person_id||!strings(record(prospect.business).clientIds).includes(String(client.external_id)))continue;
    const person=String(request.person_id),identity=String(request.identity_key);
    const set=targets.get(person)??new Set<string>();set.add(String(prospect.person_id));targets.set(person,set);
    const key=person+'\0'+identity,perIdentity=identityTargets.get(key)??new Set<string>();perIdentity.add(String(prospect.person_id));identityTargets.set(key,perIdentity);
   }
  }
 }
 const bridge=new Map<string,{person:string;target:string}>();
 for(const [key,set] of identityTargets){
  const [person,identity]=key.split('\0');
  if(set.size!==1||targets.get(person)?.size!==1||relevant.some(p=>p.person_id===person))continue;
  bridge.set(identity,{person,target:[...set][0]});
 }
 return observations.map(row=>{
  const match=bridge.get(String(row.identity_key));
  return match&&(row.person_id===match.person||row.family==='client_history')?{...row,person_id:match.target}:row;
 });
}

/** Earliest business date is evidence of prior contact, never created_at or last_edited_time. */
export function acquisitionDays(prospects:Row[],namespace?:string,includeTests=false):Map<string,string> {
 const days=new Map<string,string>();
 for(const p of prospects){
  if(!p.person_id||namespace&&(p.source!=='notion'||p.source_namespace!==namespace))continue;
  const business=record(p.business),dates=record(business.dates);
  if(isExcludedTestTraffic({includeTests},business))continue;
  const day=[dates.real,dates.legacy,dates.wix,business.acquisitionDay].map(businessDay).filter((d):d is string=>!!d).sort()[0];
  const person=String(p.person_id);if(day&&(!days.has(person)||day<days.get(person)!))days.set(person,day);
 }
 return days;
}
