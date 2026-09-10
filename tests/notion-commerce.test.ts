import test from 'node:test';
import assert from 'node:assert/strict';
import {buildNotionCommerceReport} from '../src/lib/notion-commerce-report';
import {normalizeNotionCommerce,readNotionCommerceSnapshot,notionCommerceConfig,notionCommerceProfile,type CommerceReadCheckpoint} from '../src/connectors/notion-commerce';
import {emailIdentity} from '../src/domain/identity';
import {commerceConfig,client,payment,parcours,snapshot} from './commerce-fixtures';
const secret='synthetic-secret-used-only-for-fixtures';
test('first declaration is global, duplicate Client identities and repeat declarations do not become new acquisitions',()=>{
 const report=buildNotionCommerceReport(snapshot({clients:[client(),client('copy',{emailKey:'identity-client-a'})],parcours:[parcours(),parcours('again',{clientIds:['copy'],startDay:'2025-04-01'}),parcours('repeat',{order:2,startDay:'2025-05-01'})]}));
 assert.equal(report.totals.firstClientsDeclared,1);assert.equal(report.totals.parcoursDeclared,3);assert.equal(report.totals.repeatParcours,1);assert.equal(report.members.find(m=>m.parcoursId==='again')!.earlierParcours,true);assert.equal(report.members.find(m=>m.parcoursId==='again')!.firstPaymentDay,'2024-02-03');
});
test('first accompaniment counts dated Client records, never merges a binome from a shared email and excludes a future start',()=>{
 const report=buildNotionCommerceReport(snapshot({observedAt:'2024-03-04T12:00:00Z',clients:[client('payer',{startedDay:'2024-02-03'}),client('binome',{emailKey:'identity-payer',startedDay:'2024-03-01',binomeIds:['payer']}),client('future',{startedDay:'2024-03-05'})],parcours:[]}));
 assert.equal(report.totals.firstAccompanimentsStarted,2);assert.equal(report.coverage.futureClientStarts,1);assert.equal(report.daily.find(d=>d.date==='2024-02-03')!.counts.firstAccompanimentsStarted,1);assert.equal(report.daily.find(d=>d.date==='2024-03-01')!.counts.firstAccompanimentsStarted,1);
});
test('earlier payment and Client start bounds remain contradictions rather than changing a declared date',()=>{
 const report=buildNotionCommerceReport(snapshot({clients:[client('not-the-related-client',{startedDay:'2023-01-01'})]}));
 // A missing relation is not a zero-date fallback.
 assert.equal(report.totals.firstClientsDeclared,0);assert.equal(report.coverage.unresolvedClientRelations,1);
 const prior=buildNotionCommerceReport(snapshot({clients:[client('client-a',{startedDay:'2023-01-01'})],payments:[payment('old',{day:'2023-12-01'})]}));
 assert.equal(prior.members[0].day,'2024-02-03');assert.equal(prior.members[0].firstPaymentDay,'2023-12-01');assert.equal(prior.totals.firstDateDisagreements,1);assert.equal(prior.totals.firstPurchaseEvidenceConcordant,0);assert.equal(prior.totals.earlierClientBounds,1);
});
test('DUO Format is independent of attached payment, payer identity and source first declaration',()=>{
 const report=buildNotionCommerceReport(snapshot({clients:[client(),client('benefit'),client('other')],payments:[payment(),payment('own',{clientIds:['benefit'],emailKey:'identity-benefit'}),payment('otherpay',{clientIds:['other'],emailKey:'some-other-person'})],parcours:[parcours(),parcours('benefit',{clientIds:['benefit'],format:'DUO - binôme'}),parcours('other',{clientIds:['other'],format:'DUO - binôme'})]}));
 assert.equal(report.totals.firstClientsDeclared,3);assert.equal(report.totals.firstClassifiedPayersDeclared,1);assert.equal(report.totals.firstBeneficiariesDeclared,2);assert.equal(report.totals.firstPurchaseEvidenceConcordant,2);assert.equal(report.totals.firstPaymentEmailContradictions,1);assert.ok(report.members.find(m=>m.parcoursId==='other')!.reasons.includes('beneficiary_payor_relation_unavailable'));
});
test('only exact provider copies deduplicate, repeated titles/source rows and refunds keep historical evidence',()=>{
 const a=payment('a',{providerId:'pi_synthetic'});const report=buildNotionCommerceReport(snapshot({payments:[a,{...a,id:'copy'},payment('another',{day:'2024-03-03'})]}));
 assert.equal(report.coverage.deduplicatedPayments,1);assert.equal(report.members[0].paymentIds.length,2);
 assert.throws(()=>buildNotionCommerceReport(snapshot({payments:[a,{...a,id:'copy',emailKey:'another'}]})),/PAYMENT_PROVIDER_CONFLICT/);
 assert.equal(buildNotionCommerceReport(snapshot({payments:[payment('refund',{status:'refunded'})]})).totals.firstPurchaseEvidenceConcordant,1);
 assert.equal(buildNotionCommerceReport(snapshot({payments:[payment('unknown',{amountMinor:null})]})).totals.firstNoPaymentObserved,1);
});
test('no date, unresolved client or incomplete source is never silently included as a proven first purchase',()=>{
 const report=buildNotionCommerceReport(snapshot({parcours:[parcours('undated',{startDay:null}),parcours('unlinked',{clientIds:[]})]}));
 assert.equal(report.totals.firstClientsDeclared,0);assert.equal(report.coverage.undatedParcours,1);assert.equal(report.coverage.unresolvedClientRelations,1);assert.throws(()=>buildNotionCommerceReport(snapshot({paginationComplete:false})),/COMMERCE_SOURCE_INCOMPLETE/);
});
test('normalizer preserves Paris date and raw date, minimizes private fields and shares existing email HMAC',()=>{
 const fields={Client:{relation:[{id:'client-a'}]},'E-mail':{email:' PERSON@EXAMPLE.TEST '},Date:{date:{start:'2024-03-30T23:30:00Z'}},Montant:{number:null},Status:{select:{name:'succeeded'}},Transaction:{rich_text:[{plain_text:'ch_synthetic'}]},'Invoice Id':{rich_text:[]},'Private notes':{rich_text:[{plain_text:'must never persist'}]}};
 const result=normalizeNotionCommerce({id:'payment-a',properties:fields},'payments',commerceConfig,secret) as ReturnType<typeof payment>;
 const pageResult=normalizeNotionCommerce({id:'payment-a',url:'https://www.notion.so/payment-a',properties:fields},'payments',commerceConfig,secret) as ReturnType<typeof payment>;
 assert.equal(result.day,'2024-03-31');assert.equal(result.rawDate,'2024-03-30T23:30:00Z');assert.equal(result.amountMinor,null);assert.equal(result.emailKey,emailIdentity('person@example.test',secret));assert.equal(pageResult.notionUrl,'https://www.notion.so/payment-a');assert.equal(JSON.stringify(result).includes('must never persist'),false);assert.equal(JSON.stringify(result).includes('PERSON@'),false);
});
test('client normalizer retains only its title and Notion page link for private paid-sales detail',()=>{
 const fields={'Nom':{type:'title',title:[{plain_text:'Camille Martin'}]},'E-mail':{email:null},'E-mail (BIS)':{email:null},Démarrage:{date:null},Prospect:{relation:[]},Binôme:{relation:[]}};
 const result=normalizeNotionCommerce({id:'client-a',url:'https://www.notion.so/client-a',properties:fields},'clients',commerceConfig,secret) as import('../src/lib/notion-commerce-report').CommerceClient;
 assert.equal(result.name,'Camille Martin');assert.equal(result.notionUrl,'https://www.notion.so/client-a');assert.equal(JSON.stringify(result).includes('Camille Martin'),true);
});
test('schedule normalizer keeps only explicit relations and reads a Total vente formula',()=>{
 const fields={Client:{relation:[{id:'client-a'}]},Paiement:{relation:[{id:'payment-a'}]},Date:{date:{start:'2024-03-30T23:30:00Z'}},Montant:{number:390},Statut:{select:{name:'Payé'}},'Total vente':{formula:{number:1170}},Échéance:{rich_text:[{plain_text:'1/3'}]}};
 const result=normalizeNotionCommerce({id:'schedule-a',properties:fields},'schedule',commerceConfig,secret) as import('../src/lib/notion-commerce-report').CommerceSchedule;
 assert.equal(result.day,'2024-03-31');assert.equal(result.totalMinor,117000);assert.deepEqual(result.paymentIds,['payment-a']);
});
test('legacy commerce config remains readable until the schedule source is configured',async()=>{
 const legacy=notionCommerceConfig(JSON.stringify({clients:{dataSourceId:'synthetic-clients'},payments:{dataSourceId:'synthetic-payments'},parcours:{dataSourceId:'synthetic-parcours'}}))!;assert.equal(legacy.schedule,undefined);
 let calls=0;const fetcher=async(input:unknown)=>{const url=new URL(String(input)),family=url.pathname.includes('clients')?'clients':url.pathname.includes('payments')?'payments':'parcours';calls++;return url.pathname.endsWith('/query')?Response.json({results:[],has_more:false,next_cursor:null}):Response.json({properties:Object.fromEntries(Object.values(legacy[family].fields).map((name,i)=>[name,{id:'p'+i}]))});};
 const result=await readNotionCommerceSnapshot({config:legacy,token:'synthetic',identitySecret:secret,fetcher:fetcher as typeof fetch});assert.equal(result.complete,true);assert.equal(result.snapshot!.schedules.length,0);assert.equal(calls,6);
});
test('source pagination is resumable, terminal observation time is stable and secret/profile changes reject the checkpoint',async()=>{
 let calls=0,saved:CommerceReadCheckpoint|undefined;const fetcher=async(input:unknown,init?:RequestInit)=>{const url=new URL(String(input));calls++;
  const family=url.pathname.includes('synthetic-clients')?'clients':url.pathname.includes('synthetic-payments')?'payments':url.pathname.includes('synthetic-schedule')?'schedule':'parcours';
  if(!url.pathname.endsWith('/query'))return Response.json({properties:Object.fromEntries(Object.values(commerceConfig[family]!.fields).map((name,i)=>[name,{id:'p'+i}]))});
  assert.ok(url.searchParams.getAll('filter_properties[]').length>0);assert.deepEqual(JSON.parse(String(init?.body)).sorts,[{timestamp:'created_time',direction:'ascending'}]);return Response.json({results:[],has_more:false,next_cursor:null});
 };
 const a=await readNotionCommerceSnapshot({config:commerceConfig,token:'synthetic-token',identitySecret:secret,maxPages:1,fetcher:fetcher as typeof fetch,onCheckpoint:async c=>{saved=c;}});assert.equal(a.complete,false);assert.equal(a.checkpoint.familyIndex,1);const untouched=JSON.stringify(saved);
 const b=await readNotionCommerceSnapshot({config:commerceConfig,token:'synthetic-token',identitySecret:secret,checkpoint:saved,fetcher:fetcher as typeof fetch});assert.equal(b.complete,true);assert.equal(calls,8);assert.equal(JSON.stringify(saved),untouched);
 const c=await readNotionCommerceSnapshot({config:commerceConfig,token:'synthetic-token',identitySecret:secret,checkpoint:b.checkpoint,fetcher:fetcher as typeof fetch});assert.equal(c.snapshot!.observedAt,b.snapshot!.observedAt);assert.equal(calls,8);
 await assert.rejects(()=>readNotionCommerceSnapshot({config:commerceConfig,token:'x',identitySecret:secret+'changed',checkpoint:saved}),/INVALID_SOURCE_CHECKPOINT/);
 const changed=structuredClone(commerceConfig);changed.parcours.fields.order='Different field';assert.notEqual(notionCommerceProfile(changed),notionCommerceProfile(commerceConfig));await assert.rejects(()=>readNotionCommerceSnapshot({config:changed,token:'x',identitySecret:secret,checkpoint:saved}),/INVALID_SOURCE_CHECKPOINT/);
});
test('truncated relations and duplicate provider pages reject before a misleading terminal report',async()=>{
 assert.throws(()=>normalizeNotionCommerce({id:'x',properties:{Client:{relation:[],has_more:true}}},'parcours',commerceConfig,secret),/TRUNCATED_SOURCE_RELATION/);
 let query=0;const fetcher=async(input:unknown)=>{const url=new URL(String(input));if(!url.pathname.endsWith('/query'))return Response.json({properties:Object.fromEntries(Object.values(commerceConfig.clients.fields).map((name,i)=>[name,{id:'p'+i}]))});query++;return Response.json({results:[{id:'same-client',properties:{}}],has_more:query===1,next_cursor:query===1?'next':null});};
 let saved:CommerceReadCheckpoint|undefined;
 await assert.rejects(()=>readNotionCommerceSnapshot({config:commerceConfig,token:'synthetic',identitySecret:secret,fetcher:fetcher as typeof fetch,onCheckpoint:async c=>{saved=c;}}),/DUPLICATE_SOURCE_ROWS/);assert.equal(saved!.snapshot.clients.length,1);assert.equal(saved!.familyIndex,0);
});
test('report capacity is an explicit refusal before any database write, never truncation',async()=>{
 const {publishNotionCommerceReport}=await import('../src/lib/notion-commerce-storage');const report=buildNotionCommerceReport(snapshot());report.daily=Array.from({length:1000},()=>report.daily[0]);let called=false;const db={select:async()=>{called=true;return [];},upsert:async()=>{called=true;},rpc:async()=>{called=true;throw Error('unexpected');},probe:async()=>{called=true;}};
 await assert.rejects(()=>publishNotionCommerceReport(db,commerceConfig,report),/COMMERCE_REPORT_INCOMPLETE/);assert.equal(called,false);
});
