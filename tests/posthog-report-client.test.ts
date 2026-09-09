import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPostHogReportClient,postHogPreviousFilters,type PostHogDescriptor,type PostHogSlot} from '../src/lib/posthog-report-client';
import type {ReportLoadingState} from '../src/lib/posthog-report-controller';
import type {DashboardFilters,DashboardResponse} from '../src/lib/ui-contract';
const filters:DashboardFilters={from:'2026-08-20',to:'2026-09-02',source:'paid',campaign:'meta:123',tunnel:'quiz',compare:false};
const data=(from=filters.from,to=filters.to)=>({period:{from,to,timezone:'Europe/Paris'},metrics:[{id:'cash',value:42},{id:'spend',value:10},{id:'leads',value:3}],pillars:[{id:'content',metrics:[{id:'arrivals',value:7}]}]} as DashboardResponse);
const descriptor=async(url:string)=>({key:url,supported:true});
const ready=async(selection:{key:string})=>({key:selection.key,state:'ready' as const,message:'Available'});
const tick=()=>new Promise(r=>setImmediate(r));
function deferred<T>(){let resolve:(value:T)=>void=()=>{};const promise=new Promise<T>(r=>resolve=r);return{promise,resolve};}
test('Old descriptor response cannot initiate a POST or reload for a newer selection',async()=>{
 const slow=deferred<PostHogDescriptor>(),posts:string[]=[],read:string[]=[],seen:DashboardResponse[]=[];
 const client=createPostHogReportClient({descriptor:url=>url.includes('from=2026-08-20')?slow.promise:descriptor(url),transport:async s=>{posts.push(s.url);return ready(s);},dashboard:async url=>{read.push(url);return data('2026-08-21');},onState:()=>{},onData:d=>seen.push(d)});
 const first=client.select(filters,'quiz');await tick();await client.select({...filters,from:'2026-08-21'},'quiz');slow.resolve({key:'old',supported:true});await first;
 assert.equal(posts.length,1);assert.match(posts[0],/from=2026-08-21/);assert.equal(read.length,1);assert.equal(seen[0].period.from,'2026-08-21');
});
test('Ready waits for the targeted cross-instance reload; cash and CRM are not cleared while it waits',async()=>{
 const reload=deferred<DashboardResponse>(),states:ReportLoadingState[]=[],seen:DashboardResponse[]=[],urls:string[]=[];
 const client=createPostHogReportClient({descriptor,transport:ready,dashboard:url=>{urls.push(url);return reload.promise;},onState:(_,s)=>states.push(s),onData:d=>seen.push(d)});
 const run=client.select(filters,'quiz');await tick();assert.equal(seen.length,0);assert.equal(states.some(s=>s.state==='ready'),false);assert.match(urls[0],/refreshPosthog=1/);
 reload.resolve(data());await run;assert.equal(states.at(-1)?.state,'ready');assert.deepEqual(seen[0].metrics,data().metrics);
});
test('Late dashboard A never replaces B, even when its network reader ignores cancellation',async()=>{
 const slow=deferred<DashboardResponse>(),seen:DashboardResponse[]=[],states:ReportLoadingState[]=[];
 const client=createPostHogReportClient({descriptor,transport:ready,dashboard:url=>url.includes('from=2026-08-20')?slow.promise:Promise.resolve(data('2026-08-21')),onState:(_,s)=>states.push(s),onData:d=>seen.push(d)});
 const first=client.select(filters,'quiz');await tick();await client.select({...filters,from:'2026-08-21'},'quiz');slow.resolve(data());await first;
 assert.deepEqual(seen.map(d=>d.period.from),['2026-08-21']);assert.equal(states.filter(s=>s.state==='ready').length,1);
});
test('Comparison uses its own dates, runs after current, and a failed comparison never invents zero',async()=>{
 const slots:{slot:PostHogSlot;state:ReportLoadingState}[]=[],urls:string[]=[],seen:DashboardResponse[]=[];
 const client=createPostHogReportClient({descriptor,transport:async s=>{urls.push(s.url);return s.url.includes('from=2026-08-06')?{key:s.key,state:'failed',message:'Failure'}:ready(s);},dashboard:async()=>data(),onState:(slot,state)=>slots.push({slot,state}),onData:d=>seen.push(d)});
 await client.select({...filters,compare:true},'quiz');assert.equal(urls.length,2);assert.match(urls[0],/from=2026-08-20/);assert.match(urls[1],/from=2026-08-06&to=2026-08-19/);
 assert.equal(slots.filter(s=>s.slot==='current').at(-1)?.state.state,'ready');assert.equal(slots.filter(s=>s.slot==='previous').at(-1)?.state.state,'failed');assert.equal(seen.length,1);
 assert.equal(postHogPreviousFilters({...filters,from:'2026-03-28',to:'2026-03-30'}).from,'2026-03-25');
});
test('Unsupported masterclass and mismatching dashboard periods cannot be declared ready',async()=>{
 for(const unsupported of [true,false]){
  const states:ReportLoadingState[]=[];let writes=0;
  const client=createPostHogReportClient({descriptor:async url=>unsupported?{key:null,supported:false}:descriptor(url),transport:async s=>{writes++;return ready(s);},dashboard:async()=>data('2026-01-01','2026-01-02'),onState:(_,s)=>states.push(s),onData:()=>assert.fail()});
  await client.select(filters,'masterclass');assert.equal(states.at(-1)?.state,unsupported?'unsupported':'failed');assert.equal(writes,unsupported?0:1);
 }
});
