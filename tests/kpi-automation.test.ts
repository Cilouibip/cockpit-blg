import test from 'node:test';
import assert from 'node:assert/strict';
import { readKpiSource, syncKpiSource } from '../src/lib/kpi-source-store';
import { readLiveKpiFunnel } from '../src/lib/kpi-funnel-live';
import { kpiFunnelCsv } from '../src/lib/kpi-funnel-export';
import { memoryKpiDatabase } from './helpers/kpi-memory';
import { ConnectorError } from '../src/connectors/http';
import { jobScope } from '../src/lib/sync-jobs';
import { kpiBookingQuery } from '../src/connectors/journey-analytics';
import { leadEntryProfile, wixLeadEntryConfig } from '../src/connectors/wix-lead-entries';
import { VISUAL_JOURNEY_FORM_ID } from '../src/lib/visual-journey-report';
const from='2026-09-20',to='2026-09-22',namespace='synthetic-account';
const filters={from,to:'2026-09-21',source:'all',tunnel:'masterclass',campaign:'',compare:false} as const;
const batch=(value:number,observedAt:string)=>({from,to,observedAt,rows:[{day:from,key:'120248692698770714',data:{campaignId:'120248692698770714',spend_eur:value,impressions:100,link_clicks:10,unique_link_clicks_campaign_sum:9,landing_page_views:8,booking_meta_attributed:0}}]});

test('two completed cycles advance values; failed and corrupt publications retain the last verified result',async()=>{
 let at='2026-09-22T09:00:00Z';const memory=memoryKpiDatabase({},()=>at);
 await syncKpiSource(memory.db,'meta',namespace,from,to,async()=>batch(10,at));
 at='2026-09-22T10:00:00Z';await syncKpiSource(memory.db,'meta',namespace,from,to,async()=>batch(12,at));
 let data=await readKpiSource(memory.db,'meta',namespace,from,to);assert.equal(data.days.get(from)?.rows[0].data.spend_eur,12);assert.equal(data.days.get(from)?.observedAt,at);
 at='2026-09-22T11:00:00Z';await assert.rejects(()=>syncKpiSource(memory.db,'meta',namespace,from,to,async()=>{throw new ConnectorError('UPSTREAM_HTTP_ERROR',503);}));
 data=await readKpiSource(memory.db,'meta',namespace,from,to);assert.equal(data.days.get(from)?.rows[0].data.spend_eur,12);assert.equal(data.latestAttempt?.status,'failed');
 const last=memory.get('source_aggregates').filter(r=>r.metric_key==='kpi_daily_row').at(-1)!;(last.dimensions as any).data.spend_eur=999;
 data=await readKpiSource(memory.db,'meta',namespace,from,to);assert.equal(data.days.get(from)?.rows[0].data.spend_eur,10);
 assert.equal(memory.get('sync_runs').length,3);assert.equal(memory.get('source_aggregates').filter(r=>r.metric_key==='kpi_daily_row').length,2);
});

test('no manual JSON is needed; date gaps remain null and exports use exactly the displayed values',async()=>{
 const memory=memoryKpiDatabase({},()=> '2026-09-22T10:00:00Z');await syncKpiSource(memory.db,'meta',namespace,from,to,async()=>batch(10,'2026-09-22T10:00:00Z'));
 const response=await readLiveKpiFunnel(memory.db,filters,{env:{NODE_ENV:'test',META_AD_ACCOUNT_ID:namespace},now:'2026-09-22T10:30:00Z'});
 assert.equal(response.status,'ready');if(response.status!=='ready')return;
 assert.equal(response.snapshot.metadata.mode,'automatic');assert.equal(response.snapshot.daily.length,2);assert.equal(response.snapshot.daily[0].spend_eur,10);assert.equal(response.snapshot.daily[1].spend_eur,null);assert.equal(response.snapshot.totals.spend_eur,null);assert.equal(response.snapshot.email_summary.all_three_forms.sent,null);
 const csv=kpiFunnelCsv(response.snapshot);assert.match(csv,/2026-09-20/);assert.match(csv,/Non mesuré/);assert.equal(csv.includes('identity'),false);
 const subset=await readLiveKpiFunnel(memory.db,{...filters,to:from},{env:{NODE_ENV:'test',META_AD_ACCOUNT_ID:namespace},now:'2026-09-22T10:30:00Z'});assert.equal(subset.status,'ready');if(subset.status==='ready')assert.equal(subset.snapshot.totals.spend_eur,10);
});

