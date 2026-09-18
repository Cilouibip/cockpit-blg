import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildAdFunnel,observationOrigin,originKeyFor,appointmentOutcome,ORGANIC,UNATTRIBUTED,UNRESOLVED} from '../src/lib/ad-funnel';
import {foldVisits,foldVisitorCohort,visitQueries,masterclassPagePath,masterclassPagePaths,parisDay,COHORT_LIMIT,type CohortRow} from '../src/lib/ad-arrivals';
import type {Database,Row,SelectOptions,TableName} from '../src/lib/db';
import {COMMERCE_COUNTERS,NOTION_COMMERCE_VERSION} from '../src/lib/notion-commerce-report';
import {notionCommerceConfig,notionCommerceProfile} from '../src/connectors/notion-commerce';

// Données synthétiques uniquement : aucune personne, publicité ou paiement réels.
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const SITE='site',LINK='11111111-1111-4111-8111-111111111111',VISITOR='3f0d4c2e-8a1b-4c7d-9e2f-1a2b3c4d5e6f';
const AD_A='120200000000000011',AD_B='120200000000000012',AD_C='120200000000000013',AD_D='120200000000000014',AD_E='120200000000000015',AD_F='120200000000000016',AD_K='120200000000000017',AD_L='120200000000000018',AD_G='120200000000000019',AD_H='120200000000000020';
const vid=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const commerceRaw=JSON.stringify({clients:{dataSourceId:'ds-clients'},payments:{dataSourceId:'ds-payments'},parcours:{dataSourceId:'ds-parcours'}});
const env={WIX_SITE_ID:SITE,NOTION_COMMERCE_CONFIG:commerceRaw};
const NOW='2026-09-25T12:00:00Z';
const obs=(id:string,family:'forms'|'quiz'|'client_history',extra:Partial<Row>&{origin?:Record<string,unknown>;firstTouch?:Record<string,unknown>|null;at?:string}):Row=>{
 const {origin={},firstTouch=null,at,...rest}=extra;
 const occurredAt=at??(rest.occurred_day?`${rest.occurred_day}T09:00:00Z`:'2026-09-05T09:00:00Z');
 return {id,source:family==='client_history'?'notion':'wix',source_namespace:family==='client_history'?'ds-clients':SITE,family,external_id:id,person_id:null,identity_state:'linked',eligible:true,occurred_at:occurredAt,occurred_day:occurredAt.slice(0,10),published_at:'2026-09-15T08:00:00Z',is_current:true,properties:{origin,firstTouch},...rest};
};
function commerceRows(details:Row[]):{runs:Row[];aggregates:Row[]}{
 const config=notionCommerceConfig(commerceRaw)!,profile=notionCommerceProfile(config),run='run-commerce';
 const totals=Object.fromEntries(COMMERCE_COUNTERS.map(k=>[k,0]));
 const summary={confirmedInitialSales:details.filter(d=>d.state==='confirmed').length,reconciledInitialSales:details.filter(d=>d.state==='reconciled').length,pendingInitialPaymentCases:details.filter(d=>d.state==='pending').length,excludedSubsequentPayments:0,refundCases:0,coverage:{payments:details.length,schedules:0,parcours:0,unlinkedPayments:0}};
 const base={source:'notion',source_namespace:'ds-parcours',report_profile_key:profile,sync_run_id:run,period_from:'1970-01-01T00:00:00Z',period_to:'2026-09-15T08:00:00Z'};
 return {
  runs:[{id:run,source:'notion',source_namespace:'ds-parcours',stream_key:'commerce_declared_snapshot',status:'complete',pagination_complete:true,rows_rejected:0,query_profile_key:profile,period_to:'2026-09-15T08:00:00Z',started_at:'2026-09-15T08:00:00Z'}],
  aggregates:[
   {...base,metric_key:'notion_commerce_overview',dimensions_key:'all',dimensions:{version:NOTION_COMMERCE_VERSION,observedAt:'2026-09-15T08:00:00Z',totals,dailyCount:0,dailyHash:digest([]),paidSalesSummary:summary,paidSalesCount:details.length,paidSalesHash:digest(details),coverage:{sourceRows:{}}}},
   {...base,metric_key:'notion_commerce_paid_sales',dimensions_key:'paid-sales:000000',dimensions:{details}},
  ],
 };
}
const sale=(paymentId:string,extra:Partial<Row>):Row=>({paymentId,paymentUrl:null,clientIds:['client-1'],clientName:null,clientUrl:null,scheduleIds:[],scheduleUrls:[],parcoursIds:[],day:'2026-09-10',amountMinor:39000,state:'confirmed',reasons:['first_succeeded_payment_for_client'],...extra});
const business=(scheduledDay:string,attendance:string,extra:Record<string,unknown>={})=>({version:'notion-acquisition-known-v1',scheduledDay,attendance,attendanceBasis:'source_group',channels:['Facebook'],tunnels:['Quiz'],...extra});

