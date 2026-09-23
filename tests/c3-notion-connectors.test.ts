import test from 'node:test';
import assert from 'node:assert/strict';
import {BLG_NOTION_FIELDS,syncNotion} from '../src/connectors/notion';
import {readNotionBusinessSchema} from '../src/connectors/notion-schema';
import {readNotionInventoryPage} from '../src/connectors/notion-inventory';
const id='22222222-2222-4222-8222-222222222222';
const formula='if(prop("Etat")=="Noshow",style("Noshow","b","red"),if(prop("Etat")=="Ancien client"ORprop("Etat")=="RDV Terminé"ORprop("Etat")=="Closé"ORprop("Etat")=="Perdu"ORprop("Etat")=="À relancer"ORprop("Etat")=="Plus de réponses"ORprop("Etat")=="Plus tard",style("Show up","b","green"),""))';
const types:Record<string,string>={name:'title',status:'select',responsible:'select',closer:'select',appointmentAt:'date',nextFollowUpAt:'date',email:'email',emailBis:'email',clients:'relation',createdAt:'created_time',acquisitionReal:'date',acquisitionLegacy:'date',acquisitionWix:'date',bookedAt:'date',closedAt:'date',attendanceGroup:'formula',channels:'multi_select',tunnels:'multi_select'};
const schema=(expression=formula)=>({id,properties:Object.fromEntries(Object.entries(BLG_NOTION_FIELDS).map(([k,name])=>[name,{id:k,type:types[k],...(k==='attendanceGroup'?{formula:{expression}}:{})}]))});
test('schema projection uses only reviewed property IDs and unknown formula dependencies disable deltas',async()=>{
 const good=await readNotionBusinessSchema({dataSourceId:id,token:'synthetic',fetcher:async()=>Response.json(schema())});assert.equal(good.proof.deltaSafe,true);assert.equal(good.fields.name,'name');
 const drift=await readNotionBusinessSchema({dataSourceId:id,token:'synthetic',fetcher:async()=>Response.json(schema('now()'))});assert.equal(drift.proof.deltaSafe,false);assert.notEqual(drift.proof.digest,good.proof.digest);
 await assert.rejects(readNotionBusinessSchema({dataSourceId:id,fetcher:async()=>Response.json({...schema(),id:'other'})}),{message:'SOURCE_IDENTITY_MISMATCH'});
});
const config={token:'synthetic',dataSourceId:id,fields:BLG_NOTION_FIELDS,mappingVersion:'v1',from:'2026-03-28T23:00:00Z',to:'2026-03-29T22:00:00Z'};
const row={id,created_time:'2026-03-29T00:00:00Z',last_edited_time:'2026-03-29T01:00:00Z',properties:{Clients:{relation:[],has_more:false},"Groupe d'état Noshow":{formula:{type:'string',string:''}}}};
test('hourly inventory requests only two dependency properties with exact UTC Paris DST bounds',async()=>{
 const batch=await readNotionInventoryPage({...config,fetcher:async(url,init)=>{
  assert.deepEqual(new URL(String(url)).searchParams.getAll('filter_properties[]'),['Clients',"Groupe d'état Noshow"]);const body=JSON.parse(String(init?.body));assert.equal(body.filter.and[0].created_time.on_or_after,config.from);assert.equal(body.filter.and[1].created_time.before,config.to);
  return Response.json({results:[row],has_more:false});
 }});assert.equal(batch.status,'complete');assert.equal(batch.records.length,1);assert.equal('name' in batch.records[0],false);
});
test('truncated relation, repeated cursor and transport/429 failure never complete an inventory',async()=>{
 for(const input of [{results:[{...row,properties:{...row.properties,Clients:{relation:[],has_more:true}}}],has_more:false},{results:[row],has_more:true,next_cursor:'same'}]){
  const result=await readNotionInventoryPage({...config,cursor:'same',fetcher:async()=>Response.json(input)});assert.equal(result.status,'failed');assert.equal(result.coverage.complete,false);
 }
 for(const status of [429,503]){let calls=0;const result=await readNotionInventoryPage({...config,fetcher:async()=>{calls++;return Response.json({}, {status});}});assert.equal(result.status,'failed');assert.equal(calls,1,'a persisted later tick owns the retry');}
});
test('the normal Notion reader rejects incomplete relations instead of silently truncating business facts',async()=>{
 const result=await syncNotion({...config,maxPages:1,fetcher:async()=>Response.json({results:[{...row,properties:{...row.properties,Clients:{relation:[],has_more:true}}}],has_more:false})});assert.equal(result.coverage.complete,false);assert.equal(result.counts.rejected,1);
});
test('U9 tranche d’inventaire partielle : bornes exactes [from, to), curseur de reprise transmis, page suivante signalée sans compléter',async()=>{
 const slice={...config,from:'2026-03-01T00:00:00Z',to:'2026-03-08T00:00:00Z'},bodies:{filter:{and:Record<string,Record<string,string>>[]};start_cursor?:string;sorts:unknown[]}[]=[];
 const fetcher=async(_url:unknown,init?:RequestInit)=>{const body=JSON.parse(String(init?.body));bodies.push(body);return Response.json(body.start_cursor?{results:[row],has_more:false}:{results:[row],has_more:true,next_cursor:'slice-2'});};
 const first=await readNotionInventoryPage({...slice,fetcher:fetcher as typeof fetch});
 assert.equal(first.status,'partial');assert.equal(first.safeError,'PAGE_LIMIT_REACHED');assert.deepEqual(first.checkpoint,{cursor:'slice-2'});assert.equal(first.coverage.complete,false);
 const second=await readNotionInventoryPage({...slice,cursor:'slice-2',fetcher:fetcher as typeof fetch});
 assert.equal(second.status,'complete');assert.equal(second.coverage.complete,true);assert.deepEqual(second.checkpoint,{});
 for(const body of bodies){assert.deepEqual(body.filter.and,[{timestamp:'created_time',created_time:{on_or_after:slice.from}},{timestamp:'created_time',created_time:{before:slice.to}}]);assert.deepEqual(body.sorts,[{timestamp:'created_time',direction:'ascending'}]);}
 assert.equal(bodies[0].start_cursor,undefined);assert.equal(bodies[1].start_cursor,'slice-2');
});
test('U9 queryTimestamp : l’intervalle des modifications filtre et trie sur last_edited_time, la lecture complète sur created_time',async()=>{
 for(const queryTimestamp of ['last_edited_time','created_time'] as const){
  let body:{filter:{and:Record<string,unknown>[]};sorts:{timestamp:string}[]}|undefined;
  const result=await syncNotion({...config,queryTimestamp,maxPages:1,fetcher:async(_url,init)=>{body=JSON.parse(String(init?.body));return Response.json({results:[],has_more:false});}});
  assert.equal(result.status,'empty');assert.deepEqual(body!.filter.and,[{timestamp:queryTimestamp,[queryTimestamp]:{on_or_after:config.from}},{timestamp:queryTimestamp,[queryTimestamp]:{before:config.to}}]);assert.equal(body!.sorts[0].timestamp,queryTimestamp);
 }
});
