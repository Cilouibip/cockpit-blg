import test from 'node:test';import assert from 'node:assert/strict';
import {buildDashboard} from '../src/lib/dashboard';
const filters={from:'2026-02-01',to:'2026-02-01',source:'all' as const,tunnel:'all' as const,campaign:'',compare:false};
const empty={leads:[],events:[],payments:[],appointments:[],deals:[],ads:[],revisions:[],runs:[],aggregates:[]};
const payment={source:'wix',source_namespace:'site-a',effective_at:'2026-01-31T23:30:00Z',status:'settled',kind:'receipt',gross_minor:10000,currency:'EUR',currency_exponent:2,tax_basis:'tax_inclusive',reconciliation_state:'reconciled'};
const run={id:'a',source:'wix',source_namespace:'site-a',stream_key:'payments_and_refunds',status:'complete',pagination_complete:true,period_from:'2026-01-31T23:00:00.000Z',period_to:'2026-02-01T23:00:00.000Z',source_as_of:'2026-02-02T10:00:00Z',finished_at:'2026-02-02T10:01:00Z'};
const aggregate={id:'agg-a',source:'wix',source_namespace:'site-a',sync_run_id:'a',metric_key:'net_cash',definition_version:'net-ttc-v1',currency:'EUR',currency_exponent:2,unit:'minor',timezone:'Europe/Paris',tax_basis:'tax_inclusive',coverage_state:'complete',period_from:run.period_from,period_to:run.period_to,dimensions_key:'all',report_profile_key:'net-cash',value:20000};
const value=(data:ReturnType<typeof buildDashboard>,id:string)=>[...data.metrics,...data.pillars.flatMap(p=>p.metrics)].find(m=>m.id===id)?.value;
test('graphique journalier garde la date de paiement Paris au changement de mois',()=>{const d=buildDashboard({...empty,payments:[payment],runs:[run]},filters,'live');assert.equal(value(d,'cash'),100);assert.equal(d.series[0].revenue,100);});
test('couverture financière d’un autre namespace ne valide pas les transactions',()=>{const d=buildDashboard({...empty,payments:[payment],runs:[{...run,source_namespace:'site-b'}]},filters,'live');assert.equal(value(d,'cash'),null);});
test('agrégat exact sélectionné une fois, source/profil/lot/devise/fuseau vérifiés',()=>{
 const d=buildDashboard({...empty,aggregates:[aggregate],runs:[run]},filters,'live');assert.equal(value(d,'cash'),200);assert.equal(d.series[0].revenue,null);assert.match(d.metrics[0].coverage,/détaillés non disponibles/);
 for(const mutation of [{unit:'count'},{currency_exponent:0},{timezone:'UTC'},{source_namespace:'site-b'}])assert.equal(value(buildDashboard({...empty,aggregates:[{...aggregate,...mutation}],runs:[run]},filters,'live'),'cash'),null);
 assert.equal(value(buildDashboard({...empty,aggregates:[aggregate],runs:[{...run,status:'failed'}]},filters,'live'),'cash'),null);
 assert.equal(value(buildDashboard({...empty,aggregates:[aggregate,{...aggregate,id:'b'}],runs:[run]},filters,'live'),'cash'),null);
});
test('filtre Meta non raccordé ne fabrique pas zéro leads même en démonstration',()=>{assert.equal(value(buildDashboard(empty,{...filters,campaign:'meta:7001'},'demo'),'leads'),null);});
test('la fraîcheur d’un import Notion ne rajeunit pas un encaissement',()=>{const d=buildDashboard({...empty,payments:[payment],runs:[run,{...run,id:'b',source:'notion',finished_at:'2026-03-01T00:00Z'}]},filters,'live');assert.equal(d.metrics.find(m=>m.id==='cash')?.updatedAt,run.finished_at);});
test('données absentes restent indisponibles sans partition publiée',()=>{const d=buildDashboard(empty,filters,'live');assert.equal(value(d,'cash'),null);assert.equal(value(d,'spend'),null);assert.equal(value(d,'leads'),null);});
test('ROAS et coût client viennent exclusivement du snapshot publié de la même cohorte',()=>{
 const attribution={id:'run',status:'published',cohort_from:run.period_from,cohort_to:run.period_to,cohort_timezone:'Europe/Paris',currency:'EUR',tax_basis:'tax_inclusive',scope:{source:'all',tunnel:'all',campaign:''},coverage_summary:{available:true},input_manifest:{spend:{minor:10000,currency:'EUR'}},published_at:'2026-06-01T00:00Z',input_cutoff_at:'2026-06-01T00:00Z'};
 const rows=[{attribution_run_id:'run',target_kind:'payment',dimensions_snapshot:{source:'paid'},contribution_minor:40000,currency:'EUR',person_id:'p1'},{attribution_run_id:'run',target_kind:'new_customer',dimensions_snapshot:{source:'paid'},contribution_minor:null,currency:'EUR',person_id:'p1'}];
 const d=buildDashboard({...empty,attributionRuns:[attribution],attributionResults:rows},filters,'live');assert.equal(value(d,'roas'),4);assert.equal(value(d,'ad_customer_cost'),100);
 assert.equal(value(buildDashboard({...empty,attributionRuns:[{...attribution,coverage_summary:{available:false}}],attributionResults:rows},filters,'live'),'roas'),null);
});