function fixture(extra:Row[]=[],additions:Partial<Record<string,Row[]>>={}){
 const observations=[
  // P1 : arrivée A (quiz, 3 septembre) sans inscription, retour B (masterclass) et inscription le 5 : A conservée, B = arrivée.
  obs('mc-p1','forms',{person_id:'p1',at:'2026-09-05T09:00:00Z',origin:{ad:AD_B,campaign:'1202',source:'fb',visitor:VISITOR},firstTouch:{ad:AD_A,campaign:'1201',source:'fb',linkId:LINK,tunnel:'quiz',at:'2026-09-03T10:00:00Z'}}),
  // P1 : deuxième inscription plus tard par une autre pub (D) : pas de nouveau lead, pas de réattribution.
  obs('quiz-p1-bis','quiz',{person_id:'p1',at:'2026-09-12T10:00:00Z',origin:{ad:AD_D,source:'fb'}}),
  // Panne/reprise : ancienne version de la même inscription, non courante.
  obs('quiz-p1-bis-old','quiz',{external_id:'quiz-p1-bis',person_id:'p1',at:'2026-09-12T10:00:00Z',is_current:false,origin:{ad:AD_D}}),
  // P2 : créative C, arrivée seulement.
  obs('quiz-p2','quiz',{person_id:'p2',at:'2026-09-06T09:00:00Z',origin:{ad:AD_C,source:'fb'}}),
  // P3 : déjà client avant sa demande → connu, pas un lead.
  obs('quiz-p3','quiz',{person_id:'p3',at:'2026-09-07T09:00:00Z',origin:{ad:AD_C,source:'fb'}}),
  obs('client-3','client_history',{external_id:'client-3',person_id:'p3',occurred_day:'2025-01-10'}),
  // Identité non rapprochée (email invalide) sur la créative C : inscription visible, aucune personne.
  obs('mc-anon','forms',{person_id:null,identity_state:'unresolved',at:'2026-09-08T09:00:00Z',origin:{ad:AD_C,source:'fb'}}),
  // P5 : organique Instagram ; P6 : arrivée directe sans origine.
  obs('quiz-p5','quiz',{person_id:'p5',at:'2026-09-09T09:00:00Z',origin:{source:'ig',ad:'link_in_bio'}}),
  obs('quiz-p6','quiz',{person_id:'p6',at:'2026-09-09T10:00:00Z',origin:{}}),
  // Hors période : ne compte pas dans les inscriptions de septembre.
  obs('quiz-p7','quiz',{person_id:'p7',at:'2026-08-20T09:00:00Z',origin:{ad:AD_A,source:'fb'}}),
  // P9 : inscription quiz par C le 2 sans mémoire, puis inscription masterclass le 4 dont le navigateur porte A datée du 1er : A est la plus ancienne origine mesurée.
  obs('quiz-p9-first','quiz',{person_id:'p9',at:'2026-09-02T08:00:00Z',origin:{ad:AD_C,source:'fb'}}),
  obs('mc-p9','forms',{person_id:'p9',at:'2026-09-04T11:00:00Z',origin:{ad:AD_B,source:'fb'},firstTouch:{ad:AD_A,source:'fb',tunnel:'quiz',at:'2026-09-01T12:00:00Z'}}),
  // P10 : deux inscriptions le même jour ; l'identifiant trie à l'envers de l'heure : c'est l'heure qui décide (F avant E).
  obs('quiz-p10-a','quiz',{person_id:'p10',at:'2026-09-10T09:00:00Z',origin:{ad:AD_E,source:'fb'}}),
  obs('quiz-p10-b','quiz',{person_id:'p10',at:'2026-09-10T07:00:00Z',origin:{ad:AD_F,source:'fb'}}),
  // P13 : première origine L avec horodatage invalide → datée de son inscription du 11 ; K (le 1er) reste la plus ancienne.
  obs('quiz-p13-first','quiz',{person_id:'p13',at:'2026-09-01T08:00:00Z',origin:{ad:AD_K,source:'fb'}}),
  obs('mc-p13','forms',{person_id:'p13',at:'2026-09-11T08:00:00Z',origin:{ad:AD_B,source:'fb'},firstTouch:{ad:AD_L,source:'fb',at:'not-a-date'}}),
  // P14 : même parcours mais première origine L datée du 20 août : L est la plus ancienne.
  obs('quiz-p14-first','quiz',{person_id:'p14',at:'2026-09-01T08:00:00Z',origin:{ad:AD_K,source:'fb'}}),
  obs('mc-p14','forms',{person_id:'p14',at:'2026-09-11T08:00:00Z',origin:{ad:AD_B,source:'fb'},firstTouch:{ad:AD_L,source:'fb',at:'2026-08-20T08:00:00Z'}}),
  // Clients Notion reliés aux personnes pour les ventes.
  obs('client-1','client_history',{external_id:'client-1',person_id:'p1',occurred_day:'2026-09-10'}),
  obs('client-2','client_history',{external_id:'client-2',person_id:'p2',occurred_day:'2026-09-11'}),
  ...extra,
 ];
 const ads=[
  {id:'ad-uuid-a',external_id:AD_A,campaign_id:'1201',adset_id:'2201',creative_id:'cr-a',ad_name:'Vidéo témoignage A',campaign_name:'Quizz Lead'},
  {id:'ad-uuid-b',external_id:AD_B,campaign_id:'1202',adset_id:'2202',creative_id:'cr-b',ad_name:'Vidéo B masterclass',campaign_name:'Masterclass'},
  {id:'ad-uuid-c',external_id:AD_C,campaign_id:'1201',adset_id:'2201',creative_id:null,ad_name:'Statique vestiaire C',campaign_name:'Quizz Lead'},
 ];
 const adDaily=[
  {id:'d1',ad_id:'ad-uuid-a',date:'2026-09-02',spend_minor:10000,impressions:5000,outbound_clicks:120},
  {id:'d2',ad_id:'ad-uuid-b',date:'2026-09-03',spend_minor:5000,impressions:2000,outbound_clicks:40},
  {id:'d3',ad_id:'ad-uuid-a',date:'2026-08-30',spend_minor:999,impressions:100,outbound_clicks:3},
 ];
 // Comme en production : la table rendez-vous porte status=unknown ; la présence vit dans prospects.business (classification Notion).
 const appointments=[
  {id:'appt-1',prospect_id:'prospect-1',scheduled_day:'2026-09-20',status:'unknown'},
  {id:'appt-1-old',prospect_id:'prospect-1',scheduled_day:'2026-10-05',status:'unknown'},
  {id:'appt-2',prospect_id:'prospect-2',scheduled_day:'2026-09-21',status:'unknown'},
  {id:'appt-3',prospect_id:'prospect-8',scheduled_day:'2026-09-22',status:'unknown'},
  {id:'appt-4',prospect_id:'prospect-none',scheduled_day:'2026-09-23',status:'no_show'},
  {id:'appt-5',prospect_id:'prospect-9',scheduled_day:'2026-09-24',status:'unknown'},
 ];
 const prospects=[
  {id:'prospect-1',person_id:'p1',business:business('2026-09-20','show_up')},
  {id:'prospect-2',person_id:'p2',business:business('2026-09-21','cancelled')},
  {id:'prospect-8',person_id:'p8',business:business('2026-09-22','no_show')},
  {id:'prospect-none',person_id:null,business:{}},
  {id:'prospect-9',person_id:'p9',business:business('2026-09-24','scheduled')},
 ];
 const linkRevisions=[{id:LINK,label:'Bio septembre',campaign:'rentree',tunnel:'quiz'}];
 const sales=[
  sale('pay-1',{clientIds:['client-1'],day:'2026-09-10',amountMinor:39000,state:'confirmed'}),
  sale('pay-2',{clientIds:['client-1'],day:'2026-09-25',amountMinor:39000,state:'excluded',reasons:['subsequent_payment_for_client']}),
  sale('pay-3',{clientIds:['client-1'],day:'2026-10-10',amountMinor:39000,state:'excluded',reasons:['subsequent_payment_for_client']}),
  sale('pay-4',{clientIds:['client-2'],day:'2026-09-12',amountMinor:10000,state:'excluded',reasons:['payment_refunded']}),
  sale('pay-5',{clientIds:[],day:'2026-09-13',amountMinor:12000,state:'pending',reasons:['client_relation_missing_or_ambiguous']}),
  sale('pay-6',{clientIds:['client-9'],day:'2026-09-14',amountMinor:15000,state:'reconciled'}),
 ];
 const commerce=commerceRows(sales);
 adDaily.forEach(row=>Object.assign(row,{currency:'EUR',currency_exponent:2,timezone:'Europe/Paris'}));
 commerce.runs.push({id:'notion-current',source:'notion',source_namespace:'notion',stream_key:'prospects_business',status:'complete',pagination_complete:true,rows_rejected:0,started_at:NOW,finished_at:NOW,source_as_of:NOW,covered_to:NOW});
 const tables:Record<string,Row[]>={lead_source_observations:observations,ads,v_ad_daily:adDaily,appointments,prospects,link_revisions:linkRevisions,sync_runs:commerce.runs,source_aggregates:commerce.aggregates};
 for(const [table,rows] of Object.entries(additions))tables[table]=[...(tables[table]??[]),...(rows??[])];
 const calls:{table:string;options:SelectOptions}[]=[];
 const db:Database={
  async select(table:TableName,options:SelectOptions={}){
   calls.push({table,options});
   let rows=tables[table]??[];
   for(const [k,v] of Object.entries(options.eq??{}))rows=rows.filter(r=>String(r[k])===String(v));
   for(const [k,values] of Object.entries(options.in??{}))rows=rows.filter(r=>values.includes(String(r[k])));
   for(const [k,v] of Object.entries(options.gte??{}))rows=rows.filter(r=>String(r[k])>=v);
   for(const [k,v] of Object.entries(options.lt??{}))rows=rows.filter(r=>String(r[k])<v);
   rows=rows.slice(options.from??0,(options.from??0)+(options.limit??1000));
   return options.columns?rows.map(r=>Object.fromEntries(options.columns!.map(c=>[c,r[c]]))):rows;
  },
  async upsert(){assert.fail('lecture seule');},async rpc(){assert.fail('aucun RPC');},async probe(){},
 };
 return {db,calls};
}
// Visites déjà regroupées par origine : quiz (accueil) et masterclass (/blank-1) ; 7 vues d'une version antérieure sans adresse.
const visits=foldVisits({quiz:[[AD_A,'','fb',100,130,40],['link_in_bio','','ig',5,6,0],['','','',3,3,0],[AD_B,'','fb',10,10,0]],masterclass:[[AD_B,'','fb',40,45,12],[AD_A,'','fb',2,2,2]]},{legacyMasterclassViews:7,observedAt:'2026-09-25T11:00:00Z'});
const period={from:'2026-09-01',to:'2026-09-30',tunnel:'all' as const};

