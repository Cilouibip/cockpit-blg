import test from 'node:test';
import assert from 'node:assert/strict';
import { writeLinkThenRead } from '../src/lib/link-write-result';
import type { LinksResponse } from '../src/lib/ui-contract';

const links:LinksResponse={mode:'live',persistent:true,links:[]};
test('une écriture suivie d’une relecture réussie retourne le registre',async()=>{
 let saves=0,reads=0;
 const result=await writeLinkThenRead({save:async()=>{saves++;},read:async()=>{reads++;return links;}});
 assert.deepEqual(result,{saved:true,links});assert.equal(saves,1);assert.equal(reads,1);
});
test('une relecture interrompue après écriture garde l’accusé de persistance',async()=>{
 let saves=0,reads=0;
 const result=await writeLinkThenRead({save:async()=>{saves++;},read:async()=>{reads++;throw Error('read unavailable');}});
 assert.equal(result.saved,true);assert.equal(result.links,null);assert.match(result.notice??'',/Lien enregistré/);assert.equal(saves,1);assert.equal(reads,1);
});
test('une écriture interrompue ne prétend pas réussir et ne déclenche pas de relecture',async()=>{
 let reads=0;
 await assert.rejects(()=>writeLinkThenRead({save:async()=>{throw Error('write unavailable');},read:async()=>{reads++;return links;}}),/write unavailable/);
 assert.equal(reads,0);
});
