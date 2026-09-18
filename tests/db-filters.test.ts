import test from 'node:test';
import assert from 'node:assert/strict';
import {supabaseDatabase} from '../src/lib/db';
import {getConfig} from '../src/lib/config';
import {AppError,publicError} from '../src/lib/errors';

test('la lecture REST conserve toutes les contraintes sur une même colonne',async()=>{
 const config=getConfig({SUPABASE_URL:'https://synthetic.supabase.co',SUPABASE_SECRET_KEY:'synthetic'});
 let requested:URL|undefined;
 const db=supabaseDatabase(config,async input=>{requested=new URL(String(input));return new Response('[]');});
 await db.select('v_ad_daily',{gte:{date:'2026-09-01'},lt:{date:'2026-10-01'},order:'date,id'});
 assert.deepEqual(requested!.searchParams.getAll('date'),['gte.2026-09-01','lt.2026-10-01']);
 await db.select('ads',{eq:{external_id:'123'},in:{external_id:['123','456']},gte:{external_id:'100'},lt:{external_id:'200'}});
 assert.deepEqual(requested!.searchParams.getAll('external_id'),['eq.123','in.(123,456)','gte.100','lt.200']);
});

test('les attentes et interruptions de lecture restent identifiables sans exposer les détails SQL',async()=>{
 for(const [sourceCode,expected] of [['PGRST003','database_busy'],['57014','database_query_interrupted'],['unexpected','database_unavailable']]){
  let calls=0;
  const db=supabaseDatabase(getConfig({SUPABASE_URL:'https://synthetic.supabase.co',SUPABASE_SECRET_KEY:'synthetic'}),async()=>{calls++;return Response.json({code:sourceCode,message:'private-sql-detail',details:'private-source-record'},{status:500});});
  await assert.rejects(()=>db.select('ads',{limit:1}),error=>{
   assert.ok(error instanceof AppError);assert.equal(error.code,expected);assert.equal(error.status,503);
   assert.doesNotMatch(JSON.stringify(publicError(error)),/private-sql-detail|private-source-record/);return true;
  });
  assert.equal(calls,1,'aucun rejeu automatique des opérations de base');
 }
});