test('A conserve le crédit : inscription par B après un premier passage A, rendez-vous, présence et ventes suivent la personne',async()=>{
 const {db}=fixture();const report=await buildAdFunnel(db,period,{env,visits,now:NOW});
 const rowA=report.rows.find(r=>r.adId===AD_A)!,rowB=report.rows.find(r=>r.adId===AD_B)!;
 assert.equal(rowA.label,'Vidéo témoignage A');assert.equal(rowA.creativeId,'cr-a');assert.deepEqual(rowA.linkIds,[LINK]);assert.deepEqual(rowA.links,[{id:LINK,label:'Bio septembre',campaign:'rentree'}]);
 assert.equal(rowA.registrations,4,'P1 (masterclass + réinscription quiz) et P9 (quiz puis masterclass)');assert.deepEqual(rowA.registrationsByTunnel,{quiz:2,masterclass:2});
 assert.equal(rowA.uniqueLeads,2,'P1 et P9 une seule fois chacun');assert.deepEqual(rowA.uniqueLeadsByTunnel,{quiz:1,masterclass:1});assert.equal(rowA.attributionBasis.firstTouch,4,'les quatre inscriptions portent l’origine A mesurée');
 assert.equal(rowB.registrations,0,'B n’est que l’arrivée');assert.equal(rowB.uniqueLeads,0);assert.equal(rowB.spendMinor,5000);assert.deepEqual(rowB.visitors,{quiz:10,masterclass:40});
 assert.equal(rowA.appointmentsBooked,2,'créneau du 20 (présent) et du 24 (issue non renseignée)');assert.equal(rowA.appointmentsAttended,1,'présence renseignée par la classification Notion, pas par la ligne rendez-vous ni par un clic');assert.equal(rowA.appointmentsUnknown,1);assert.equal(rowA.appointmentsNoShow,0);assert.equal(rowA.appointmentsUpcoming,0);
 assert.equal(rowA.leadsBooked,2,'P1 et P9 ont un créneau non annulé');
 assert.deepEqual(rowA.rates.booking,{value:1,numerator:2,denominator:2});assert.deepEqual(rowA.rates.attendance,{value:1,numerator:1,denominator:1});
 assert.deepEqual(rowA.visitors,{quiz:100,masterclass:2});assert.deepEqual(rowA.pageviews,{quiz:130,masterclass:2});assert.equal(rowA.visitorsWithFirstOrigin,42);
 assert.equal(rowA.rates.optin.value,null,'sans lecture des visiteurs entrés dans la période, aucun pourcentage d’opt-in');assert.match(rowA.rates.optin.reason!,/Visiteurs entrés dans la période non lus/);assert.equal(report.coverage.optin.available,false);
 assert.equal(rowA.firstSalesConfirmed,1,'trois mensualités = une vente');assert.equal(rowA.cashMinor,78000,'deux paiements encaissés dans la période');assert.equal(rowA.refundsMinor,0);
 assert.equal(rowA.spendMinor,10000,'dépense de la période seulement');assert.equal(rowA.outboundClicks,120);
 assert.equal(report.rows.find(r=>r.adId===AD_D),undefined,'la pub D vue à la réinscription ne reçoit aucun crédit');
 assert.ok(report.notices.some(n=>n.includes('7 vues de la masterclass sans adresse')),'les vues d’une version antérieure sont signalées, jamais comptées dans /blank-1');
 assert.equal(report.coverage.visits.observedAt,'2026-09-25T11:00:00Z');assert.equal(report.coverage.leads.withFirstTouch,4);assert.equal(report.coverage.leads.withVisitor,1);assert.equal(report.coverage.appointments.attendanceFromBusiness,4);
});

test('la plus ancienne origine datée gagne, entre tunnels et le même jour ; un horodatage invalide ne remonte pas le crédit',async()=>{
 const {db}=fixture();const report=await buildAdFunnel(db,period,{env,visits,now:NOW});
 const row=(ad:string)=>report.rows.find(r=>r.adId===ad);
 assert.equal(row(AD_F)!.registrations,2,'P10 : les deux inscriptions du 10 vont à F, arrivée de 7 h, malgré l’ordre des identifiants');assert.equal(row(AD_F)!.uniqueLeads,1);assert.equal(row(AD_E),undefined);
 assert.equal(row(AD_K)!.registrations,2,'P13 : L datée « not-a-date » vaut sa date d’inscription (11) ; K du 1er reste la plus ancienne');assert.equal(row(AD_K)!.uniqueLeads,1);
 assert.equal(row(AD_L)!.registrations,2,'P14 : L datée du 20 août précède K du 1er septembre');assert.equal(row(AD_L)!.uniqueLeads,1,'le lead de P14 (première inscription en septembre) est crédité à L');
 assert.equal(report.totals.uniqueLeads,8,'P1, P2, P5, P6, P9, P10, P13, P14');
});

