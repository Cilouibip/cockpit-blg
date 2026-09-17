import test from 'node:test';
import assert from 'node:assert/strict';
import {Temporal} from '@js-temporal/polyfill';
import {synchronizeMetaAds} from '../src/lib/sync';
import type {Database,Row} from '../src/lib/db';
test('the hourly ad report includes today in Paris, with the stored upper bound exclusive',async()=>{
 const today=Temporal.Now.plainDateISO('Europe/Paris');
 const runs:Row[]=[];let range:{since:string;until:string}|undefined;
 const db:Database={probe:async()=>{},select:async()=>[],upsert:async()=>{},rpc:async<T>(name:string,args:Row)=>{if(name==='begin_sync_stream')runs.push(args);return 'synthetic-run' as T;}};
 const fetcher:typeof fetch=async input=>{
  const url=new URL(String(input));
  if(url.pathname.endsWith('/insights')){range=JSON.parse(url.searchParams.get('time_range')!);return new Response(JSON.stringify({data:[]}));}
  return new Response(JSON.stringify({account_id:'123',currency:'EUR',timezone_name:'Europe/Paris'}));
 };
 const result=await synchronizeMetaAds(undefined,undefined,{db,fetcher,env:{NODE_ENV:'test',COCKPIT_MODE:'live',META_AD_ACCOUNT_ID:'123',META_ACCESS_TOKEN:'synthetic'}});
 assert.equal(result.status,'empty');
 assert.equal(range?.until,today.toString());
 assert.equal(runs[0].p_date_to,today.add({days:1}).toString());
});
