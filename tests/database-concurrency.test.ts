import test from 'node:test';
import assert from 'node:assert/strict';
import {limitDatabaseReads} from '../src/lib/database-concurrency';
import type {Database,Row,SelectOptions,TableName} from '../src/lib/db';
import {invalidateSourceWindow,readSourceSnapshot,type SourceWindow} from '../src/lib/source-snapshots';

const wait=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

test('la borne conserve les résultats et les paramètres avec au plus quatre lectures',async()=>{
 let active=0,peak=0;
 const calls:{kind:'select'|'rpc';name:string;value:unknown}[]=[];
 const db:Database={
  async select(table:TableName,options?:SelectOptions){calls.push({kind:'select',name:table,value:options});active++;peak=Math.max(peak,active);try{await wait(4);return [{table,limit:options?.limit??null}];}finally{active--;}},
  async rpc<T>(name:string,args:Row){calls.push({kind:'rpc',name,value:args});active++;peak=Math.max(peak,active);try{await wait(4);return {name,args} as T;}finally{active--;}},
  async upsert(){assert.fail('aucune écriture attendue');},
  async probe(){active++;peak=Math.max(peak,active);try{await wait(4);}finally{active--;}}
 };
 const limited=limitDatabaseReads(db,4);
 const results=await Promise.all([
  limited.select('prospects',{limit:7,order:'id'}),
  limited.rpc<{name:string;args:Row}>('one',{p_value:1}),
  ...Array.from({length:10},(_,index)=>limited.rpc<{name:string}>('queued',{p_index:index})),
  limited.probe(),
 ]);
 assert.equal(peak,4);
 assert.deepEqual(results[0],[{table:'prospects',limit:7}]);
 assert.deepEqual(results[1],{name:'one',args:{p_value:1}});
 assert.deepEqual(calls[0],{kind:'select',name:'prospects',value:{limit:7,order:'id'}});
 assert.deepEqual(calls[1],{kind:'rpc',name:'one',value:{p_value:1}});
});

test('un rejet libère la file FIFO et propage la même erreur',async()=>{
 const failure=new Error('lecture synthétique interrompue');
 const started:string[]=[];
 const db:Database={
  async select(){return [];},
  async rpc<T>(name:string){started.push(name);await wait(2);if(name==='first')throw failure;return name as T;},
  async upsert(){assert.fail('aucune écriture attendue');},
  async probe(){},
 };
 const limited=limitDatabaseReads(db,1);
 const outcomes=await Promise.allSettled([
  limited.rpc('first',{}),
  limited.rpc('second',{}),
  limited.rpc('third',{}),
 ]);
 assert.deepEqual(started,['first','second','third']);
 assert.equal(outcomes[0].status,'rejected');
 if(outcomes[0].status==='rejected')assert.equal(outcomes[0].reason,failure);
 assert.deepEqual(outcomes.slice(1).map(outcome=>outcome.status),['fulfilled','fulfilled']);
 if(outcomes[1].status==='fulfilled')assert.equal(outcomes[1].value,'second');
 if(outcomes[2].status==='fulfilled')assert.equal(outcomes[2].value,'third');
});

test('le wrapper conserve le cache source et son invalidation ciblée sur la base d’origine',async()=>{
 let reads=0;
 const snapshot={runs:[],aggregates:[],selections:[],validations:{},exactRunId:null,latestAttempt:null};
 const db:Database={
  async select(){return [];},
  async rpc<T>(){reads++;return structuredClone(snapshot) as T;},
  async upsert(){assert.fail('aucune écriture attendue');},
  async probe(){},
 };
 const window:SourceWindow={stream:'quiz_observations',profile:'synthetic',from:'2026-09-01',to:'2026-09-02',timezone:'Europe/Paris',currency:null,currencyExponent:null,kind:'exact_report'};
 const first=limitDatabaseReads(db,4),second=limitDatabaseReads(db,4);
 await readSourceSnapshot(first,'posthog','synthetic',window);
 await readSourceSnapshot(second,'posthog','synthetic',window);
 assert.equal(reads,1,'deux wrappers de la même requête logique partagent le propriétaire du cache');
 invalidateSourceWindow(db,'posthog','synthetic',window);
 await readSourceSnapshot(second,'posthog','synthetic',window);
 assert.equal(reads,2,'l’invalidation de la base d’origine atteint le cache partagé');
});

test('les rapports lourds sont séquentiels sans occuper les places des lectures légères en attente',async()=>{
 let releaseFirst!:()=>void;
 const firstGate=new Promise<void>(resolve=>{releaseFirst=resolve;});
 const started:string[]=[];
 let activeHeavy=0,peakHeavy=0;
 const db:Database={
  async select(){started.push('light');return [{value:42}];},
  async rpc<T>(name:string,args:Row){
   started.push(name);activeHeavy++;peakHeavy=Math.max(peakHeavy,activeHeavy);
   try{if(name==='cockpit_business_rollup')await firstGate;return {name,args} as T;}
   finally{activeHeavy--;}
  },
  async upsert(){assert.fail('aucune écriture attendue');},async probe(){},
 };
 const limited=limitDatabaseReads(db,2);
 const jobs=[
  limited.rpc('cockpit_business_rollup',{period:'current'}),
  limited.rpc('cockpit_lead_entry_rollup_v2',{period:'current'}),
  limited.rpc('cockpit_source_window',{period:'previous'}),
 ];
 try{
  const light=await limited.select('sync_runs');
  assert.deepEqual(light,[{value:42}]);
  assert.ok(started.includes('light'));
  assert.ok(!started.includes('cockpit_lead_entry_rollup_v2'));
  assert.ok(!started.includes('cockpit_source_window'));
 }finally{releaseFirst();}
 const reports=await Promise.all(jobs);
 assert.equal(peakHeavy,1);
 assert.deepEqual(started.filter(s=>s!=='light'),['cockpit_business_rollup','cockpit_lead_entry_rollup_v2','cockpit_source_window']);
 assert.deepEqual(reports,[{name:'cockpit_business_rollup',args:{period:'current'}},{name:'cockpit_lead_entry_rollup_v2',args:{period:'current'}},{name:'cockpit_source_window',args:{period:'previous'}}]);
});

test('une erreur lourde libère les deux files et préserve les options de lecture',async()=>{
 const failure=new Error('synthetic report timeout'),signal=new AbortController().signal;
 const options={timeoutMs:1234,signal};
 const received:unknown[]=[];
 const db:Database={
  async select(){return [];},
  async rpc<T>(name:string,_args:Row,readOptions?:Parameters<Database['rpc']>[2]){
   received.push(readOptions);if(name==='cockpit_business_rollup')throw failure;return 'complete' as T;
  },
  async upsert(){assert.fail('aucune écriture attendue');},async probe(){},
 };
 const limited=limitDatabaseReads(db,1);
 const reports=await Promise.allSettled([limited.rpc('cockpit_business_rollup',{},options),limited.rpc('cockpit_source_window',{},options)]);
 assert.equal(reports[0].status,'rejected');if(reports[0].status==='rejected')assert.equal(reports[0].reason,failure);
 assert.deepEqual(reports[1],{status:'fulfilled',value:'complete'});
 assert.deepEqual(received,[options,options]);
 assert.equal((received[0] as typeof options).signal,signal);
});
