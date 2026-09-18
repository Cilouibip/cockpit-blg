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