test('CA contracté exige signature, source, montant et base ; reste distinct du cash',()=>{
 const deal={source:'wix',source_namespace:'contracts',signed_at:'2026-02-01T10:00:00Z',status:'signed',contracted_minor:200000,currency:'EUR',currency_exponent:2,tax_basis:'tax_inclusive',source_locator:'synthetic-contract'};
 const d=buildDashboard({...empty,deals:[deal]},filters,'live');assert.equal(value(d,'contracted'),2000);assert.equal(value(d,'cash'),null);
 assert.equal(value(buildDashboard({...empty,deals:[{...deal,source_locator:null}]},filters,'live'),'contracted'),null);
});
test('comparaison financière réelle exige une période précédente couverte',()=>{
 const data={...empty,payments:[payment,{...payment,effective_at:'2026-01-31T10:00:00Z',gross_minor:5000}],runs:[{...run,period_from:'2026-01-30T23:00:00.000Z'}]};
 const d=buildDashboard(data,{...filters,compare:true},'live');assert.equal(d.metrics.find(m=>m.id==='cash')?.previous,50);
 const partial=buildDashboard({...data,runs:[run]},{...filters,compare:true},'live');assert.equal(partial.metrics.find(m=>m.id==='cash')?.previous,null);
});
test('questions et vidéo gardent les tentatives, versions et intervalles réellement vus',()=>{
 const event={occurred_at:'2026-02-01T10:00:00Z',tunnel:'quiz',visitor_namespace:'test',journey_id:'journey-a',anonymous_id:'browser-a',link_revision_id:null};
 const d=buildDashboard({...empty,events:[{...event,event_name:'quiz_question_viewed',properties:{question_number:1}},{...event,event_name:'quiz_question_answered',journey_id:'journey-b',properties:{question_number:1}},...[[0,30],[10,40]].map(interval=>({...event,tunnel:'masterclass',event_name:'video_watch',properties:{video_id:'v',video_version:'1',duration:100,intervals:[{start:interval[0],end:interval[1]}]}}))]},filters,'live');
 assert.equal(d.journeys.find(j=>j.id==='questions')?.steps[0].value,0);
 const video=d.journeys.find(j=>j.id==='video')!;assert.equal(video.steps[0].value,1);assert.equal(video.steps[1].value,0);
});

test('un snapshot republié avec un cutoff ancien ne masque pas le plus récent',()=>{
 const common={status:'published',cohort_from:run.period_from,cohort_to:run.period_to,cohort_timezone:'Europe/Paris',currency:'EUR',tax_basis:'tax_inclusive',scope:{source:'all',tunnel:'all',campaign:''},coverage_summary:{available:true},input_manifest:{spend:{minor:10000,currency:'EUR'}}};
 const runs=[{...common,id:'new',input_cutoff_at:'2026-06-01T00:00Z',published_at:'2026-06-02T00:00Z'},{...common,id:'old',input_cutoff_at:'2026-05-01T00:00Z',published_at:'2026-07-01T00:00Z'}];
 const results=runs.map(r=>({attribution_run_id:r.id,target_kind:'payment',dimensions_snapshot:{source:'paid'},contribution_minor:r.id==='new'?40000:50000,currency:'EUR',person_id:'p'}));
 assert.equal(value(buildDashboard({...empty,attributionRuns:runs,attributionResults:results},filters,'live'),'roas'),4);
});
test('comparaison attribution refusée entre deux versions de définition',()=>{
 const common={status:'published',cohort_timezone:'Europe/Paris',currency:'EUR',tax_basis:'tax_inclusive',scope:{source:'all',tunnel:'all',campaign:''},coverage_summary:{available:true},input_manifest:{spend:{minor:10000,currency:'EUR'}},input_cutoff_at:'2026-06-01T00:00Z',published_at:'2026-06-02T00:00Z',model:'last_non_direct',lookback_days:30,observation_horizon_days:90};
 const current={...common,id:'now',cohort_from:run.period_from,cohort_to:run.period_to,metric_definition_version:'v2'};
 const prior={...common,id:'prior',cohort_from:'2026-01-30T23:00:00.000Z',cohort_to:run.period_from,metric_definition_version:'v1'};
 const results=[current,prior].map(r=>({attribution_run_id:r.id,target_kind:'payment',dimensions_snapshot:{source:'paid'},contribution_minor:40000,currency:'EUR',person_id:'p'}));
 const d=buildDashboard({...empty,attributionRuns:[current,prior],attributionResults:results},{...filters,compare:true},'live');assert.equal(value(d,'roas'),4);assert.equal(d.metrics.find(m=>m.id==='roas')?.previous,null);
});

test('publicité et créative filtrent leur dépense sans copier les leads globaux',()=>{
 const catalog=[{id:'ad-row-a',external_id:'ad-a',creative_id:'creative-a',ad_name:'A'},{id:'ad-row-b',external_id:'ad-b',creative_id:'creative-b',ad_name:'B'}];
 const ads=catalog.map((r,i)=>({id:'daily-'+i,ad_id:r.id,date:'2026-02-01',spend_minor:(i+1)*1000,currency:'EUR',timezone:'Europe/Paris',campaign_id:'campaign'}));
 for(const campaign of ['meta-ad:ad-a','meta-creative:creative-a']){const d=buildDashboard({...empty,ads,adCatalog:catalog},{...filters,campaign},'live');assert.equal(value(d,'spend'),10);assert.equal(value(d,'leads'),null);assert.ok(d.campaigns.some(c=>c.id===campaign));}
});