test('créatives séparées, personne connue, identité non rapprochée, remboursement, vente en attente et rendez-vous sans personne restent distincts',async()=>{
 const {db}=fixture();const report=await buildAdFunnel(db,period,{env,visits,now:NOW});
 const rowC=report.rows.find(r=>r.adId===AD_C)!;
 assert.equal(rowC.creativeId,null);assert.equal(rowC.spendMinor,null,'aucune dépense publiée : indisponible, pas zéro');
 assert.equal(rowC.registrations,3,'P2, P3 et l’inscription non rapprochée');assert.equal(rowC.uniqueLeads,1,'P2 seulement');assert.equal(rowC.knownBefore,1,'P3 déjà client');assert.equal(rowC.unresolvedIdentity,1);
 assert.equal(rowC.appointmentsCancelled,1);assert.equal(rowC.appointmentsBooked,0);assert.equal(rowC.leadsBooked,0,'un créneau annulé n’est pas une réservation');
 assert.equal(rowC.uniqueRegistrants,2,'P2 et P3 sont deux personnes inscrites uniques ; l’identité non rapprochée reste hors dénominateur');
 assert.deepEqual(rowC.rates.booking,{value:0,numerator:0,denominator:2});assert.equal(rowC.rates.optin.value,null);assert.ok(rowC.rates.optin.reason);
 assert.equal(rowC.refundsMinor,10000);assert.equal(rowC.cashMinor,0);assert.equal(rowC.firstSalesConfirmed,0);
 const organic=report.rows.find(r=>r.kind==='organic')!;assert.equal(organic.registrations,1);assert.equal(organic.uniqueLeads,1);assert.deepEqual(organic.visitors,{quiz:5,masterclass:0});
 const unattributed=report.rows.find(r=>r.key===UNATTRIBUTED)!;assert.equal(unattributed.registrations,1,'arrivée directe : non attribué, jamais zéro');assert.equal(unattributed.appointmentsBooked,1,'RDV d’une personne sans inscription');assert.equal(unattributed.appointmentsNoShow,1);assert.deepEqual(unattributed.rates.attendance,{value:0,numerator:0,denominator:1});assert.deepEqual(unattributed.visitors,{quiz:3,masterclass:0});
 const unresolved=report.rows.find(r=>r.key===UNRESOLVED)!;assert.equal(unresolved.appointmentsBooked,1,'prospect sans personne');assert.equal(unresolved.appointmentsNoShow,1,'statut de la ligne rendez-vous quand la classification manque');assert.equal(unresolved.firstSalesPending,1,'vente sans client rattaché');assert.equal(unresolved.firstSalesReconciled,1,'client sans personne connue');
 assert.equal(report.totals.registrations,report.rows.reduce((s,r)=>s+r.registrations,0));assert.equal(report.totals.cashMinor,report.rows.reduce((s,r)=>s+(r.cashMinor??0),0));assert.equal(report.totals.appointmentsAttended,1);assert.equal(report.totals.appointmentsNoShow,2);
 assert.deepEqual(report.totals.rates.attendance,{value:1/3,numerator:1,denominator:3});assert.deepEqual(report.totals.visitors,{quiz:118,masterclass:42});
 assert.equal(report.rows[0].adId,AD_A,'publicités triées par dépense');assert.equal(report.rows.at(-1)!.kind,'unattributed');
 assert.equal(report.coverage.meta.lastDay,'2026-09-03');assert.equal(report.coverage.commerce.clientsUnlinked,2);
});

test('les dates restent distinctes : visite, inscription, rendez-vous (à venir à part) et encaissement se lisent chacun dans leur période',async()=>{
 const {db}=fixture();
 const october=await buildAdFunnel(db,{from:'2026-10-01',to:'2026-10-31',tunnel:'all'},{env,visits:null,now:NOW});
 const rowA=october.rows.find(r=>r.adId===AD_A)!;
 assert.equal(rowA.registrations,0);assert.equal(rowA.appointmentsBooked,1,'créneau d’octobre');assert.equal(rowA.appointmentsUpcoming,1,'un rendez-vous futur n’est ni une présence ni une absence');assert.equal(rowA.rates.attendance.value,null);
 assert.equal(rowA.cashMinor,39000,'troisième mensualité encaissée en octobre');assert.equal(rowA.firstSalesConfirmed,0,'la vente a déjà été comptée en septembre');
 assert.ok(october.notices.some(n=>n.includes('PostHog')),'panne de source visible');assert.equal(rowA.visitors.quiz,null);assert.equal(rowA.rates.optin.value,null);assert.match(rowA.rates.optin.reason!,/Visiteurs entrés dans la période non lus/);
 const august=await buildAdFunnel(db,{from:'2026-08-01',to:'2026-08-31',tunnel:'all'},{env,visits:null,now:NOW});
 assert.equal(august.rows.find(r=>r.adId===AD_A)!.uniqueLeads,1,'P7 acquis en août');assert.equal(august.rows.find(r=>r.adId===AD_A)!.spendMinor,999);
});

test('rendez-vous : scheduled_at sans scheduled_day est lu au jour de Paris, sans inventer une date absente',async()=>{
 const extra=[obs('quiz-paris-slot','quiz',{person_id:'paris-slot',at:'2026-09-08T09:00:00Z',origin:{ad:AD_H,source:'fb'}})];
 const additions={appointments:[
  {id:'appt-paris-slot',prospect_id:'prospect-paris-slot',scheduled_at:'2026-09-09T22:30:00.000Z',scheduled_day:null,status:'unknown'},
  {id:'appt-undated-slot',prospect_id:'prospect-paris-slot',scheduled_at:null,scheduled_day:null,status:'scheduled'},
 ],prospects:[{id:'prospect-paris-slot',person_id:'paris-slot',business:business('2026-09-10','show_up')}]};
 const report=await buildAdFunnel(fixture(extra,additions).db,{from:'2026-09-10',to:'2026-09-10',tunnel:'all'},{env,visits:null,now:NOW});
 const row=report.rows.find(r=>r.adId===AD_H)!;
 assert.equal(row.appointmentsBooked,1,'22 h 30 UTC le 9 septembre est le 10 septembre à Paris');assert.equal(row.appointmentsAttended,1,'la présence commerciale reste reliée au même jour Paris');
 assert.equal(report.coverage.appointments.rows,8,'le créneau sans date reste lu mais ne reçoit pas de jour inventé');
});

test('recette : les inscriptions explicitement marquées et leurs rendez-vous dérivés sont exclues par défaut',async()=>{
 const extra=[
  obs('quiz-test-only','quiz',{person_id:'test-only',at:'2026-09-08T09:00:00Z',origin:{ad:AD_H,source:'test',campaign:'test-mehdi-rdv'}}),
  obs('quiz-real','quiz',{person_id:'real-after-test',at:'2026-09-08T10:00:00Z',origin:{ad:AD_H,source:'facebook',campaign:'testimonial-septembre'}}),
 ];
 const additions={appointments:[
  {id:'appt-test-only',prospect_id:'prospect-test-only',scheduled_day:'2026-09-10',status:'scheduled'},
  {id:'appt-real',prospect_id:'prospect-real',scheduled_day:'2026-09-10',status:'scheduled'},
 ],prospects:[
  {id:'prospect-test-only',person_id:'test-only',business:business('2026-09-10','scheduled')},
  {id:'prospect-real',person_id:'real-after-test',business:business('2026-09-10','scheduled')},
 ]};
 const hidden=await buildAdFunnel(fixture(extra,additions).db,{from:'2026-09-01',to:'2026-09-30',tunnel:'all'},{env,visits:null,now:NOW});
 const visible=await buildAdFunnel(fixture(extra,additions).db,{from:'2026-09-01',to:'2026-09-30',tunnel:'all',includeTests:true},{env,visits:null,now:NOW});
 const hiddenRow=hidden.rows.find(r=>r.adId===AD_H)!,visibleRow=visible.rows.find(r=>r.adId===AD_H)!;
 assert.equal(hiddenRow.registrations,1);assert.equal(hiddenRow.appointmentsBooked,1,'le rendez-vous du contact de recette ne fuit pas dans le tunnel');
 assert.equal(hidden.coverage.testing.registrationsExcluded,1);assert.equal(hidden.coverage.testing.appointmentsExcluded,1);assert.equal(hidden.filters.includeTests,false);
 assert.equal(visibleRow.registrations,2);assert.equal(visibleRow.appointmentsBooked,2);assert.equal(visible.coverage.testing.registrationsExcluded,0);assert.equal(visible.filters.includeTests,true);
});

