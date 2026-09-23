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

test('ad report: a complete read is published atomically, an incomplete read is only closed', async () => {
 const today = Temporal.Now.plainDateISO('Europe/Paris'), day = today.subtract({ days: 1 }).toString();
 for (const complete of [true, false]) {
  const calls: string[] = [];
  const db: Database = { probe: async () => {}, select: async () => [], upsert: async () => {}, rpc: async <T>(name: string, args: Row) => { calls.push(name); if (name === 'cockpit_publish_meta_daily') { assert.equal(args.p_rejected, 0); return { status: 'complete' } as T; } return 'synthetic-run' as T; } };
  const fetcher: typeof fetch = async input => {
   const url = new URL(String(input));
   if (url.pathname.endsWith('/insights')) return new Response(JSON.stringify({ data: [{ account_id: '123', ad_id: '42', date_start: day, date_stop: day, spend: '1.00', impressions: '10', ...(complete ? {} : { account_id: 'other' }) }] }));
   return new Response(JSON.stringify({ account_id: '123', currency: 'EUR', timezone_name: 'Europe/Paris' }));
  };
  const result = await synchronizeMetaAds(undefined, undefined, { db, fetcher, env: { NODE_ENV: 'test', COCKPIT_MODE: 'live', META_AD_ACCOUNT_ID: '123', META_ACCESS_TOKEN: 'synthetic' } });
  if (complete) { assert.equal(result.status, 'complete'); assert.deepEqual(calls, ['begin_sync_stream', 'import_meta_page', 'cockpit_publish_meta_daily']); }
  else { assert.equal(result.coverage.complete, false); assert.deepEqual(calls, ['begin_sync_stream', 'import_meta_page', 'finish_sync'], 'lignes rejetées : aucune publication'); }
 }
});

test('U8b KPI Meta : le passage automatique lit aussi le jour en cours au niveau compte et les fenêtres finissant hier et aujourd’hui (Paris)', async () => {
 const {synchronizeKpi}=await import('../src/lib/sync-kpi');
 const {memoryKpiDatabase}=await import('./helpers/kpi-memory');
 const {readKpiWindows}=await import('../src/lib/kpi-source-store');
 const today=Temporal.Now.plainDateISO('Europe/Paris'),memory=memoryKpiDatabase();
 const ranges:{level:string|null;daily:boolean;range:{since:string;until:string}}[]=[];
 const fetcher:typeof fetch=async input=>{
  const url=new URL(String(input));
  if(url.pathname.endsWith('/insights')){ranges.push({level:url.searchParams.get('level'),daily:url.searchParams.get('time_increment')==='1',range:JSON.parse(url.searchParams.get('time_range')!)});return new Response(JSON.stringify({data:[]}));}
  return new Response(JSON.stringify({account_id:'123',currency:'EUR',timezone_name:'Europe/Paris'}));
 };
 const result=await synchronizeKpi('meta',{db:memory.db,fetcher,env:{NODE_ENV:'test',META_AD_ACCOUNT_ID:'123',META_ACCESS_TOKEN:'synthetic'}});
 assert.equal(result.status,'complete');
 assert.deepEqual(ranges.filter(r=>r.daily).map(r=>[r.level,r.range.until]),[['campaign',today.toString()],['account',today.toString()]]);
 const windows=ranges.filter(r=>!r.daily).map(r=>`${r.range.since}→${r.range.until}`);
 const expected=[today.subtract({days:1}),today].flatMap(end=>[3,7,30].map(length=>`${end.subtract({days:length-1})}→${end}`));
 assert.deepEqual(windows,expected,'3, 7, 30 jours finissant hier puis aujourd’hui');
 const stored=await readKpiWindows(memory.db,'meta','123');
 assert.equal(stored.size,6);assert.ok([...stored.values()].every(w=>w.data===null),'fenêtre sans diffusion : lue vide, jamais une somme de jours');
});