test('Wix repetitions, explicit tests and missing commercial coverage remain distinct',async()=>{
 const config=wixLeadEntryConfig(JSON.stringify({formIds:[VISUAL_JOURNEY_FORM_ID],ignoredFormIds:[],formEmailField:'email'}))!,profile=leadEntryProfile('forms',config);
 const run={id:'forms',source:'wix',source_namespace:'site',stream_key:'lead_entries_forms',query_profile_key:profile,status:'complete',pagination_complete:true,rows_rejected:0,started_at:'2026-09-22T10:00:00Z',finished_at:'2026-09-22T10:00:00Z',period_to:'2026-09-22T10:00:00Z'};
 const observations=[['a','person-a',false],['a','person-a',false],['b','person-b',true]].map(([identity,person,test],i)=>({id:`o${i}`,family:'forms',source:'wix',source_namespace:'site',source_container_id:VISUAL_JOURNEY_FORM_ID,is_current:true,run_id:'forms',published_at:run.finished_at,mapping_profile:profile,eligible:true,identity_key:identity,identity_state:'linked',person_id:person,occurred_day:from,occurred_at:`${from}T12:00:0${i}Z`,properties:{origin:{source:test?'test':'meta',medium:test?'recette':'paid_social'}}}));
 const memory=memoryKpiDatabase({sync_runs:[run],lead_source_observations:observations});
 const env:NodeJS.ProcessEnv={NODE_ENV:'test',WIX_SITE_ID:'site',WIX_LEAD_ENTRY_CONFIG:JSON.stringify(config)};
 const response=await readLiveKpiFunnel(memory.db,{...filters,to:from},{env,now:'2026-09-22T11:00:00Z'});assert.equal(response.status,'ready');if(response.status!=='ready')return;
 assert.equal(response.snapshot.totals.wix_form_submission_occurrences,2);assert.equal(response.snapshot.totals.wix_distinct_contacts,1);assert.equal(response.snapshot.totals.wix_repeat_occurrences,1);assert.equal(response.snapshot.totals.sales,null);
 const included=await readLiveKpiFunnel(memory.db,{...filters,to:from},{env,includeTests:true,now:'2026-09-22T11:00:00Z'});if(included.status==='ready')assert.equal(included.snapshot.totals.wix_form_submission_occurrences,3);
});

test('new streams use existing configured credentials; query preserves production and test markers',()=>{
 assert.equal(jobScope('kpi_email',{NODE_ENV:'test'}),null);assert.ok(jobScope('kpi_email',{NODE_ENV:'test',WIX_SITE_ID:'site',WIX_API_KEY:'synthetic',IDENTITY_HMAC_SECRET:'x'.repeat(32)}));
 const query=kpiBookingQuery(from,'2026-09-21');assert.match(query,/environment/);assert.match(query,/production/);assert.match(query,/page_id/);assert.match(query,/test-mehdi/);assert.match(query,/first_origin/);assert.match(query,/mc_booking_confirmed/);
});

// JSONB returns a semantically identical object in a different key order.
test('source manifests survive JSONB object-key reordering without losing covered days',async()=>{
 const memory=memoryKpiDatabase({},()=> '2026-09-22T10:00:00Z');
 await syncKpiSource(memory.db,'meta',namespace,from,to,async()=>batch(10,'2026-09-22T10:00:00Z'));
 const reorder=(v:any):any=>Array.isArray(v)?v.map(reorder):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).reverse().map(([k,item])=>[k,reorder(item)])):v;
 for(const row of memory.get('source_aggregates'))row.dimensions=reorder(row.dimensions);
 assert.equal((await readKpiSource(memory.db,'meta',namespace,from,to)).days.get(from)?.rows[0].data.spend_eur,10);
});