test('filtre tunnel : le quiz ne compte ni les inscriptions ni les visiteurs masterclass ; les lectures restent bornées',async()=>{
 const {db,calls}=fixture();const report=await buildAdFunnel(db,{...period,tunnel:'quiz'},{env,visits,now:NOW});
 const rowA=report.rows.find(r=>r.adId===AD_A)!;
 assert.equal(rowA.registrations,2,'réinscription quiz de P1 et première inscription quiz de P9');assert.equal(rowA.uniqueLeads,1,'P9 entre par le quiz ; le lead P1 vient de la masterclass');
 assert.deepEqual(rowA.visitors,{quiz:100,masterclass:null});
 assert.equal(rowA.appointmentsBooked,1,'seul le créneau de P9 (entré par le quiz) reste');
 assert.ok(calls.some(c=>c.table==='prospects'&&c.options.limit===1000&&c.options.columns?.includes('business')),'prospects lus par lot avec leur classification');
 assert.ok(calls.some(c=>c.table==='v_ad_daily'&&c.options.gte?.date==='2026-09-01'&&c.options.lt?.date==='2026-10-01'));
 await assert.rejects(()=>buildAdFunnel(db,{from:'2026-09-30',to:'2026-09-01',tunnel:'all'},{env}),/AD_FUNNEL_INVALID_PERIOD/);
});

test('réservation : une personne déjà connue reste dans les inscrits uniques et compte si elle a un rendez-vous non annulé',async()=>{
 const extra=[
  obs('quiz-known-booked','quiz',{person_id:'known-booked',at:'2026-09-08T09:00:00Z',origin:{ad:AD_H,source:'fb'}}),
  obs('client-known-booked','client_history',{external_id:'client-known-booked',person_id:'known-booked',occurred_day:'2025-01-01'}),
 ];
 const additions={appointments:[{id:'appt-known-booked',prospect_id:'prospect-known-booked',scheduled_day:'2026-10-10',status:'scheduled'}],prospects:[{id:'prospect-known-booked',person_id:'known-booked',business:{scheduledDay:'2026-10-10',attendance:'scheduled'}}]};
 const report=await buildAdFunnel(fixture(extra,additions).db,period,{env,visits,now:NOW});const row=report.rows.find(r=>r.adId===AD_H)!;
 assert.equal(row.knownBefore,1);assert.equal(row.uniqueLeads,0,'une personne déjà connue ne redevient pas un nouveau lead');assert.equal(row.uniqueRegistrants,1);
 assert.equal(row.leadsBooked,1,'son rendez-vous non annulé compte parmi les inscrits réservés');assert.deepEqual(row.rates.booking,{value:1,numerator:1,denominator:1});
});

test('filtres source et campagne : publicité, créative, campagne Meta et lien cockpit ; totaux recalculés sur les lignes visibles',async()=>{
 const {db}=fixture();
 const paid=await buildAdFunnel(db,{...period,source:'paid'},{env,visits,now:NOW});
 assert.ok(paid.rows.every(r=>r.kind==='ad'));assert.equal(paid.totals.uniqueLeads,6,'sans organique ni direct');
 const organic=await buildAdFunnel(db,{...period,source:'organic'},{env,visits,now:NOW});assert.deepEqual(organic.rows.map(r=>r.key),[ORGANIC]);
 const byAd=await buildAdFunnel(db,{...period,campaign:`meta-ad:${AD_C}`},{env,visits,now:NOW});assert.deepEqual(byAd.rows.map(r=>r.adId),[AD_C]);assert.equal(byAd.totals.registrations,3);
 const byCampaign=await buildAdFunnel(db,{...period,campaign:'meta:1201'},{env,visits,now:NOW});assert.deepEqual(byCampaign.rows.map(r=>r.adId).sort(),[AD_A,AD_C].sort(),'A et C via le catalogue Meta');
 const byCreative=await buildAdFunnel(db,{...period,campaign:'meta-creative:cr-b'},{env,visits,now:NOW});assert.deepEqual(byCreative.rows.map(r=>r.adId),[AD_B]);
 const byLink=await buildAdFunnel(db,{...period,campaign:'link:rentree'},{env,visits,now:NOW});assert.deepEqual(byLink.rows.map(r=>r.adId),[AD_A]);
 const none=await buildAdFunnel(db,{...period,campaign:'link:inconnue'},{env,visits,now:NOW});assert.equal(none.rows.length,0);assert.equal(none.totals.registrations,0);assert.equal(none.filters.campaign,'link:inconnue');
});

