import test from 'node:test';
import assert from 'node:assert/strict';
import {supabaseDatabase} from '../src/lib/db';
import {getConfig} from '../src/lib/config';

test('la lecture REST conserve toutes les contraintes sur une même colonne',async()=>{
 const config=getConfig({SUPABASE_URL:'https://synthetic.supabase.co',SUPABASE_SECRET_KEY:'synthetic'});
 let requested:URL|undefined;
 const db=supabaseDatabase(config,async input=>{requested=new URL(String(input));return new Response('[]');});
 await db.select('v_ad_daily',{gte:{date:'2026-09-01'},lt:{date:'2026-10-01'},order:'date,id'});
 assert.deepEqual(requested!.searchParams.getAll('date'),['gte.2026-09-01','lt.2026-10-01']);
 await db.select('ads',{eq:{external_id:'123'},in:{external_id:['123','456']},gte:{external_id:'100'},lt:{external_id:'200'}});
 assert.deepEqual(requested!.searchParams.getAll('external_id'),['eq.123','in.(123,456)','gte.100','lt.200']);
});
