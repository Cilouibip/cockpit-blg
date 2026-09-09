import{test}from'node:test';import assert from'node:assert/strict';
import{createPostHogReportController,type ReportLoadingState}from'../src/lib/posthog-report-controller';
import type{PostHogReportState}from'../src/lib/posthog-report-request';
import{postHogReportRequest}from'../src/lib/posthog-report-request';
const ready=(key:string):PostHogReportState=>({key,state:'ready',message:'Ready'});
function deferred<T>(){let resolve:(value:T)=>void=()=>{};const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};}
test('Late A cannot produce a success or reload after B is selected',async()=>{
 const a=deferred<PostHogReportState>(),b=deferred<PostHogReportState>(),seen:ReportLoadingState[]=[];
 const c=createPostHogReportController({transport:r=>r.key==='A'?a.promise:b.promise});
 const first=c.select({key:'A',url:'/A'},s=>seen.push(s)),second=c.select({key:'B',url:'/B'},s=>seen.push(s));b.resolve(ready('B'));await second;a.resolve(ready('A'));await first;
 assert.deepEqual(seen.filter(s=>s.state==='ready').map(s=>s.key),['B']);
});
test('Two requests for the same range share one transport and only the selected callback wins',async()=>{
 const d=deferred<PostHogReportState>();let calls=0;const seen:ReportLoadingState[]=[];
 const c=createPostHogReportController({transport:async()=>{calls++;return d.promise;}});
 const a=c.select({key:'same',url:'/same'},s=>seen.push(s)),b=c.select({key:'same',url:'/same'},s=>seen.push(s));d.resolve(ready('same'));await Promise.all([a,b]);assert.equal(calls,1);assert.equal(seen.filter(s=>s.state==='ready').length,1);
});
test('Failure on B preserves absence on B; it never recycles the earlier ready A',async()=>{
 const seen:ReportLoadingState[]=[];const c=createPostHogReportController({transport:async r=>{if(r.key==='B')throw Error('source failed');return ready(r.key);}});
 await c.select({key:'A',url:'/A'},s=>seen.push(s));await c.select({key:'B',url:'/B'},s=>seen.push(s));assert.equal(seen.at(-1)?.key,'B');assert.equal(seen.at(-1)?.state,'failed');
});
test('Waiting resumes within a finite attempt budget and then becomes a retryable failure',async()=>{
 for(const succeeds of [true,false]){let time=0,calls=0;const seen:ReportLoadingState[]=[];
 const c=createPostHogReportController({now:()=>time,sleep:async ms=>{time+=ms;},maxAttempts:3,transport:async r=>++calls===3&&succeeds?ready(r.key):{key:r.key,state:'waiting',message:'Wait',retryAfterMs:1000}});
 await c.select({key:'A',url:'/A'},s=>seen.push(s));assert.equal(calls,3);assert.equal(seen.at(-1)?.state,succeeds?'ready':'failed');}
});
test('Comparison owns its status; a missing previous report cannot change the current ready report',async()=>{
 const current:ReportLoadingState[]=[],previous:ReportLoadingState[]=[];
 const a=createPostHogReportController({transport:async r=>ready(r.key)}),b=createPostHogReportController({transport:async r=>({key:r.key,state:'failed',message:'Unavailable'})});
 await Promise.all([a.select({key:'current',url:'/current'},s=>current.push(s)),b.select({key:'previous',url:'/previous'},s=>previous.push(s))]);
 assert.equal(current.at(-1)?.state,'ready');assert.equal(previous.at(-1)?.state,'failed');assert.equal('empty' in previous.at(-1)!,false);
});
test('An obsolete waiting selection performs no retry and produces no stale success',async()=>{
 const gate=deferred<void>(),calls:string[]=[],seen:ReportLoadingState[]=[];
 const c=createPostHogReportController({sleep:()=>gate.promise,transport:async r=>{calls.push(r.key);return r.key==='A'?{key:r.key,state:'waiting',message:'Wait'}:ready(r.key);}});
 const old=c.select({key:'A',url:'/A'},s=>seen.push(s));await new Promise(r=>setImmediate(r));await c.select({key:'B',url:'/B'},s=>seen.push(s));gate.resolve();await old;
 assert.deepEqual(calls,['A','B']);assert.deepEqual(seen.filter(s=>s.state==='ready').map(s=>s.key),['B']);
});
test('A stalled transport is bounded even when it ignores abort',async()=>{
 const seen:ReportLoadingState[]=[];const c=createPostHogReportController({budgetMs:1000,transport:()=>new Promise(()=>{})});
 await c.select({key:'stalled',url:'/stalled'},s=>seen.push(s));assert.equal(seen.at(-1)?.state,'failed');
});
test('Switching masterclass context never coalesces the other page transport or delivers its response',async()=>{
 const filters={from:'2026-08-20',to:'2026-09-02',source:'all' as const,campaign:'',tunnel:'masterclass' as const,compare:false};
 const client={quizHost:'quiz.example.test',productionHosts:['quiz.example.test','www.example.test'],masterclassPageId:'first'};
 const a=postHogReportRequest(filters,'masterclass',client,'synthetic')!,b=postHogReportRequest(filters,'masterclass',{...client,masterclassPageId:'second'},'synthetic')!;
 const first=deferred<PostHogReportState>(),second=deferred<PostHogReportState>(),urls:string[]=[],seen:ReportLoadingState[]=[];
 const c=createPostHogReportController({transport:r=>{urls.push(r.url);return r.key===a.key?first.promise:second.promise;}});
 const pa=c.select({key:a.key,url:'/page-A'},s=>seen.push(s)),pb=c.select({key:b.key,url:'/page-B'},s=>seen.push(s));
 first.resolve(ready(a.key));await pa;second.resolve(ready(b.key));await pb;
 assert.deepEqual(urls,['/page-A','/page-B']);assert.deepEqual(seen.filter(s=>s.state==='ready').map(s=>s.key),[b.key]);
});