test('origine d’une inscription, clé de ligne, issue d’un créneau et requêtes PostHog bornées',()=>{
 assert.equal(observationOrigin({origin:{ad:AD_B},firstTouch:{ad:AD_A}}).adId,AD_A);
 assert.equal(observationOrigin({origin:{ad:AD_B},firstTouch:{}}).basis,'arrival');
 assert.equal(observationOrigin({origin:{ad:'not-numeric',source:'ig'},firstTouch:null}).source,'ig');
 assert.equal(observationOrigin({origin:{},firstTouch:null}).basis,'none');
 assert.equal(originKeyFor({adId:AD_A,linkId:LINK}),'ad:'+AD_A);assert.equal(originKeyFor({linkId:LINK}),'link:'+LINK);assert.equal(originKeyFor({source:'ig'}),ORGANIC);assert.equal(originKeyFor({}),UNATTRIBUTED);
 assert.equal(appointmentOutcome({status:'unknown'},business('2026-09-20','show_up'),'2026-09-20'),'attended');
 assert.equal(appointmentOutcome({status:'unknown'},business('2026-09-19','show_up'),'2026-09-20'),'unknown','la classification date un autre créneau');
 assert.equal(appointmentOutcome({status:'no_show'},null,'2026-09-20'),'no_show');assert.equal(appointmentOutcome({status:'rescheduled'},null,'2026-09-20'),'rescheduled');
 const q=visitQueries('2026-09-01','2026-09-30',{POSTHOG_QUIZ_HOST:"quizz.blg-studio.fr,evil'; DROP"});
 assert.match(q.quiz,/'quizz\.blg-studio\.fr','evilDROP'/);assert.match(q.quiz,/toDateTime\('2026-10-01 00:00:00','Europe\/Paris'\)/);assert.match(q.quiz,/premiere_utm_content/);assert.match(q.quiz,/GROUP BY visitor/);
 assert.match(q.masterclass,/mc_page_view/);assert.match(q.masterclass,/page_path\),''\) IN \('\/masterclass26','\/blank-1'\)/,'adresse publiée en actif, ancienne adresse reconnue');assert.match(q.masterclass,/first_origin/);assert.match(q.legacyMasterclass,/page_path\),''\)=''/);
 assert.match(q.quizCohort,/min\(timestamp\) AS first_seen/);assert.match(q.quizCohort,/argMinIf\(f_ad_row, timestamp, has_first=1\)/,'la première valeur A datée est déterministe');assert.doesNotMatch(q.quizCohort,/anyIf\(f_ad_row/);assert.match(q.quizCohort,new RegExp(`LIMIT ${COHORT_LIMIT+1}`));assert.match(q.quizCohort,/first_seen >= toDateTime\('2026-09-01 00:00:00','Europe\/Paris'\)/);assert.doesNotMatch(q.quizCohort,/timestamp >= toDateTime\('2026-09-01/,'la première visite se date sur toute l’histoire');assert.match(q.masterclassCohort,/joinable/);
 assert.equal(masterclassPagePath({}),'/masterclass26');assert.deepEqual(masterclassPagePaths({}),['/masterclass26','/blank-1']);assert.deepEqual(masterclassPagePaths({BLG_MASTERCLASS_URL:'https://www.blg-studio.fr/blank-1'}),['/blank-1']);assert.equal(masterclassPagePath({BLG_MASTERCLASS_URL:'https://www.blg-studio.fr/masterclass-rugby'}),'/masterclass-rugby');assert.equal(masterclassPagePath({BLG_MASTERCLASS_URL:'https://www.blg-studio.fr/a/b?x=1'}),'/masterclass26','adresse hors format : adresse publiée');
 assert.equal(parisDay('2026-08-31T22:30:00.000000Z'),'2026-09-01','22h30 UTC le 31 = 1er septembre à Paris');assert.equal(parisDay('2026-09-03 21:28:57'),'2026-09-03');assert.equal(parisDay('n/a'),null);
 const folded=foldVisits({quiz:[[AD_A,'','fb',3,4,1],['x',LINK.toUpperCase(),'',2,2,2]],masterclass:[]});
 assert.deepEqual(folded.byKey.get('ad:'+AD_A)!.quiz,{visitors:3,pageviews:4,withFirstOrigin:1});assert.deepEqual(folded.byKey.get('link:'+LINK)!.quiz,{visitors:2,pageviews:2,withFirstOrigin:2});
 const invalidVisits=foldVisits({quiz:[['','','',-1,1,0]],masterclass:[]});assert.equal(invalidVisits.available,false);assert.equal(invalidVisits.byKey.size,0,'un compteur invalide rend la mesure indisponible au lieu de produire un total partiel');
});

// ---------------------------------------------------------------------------------------------------------------------
// Opt-in par cohorte d'entrée : visiteurs mesurés (identifiant de navigateur) reliés à leurs inscriptions.
const cq=(id:string,person:string,at:string,visitor:string|null,ad:string,extra:Partial<Row>&{firstTouch?:Record<string,unknown>|null}={})=>obs(id,'quiz',{person_id:person,at,origin:{ad,source:'fb',...(visitor?{visitor}:{})},...extra});
function cohortObservations(withLater=false):Row[]{
 return [
  // Dix visiteurs entrés par la publicité E ; deux s'inscrivent (l'un deux fois : rechargement puis double soumission).
  cq('cq-01','c1','2026-09-03T10:00:00Z',vid(1),AD_E),
  cq('cq-02a','c2','2026-09-05T10:00:00Z',vid(2),AD_E),cq('cq-02b','c2','2026-09-06T08:00:00Z',vid(2),AD_E),
  // Visiteur entré le 31 août, inscrit le 1er septembre : il appartient à la cohorte d'août.
  cq('cq-11','c11','2026-09-01T09:00:00Z',vid(11),AD_E),
  // Visiteur entré le 2 septembre à 18 h (C) mais inscription à 9 h : antérieure à sa première visite, jamais comptée.
  cq('cq-12','c12','2026-09-02T09:00:00Z',vid(12),AD_C),
  // Inscription sans identifiant de navigateur sur E : visible, hors calcul.
  cq('cq-20','c20','2026-09-12T09:00:00Z',null,AD_E),
  // Visiteur déjà client (c13) : passage A sur le quiz le 3, retour B sur la masterclass le 6 et inscription là : opt-in crédité à A, pas un nouveau lead.
  obs('cm-13','forms',{person_id:'c13',at:'2026-09-06T12:00:00Z',origin:{ad:AD_B,source:'fb',visitor:vid(13)},firstTouch:{ad:AD_A,source:'fb',tunnel:'quiz',at:'2026-09-03T09:00:00Z'}}),
  obs('client-13','client_history',{external_id:'client-13',person_id:'c13',occurred_day:'2025-02-01'}),
  // Visiteur G entré le 20 septembre ; son inscription du 2 octobre n'existe qu'à la lecture ultérieure.
  ...(withLater?[cq('cq-15','c15','2026-10-02T10:00:00Z',vid(15),AD_G)]:[]),
 ];
}
const quizCohortRows:CohortRow[]=[
 ...Array.from({length:10},(_,i):CohortRow=>[vid(i+1),1,`2026-09-${String(i+2).padStart(2,'0')}T10:00:00Z`,AD_E,'','fb']),
 ['ph-anon-1',0,'2026-09-04T10:00:00Z',AD_E,'','fb'],['ph-anon-2',0,'2026-09-04T11:00:00Z',AD_E,'','fb'],['ph-anon-3',0,'2026-09-05T10:00:00Z',AD_E,'','fb'],
 [vid(12),1,'2026-09-02T18:00:00Z',AD_C,'','fb'],
 [vid(13),1,'2026-09-03T09:00:00Z',AD_A,'','fb'],
 [vid(15),1,'2026-09-20T10:00:00Z',AD_G,'','fb'],
];
const masterclassCohortRows:CohortRow[]=[[vid(13),1,'2026-09-06T11:00:00Z',AD_A,'','fb'],[vid(14),1,'2026-09-10T10:00:00Z',AD_B,'','fb']];
const septemberCohort=()=>foldVisitorCohort({quiz:quizCohortRows,masterclass:masterclassCohortRows},{observedAt:'2026-10-05T12:00:00Z'});
const augustCohort=()=>foldVisitorCohort({quiz:[[vid(11),1,'2026-08-31T10:00:00Z',AD_E,'','fb']],masterclass:[]},{observedAt:'2026-10-05T12:00:00Z'});
const LATER='2026-10-05T12:00:00Z';

test('opt-in : dix visiteurs mesurés, deux inscrits → 20 % avec compteurs ; double soumission et rechargement comptent une fois ; sans identifiant hors calcul',async()=>{
 const {db}=fixture(cohortObservations());const report=await buildAdFunnel(db,period,{env,visits,cohort:septemberCohort(),now:LATER});
 const rowE=report.rows.find(r=>r.adId===AD_E)!;
 assert.deepEqual(rowE.optin.quiz,{visitors:10,registered:2});assert.deepEqual(rowE.optin.masterclass,{visitors:0,registered:0});
 assert.deepEqual(rowE.optin.all,{visitors:10,registered:2,newLeads:2,knownPeople:0,unresolvedIdentity:0});
 assert.deepEqual(rowE.rates.optin,{value:0.2,numerator:2,denominator:10},'20 % : deux des dix visiteurs entrés en septembre se sont inscrits');
 assert.deepEqual(rowE.optin.unlinkableVisitors,{quiz:3,masterclass:0},'trois visiteurs sans identifiant de navigateur : couverture, pas dénominateur');
 assert.equal(rowE.optin.registrationsWithoutVisitor,1,'l’inscription sans identifiant reste visible, hors calcul');assert.equal(rowE.optin.registrationsOutsideCohort,1,'l’inscription du 1er septembre d’un visiteur entré en août n’est pas un numérateur flottant');
 assert.equal(rowE.registrations,5,'les inscriptions restent comptées en volume (c1, c2 ×2, c11, c20)');assert.equal(rowE.uniqueLeads,4,'nouveaux leads (c1, c2, c11, c20) : compteur distinct de l’opt-in');
 assert.equal(report.coverage.optin.available,true);assert.equal(report.coverage.optin.observedAt,LATER);assert.deepEqual(report.coverage.optin.entryPeriod,{from:'2026-09-01',to:'2026-09-30'});
 assert.equal(report.coverage.optin.visitorsLinkable,14,'un visiteur compte une fois même vu sur les deux tunnels');assert.equal(report.coverage.optin.visitorsUnlinkable,3);
});

test('opt-in : visite du 31 août puis inscription du 1er septembre → cohorte d’août ; inscription antérieure le même jour jamais comptée',async()=>{
 const {db}=fixture(cohortObservations());
 const august=await buildAdFunnel(db,{from:'2026-08-01',to:'2026-08-31',tunnel:'all'},{env,visits:null,cohort:augustCohort(),now:LATER});
 const rowE=august.rows.find(r=>r.adId===AD_E)!;
 assert.deepEqual(rowE.optin.quiz,{visitors:1,registered:1},'le visiteur entré le 31 août est inscrit le 1er septembre : il compte dans la cohorte d’août à la lecture d’octobre');
 assert.deepEqual(rowE.rates.optin,{value:1,numerator:1,denominator:1});assert.equal(rowE.registrations,0,'l’inscription elle-même est datée de septembre');
 const september=await buildAdFunnel(db,period,{env,visits,cohort:septemberCohort(),now:LATER});
 const rowC=september.rows.find(r=>r.adId===AD_C)!;
 assert.deepEqual(rowC.optin.quiz,{visitors:1,registered:0},'inscription du 2 à 9 h avant la première visite du 2 à 18 h : le visiteur n’est pas inscrit dans sa cohorte');assert.equal(rowC.optin.registrationsOutsideCohort,1);
 assert.deepEqual(rowC.rates.optin,{value:0,numerator:0,denominator:1},'0 % mesuré, pas un tiret');
});

test('opt-in : visiteur déjà connu, passage quiz → masterclass, crédit A malgré l’arrivée B, aucun double compte entre tunnels et dans les totaux',async()=>{
 const {db}=fixture(cohortObservations());
 const all=await buildAdFunnel(db,period,{env,visits,cohort:septemberCohort(),now:LATER});
 const rowA=all.rows.find(r=>r.adId===AD_A)!,rowB=all.rows.find(r=>r.adId===AD_B)!;
 assert.deepEqual(rowA.optin.quiz,{visitors:1,registered:0},'sur le quiz, le visiteur c13 n’a pas laissé d’inscription');
 assert.deepEqual(rowA.optin.masterclass,{visitors:1,registered:1},'sur la masterclass, il s’inscrit : crédité à A (première origine), pas à B (arrivée)');
 assert.deepEqual(rowA.optin.all,{visitors:1,registered:1,newLeads:0,knownPeople:1,unresolvedIdentity:0},'un seul visiteur au total ; déjà client → opt-in sans nouveau lead');
 assert.deepEqual(rowA.rates.optin,{value:1,numerator:1,denominator:1});
 assert.deepEqual(rowB.optin.masterclass,{visitors:1,registered:0},'B ne reçoit que son propre visiteur sans inscription');
 assert.deepEqual(all.totals.optin.all,{visitors:14,registered:3,newLeads:2,knownPeople:1,unresolvedIdentity:0},'totaux sur des visiteurs uniques : 14 entrés, 3 inscrits');
 assert.deepEqual(all.totals.optin.quiz,{visitors:13,registered:2});assert.deepEqual(all.totals.optin.masterclass,{visitors:2,registered:1});
 assert.deepEqual(all.totals.rates.optin,{value:3/14,numerator:3,denominator:14});
 assert.equal(all.coverage.optin.registrationsInCohort,4,'cq-01, cq-02a, cq-02b, cm-13 relient une inscription de septembre à un visiteur de la cohorte');
 const quiz=await buildAdFunnel(db,{...period,tunnel:'quiz'},{env,visits,cohort:septemberCohort(),now:LATER});
 assert.deepEqual(quiz.rows.find(r=>r.adId===AD_A)!.rates.optin,{value:0,numerator:0,denominator:1},'filtre quiz : le groupe et le résultat sont ceux du quiz');
 assert.deepEqual(quiz.totals.rates.optin,{value:2/13,numerator:2,denominator:13});const quizB=quiz.rows.find(r=>r.adId===AD_B)!;assert.equal(quizB.optin.masterclass,null,'sous le filtre quiz, la cohorte masterclass n’est pas lue');assert.deepEqual(quizB.optin.quiz,{visitors:0,registered:0},'B n’a aucun visiteur raccordable entré par le quiz');assert.equal(quizB.rates.optin.value,null);
 const masterclass=await buildAdFunnel(db,{...period,tunnel:'masterclass'},{env,visits,cohort:septemberCohort(),now:LATER});
 assert.deepEqual(masterclass.totals.rates.optin,{value:1/2,numerator:1,denominator:2});assert.deepEqual(masterclass.rows.find(r=>r.adId===AD_A)!.optin.masterclass,{visitors:1,registered:1});
});

test('opt-in : la statistique se complète avec le temps ; période d’entrée et date de lecture explicites ; lecture tronquée ou absente → indisponible',async()=>{
 const before=await buildAdFunnel(fixture(cohortObservations(false)).db,period,{env,visits,cohort:septemberCohort(),now:'2026-09-25T12:00:00Z'});
 const after=await buildAdFunnel(fixture(cohortObservations(true)).db,period,{env,visits,cohort:septemberCohort(),now:LATER});
 assert.deepEqual(before.rows.find(r=>r.adId===AD_G)!.optin.quiz,{visitors:1,registered:0});assert.equal(before.coverage.optin.observedAt,'2026-09-25T12:00:00Z');
 assert.deepEqual(after.rows.find(r=>r.adId===AD_G)!.optin.quiz,{visitors:1,registered:1},'l’inscription du 2 octobre complète la cohorte de septembre à la lecture du 5 octobre');
 assert.deepEqual(after.totals.optin.all,{visitors:14,registered:4,newLeads:3,knownPeople:1,unresolvedIdentity:0});assert.deepEqual(after.totals.rates.optin,{value:4/14,numerator:4,denominator:14});
 const truncated=foldVisitorCohort({quiz:Array.from({length:COHORT_LIMIT+1},(_,i):CohortRow=>[vid(i+100),1,'2026-09-02T10:00:00Z',AD_E,'','fb']),masterclass:[]});
 assert.equal(truncated.available,false);assert.match(truncated.reason!,/réduire la période/);assert.equal(truncated.visitors.length,0);
 const unavailable=await buildAdFunnel(fixture(cohortObservations()).db,period,{env,visits,cohort:truncated,now:LATER});
 assert.equal(unavailable.rows.find(r=>r.adId===AD_E)!.rates.optin.value,null);assert.match(unavailable.rows.find(r=>r.adId===AD_E)!.rates.optin.reason!,/réduire la période/);assert.equal(unavailable.coverage.optin.visitorsLinkable,null);
 const folded=foldVisitorCohort({quiz:[[vid(1),1,'2026-09-02T10:00:00Z',AD_E,'','fb'],['ph-anon',0,'2026-09-02T10:00:00Z','','','ig'],[vid(2),1,'not-a-date',AD_E,'','fb']],masterclass:[]});
 assert.equal(folded.available,false,'un horodatage illisible rend la cohorte indisponible au lieu de sous-compter le dénominateur');assert.equal(folded.visitors.length,0);assert.equal(folded.unlinkable.size,0);
});

test('reports : un créneau reporté reste distinct et ne devient une réservation active que si un autre créneau existe',async()=>{
 const extra=[obs('quiz-reported','quiz',{person_id:'reported',at:'2026-09-08T09:00:00Z',origin:{ad:AD_H,source:'fb'}})];
 const additions={appointments:[
  {id:'appt-reported-old',prospect_id:'prospect-reported',scheduled_day:'2026-09-10',status:'rescheduled'},
  {id:'appt-reported-new',prospect_id:'prospect-reported',scheduled_day:'2026-10-10',status:'scheduled'},
 ],prospects:[{id:'prospect-reported',person_id:'reported',business:{scheduledDay:'2026-10-10',attendance:'scheduled'}}]};
 const september=await buildAdFunnel(fixture(extra,additions).db,period,{env,visits,now:NOW});const row=september.rows.find(r=>r.adId===AD_H)!;
 assert.equal(row.appointmentsRescheduled,1);assert.equal(row.appointmentsBooked,0,'le créneau remplacé ne devient pas un rendez-vous actif de septembre');assert.equal(row.leadsBooked,1,'le nouveau créneau conserve la réservation de la personne');assert.deepEqual(row.rates.attendance,{value:null,numerator:0,denominator:0,reason:'Aucun rendez-vous passé à issue connue sur cette ligne pour la période.'});
});

test('filtres : une ligne portée seulement par PostHog garde son lien, sa campagne et la dépense de son tunnel',async()=>{
 const linkVisits=foldVisits({quiz:[['',LINK,'',4,5,4]],masterclass:[[AD_B,'','fb',7,8,3]]});
 const linkCohort=foldVisitorCohort({quiz:[[vid(30),1,'2026-09-02T08:00:00+02:00','',LINK,'']],masterclass:[]},{observedAt:LATER});
 const byLink=await buildAdFunnel(fixture().db,{...period,campaign:'link:rentree'},{env,visits:linkVisits,cohort:linkCohort,now:LATER});
 const linkOnly=byLink.rows.find(r=>r.key==='link:'+LINK)!;assert.ok(linkOnly,'la ligne de visites sans inscription reste visible sous le filtre du lien');assert.deepEqual(linkOnly.links,[{id:LINK,label:'Bio septembre',campaign:'rentree'}]);assert.deepEqual(byLink.totals.rates.optin,{value:0,numerator:0,denominator:1});
 const masterclass=await buildAdFunnel(fixture().db,{...period,tunnel:'masterclass'},{env,visits:linkVisits,now:LATER});
 assert.equal(masterclass.rows.find(r=>r.adId===AD_B)!.spendMinor,5000,'la dépense reste visible quand l’activité du tunnel vient seulement des visites');
});

test('personnes : réinscription et contact plus tôt le même jour restent connus ; un visiteur partagé par deux identités reste conflictuel',async()=>{
 const visitorKnown=vid(40),visitorConflict=vid(41);
 const extra=[
  obs('known-old','quiz',{person_id:'known-repeat',at:'2026-08-15T09:00:00Z',origin:{ad:AD_H,source:'fb'}}),
  obs('known-repeat','quiz',{person_id:'known-repeat',at:'2026-09-08T09:00:00Z',origin:{ad:AD_H,source:'fb'}}),
  obs('same-day-before','quiz',{person_id:'known-same-day',at:'2026-09-09T07:00:00Z',origin:{ad:AD_H,source:'fb'}}),
  obs('same-day-after','quiz',{person_id:'known-same-day',at:'2026-09-09T11:00:00Z',origin:{ad:AD_H,source:'fb',visitor:visitorKnown}}),
  obs('conflict-one','quiz',{person_id:'conflict-one',at:'2026-09-10T11:00:00Z',origin:{ad:AD_H,source:'fb',visitor:visitorConflict}}),
  obs('conflict-two','quiz',{person_id:'conflict-two',at:'2026-09-10T12:00:00Z',origin:{ad:AD_H,source:'fb',visitor:visitorConflict}}),
 ];
 const cohort=foldVisitorCohort({quiz:[[visitorKnown,1,'2026-09-09T10:00:00Z',AD_H,'','fb'],[visitorConflict,1,'2026-09-10T10:00:00Z',AD_H,'','fb']],masterclass:[]},{observedAt:LATER});
 const report=await buildAdFunnel(fixture(extra).db,period,{env,visits,cohort,now:LATER});const row=report.rows.find(r=>r.adId===AD_H)!;
 assert.equal(row.uniqueLeads,3,'le contact du matin et les deux identités du navigateur conflictuel commencent dans la période');assert.equal(row.knownBefore,1,'la réinscription historique reste distincte des nouveaux leads');
 assert.deepEqual(row.optin.all,{visitors:2,registered:2,newLeads:0,knownPeople:1,unresolvedIdentity:1},'le visiteur partagé n’est attribué à aucune des deux identités');
});

test('commerce absent : ventes, encaissements et remboursements restent indisponibles, jamais transformés en zéros',async()=>{
 const report=await buildAdFunnel(fixture().db,period,{env:{WIX_SITE_ID:SITE},visits,now:NOW});const row=report.rows.find(r=>r.adId===AD_A)!;
 assert.equal(report.coverage.commerce.available,false);assert.ok(report.coverage.commerce.reason);assert.equal(report.coverage.commerce.paidSaleRows,null);assert.equal(report.coverage.commerce.moneyRowsUnavailable,null);
 assert.equal(row.firstSalesConfirmed,null);assert.equal(row.cashMinor,null);assert.equal(row.refundsMinor,null);assert.equal(report.totals.firstSalesConfirmed,null);assert.equal(report.totals.cashMinor,null);assert.equal(report.totals.refundsMinor,null);
});


test('les reprises et les imports incomplets ne sont jamais additionnés aux dépenses publiées',async()=>{
 const {db,calls}=fixture([],{ad_daily:[{id:'stale-copy',ad_id:'ad-uuid-a',date:'2026-09-03',spend_minor:999999,impressions:999999,outbound_clicks:999999}]});
 const report=await buildAdFunnel(db,{from:'2026-09-01',to:'2026-09-30',tunnel:'all'},{env});
 assert.equal(report.rows.find(r=>r.adId===AD_A)?.spendMinor,10000);
 assert.ok(calls.some(c=>c.table==='v_ad_daily'));
 assert.ok(!calls.some(c=>c.table==='ad_daily'));
});

test('une publicité au catalogue sans activité reste visible avec des mesures indisponibles',async()=>{
 const id='12345678909999';
 const {db}=fixture([],{ads:[{id:'catalog-only',external_id:id,ad_name:'Sans activité',campaign_id:'12345678908888',creative_id:'12345678907777'}]});
 const report=await buildAdFunnel(db,{from:'2026-09-01',to:'2026-09-30',tunnel:'all'},{env});
 const row=report.rows.find(r=>r.adId===id)!;
 assert.equal(row.label,'Sans activité');assert.equal(row.creativeId,'12345678907777');
 assert.equal(row.spendMinor,null);assert.equal(row.impressions,null);assert.equal(row.outboundClicks,null);
 const quiz=await buildAdFunnel(db,{from:'2026-09-01',to:'2026-09-30',tunnel:'quiz'},{env});
 assert.ok(!quiz.rows.some(r=>r.adId===id),'aucun tunnel inféré du catalogue');
});

test('une mesure Meta absente ne devient zéro ni dans la ligne ni dans le total',async()=>{
 const {db}=fixture([],{v_ad_daily:[{currency:'EUR',currency_exponent:2,timezone:'Europe/Paris',id:'missing-measure',ad_id:'ad-uuid-a',date:'2026-09-04',spend_minor:null,impressions:12,outbound_clicks:null}]});
 const report=await buildAdFunnel(db,{from:'2026-09-01',to:'2026-09-30',tunnel:'all'},{env});
 const row=report.rows.find(r=>r.adId===AD_A)!;
 assert.equal(row.spendMinor,null);assert.equal(row.outboundClicks,null);
 assert.equal(report.totals.spendMinor,null);assert.equal(report.totals.outboundClicks,null);
 assert.ok(report.notices.some(n=>n.includes('Certaines mesures Meta')));
});
