import test from 'node:test';
import assert from 'node:assert/strict';
import {buildNotionCommerceReport} from '../src/lib/notion-commerce-report';
import {selectPaidSalesPeriod} from '../src/lib/paid-sales';
import {clubCashMinor,signedContracts,contractsInPeriod,contractTotalMinor} from '../src/lib/finance-summary';
import {applyBusinessReads} from '../src/lib/business-dashboard';
import {buildDashboard} from '../src/lib/dashboard';
import {snapshot,client,payment,schedule,parcours,filters} from './commerce-fixtures';

test('Club: monthly installments remain cash, refund and conflicting duplicates do not inflate cash',()=>{
 const data=snapshot({payments:[payment('a',{providerId:'pi_a',offerCategory:'club',amountMinor:2500}),payment('copy',{providerId:'pi_a',offerCategory:'club',amountMinor:2500}),payment('monthly',{offerCategory:'club',amountMinor:2500,day:'2024-02-20'}),payment('refund',{offerCategory:'club',status:'refunded',amountMinor:2500}),payment('failed',{offerCategory:'club',status:'failed',amountMinor:2500}),payment('program',{offerCategory:'blg90'}),payment('prior',{offerCategory:'club',day:'2024-01-01',amountMinor:2500})]});
 const report=selectPaidSalesPeriod(buildNotionCommerceReport(data).paidSales,filters.from,filters.to);
 assert.equal(clubCashMinor(report.details),5000);
});
test('First payment determines new client date independently from Client start; next month installment is not another client',()=>{
 const report=buildNotionCommerceReport(snapshot({clients:[client('client-a',{startedDay:'2024-01-10'})],payments:[payment(),payment('monthly',{day:'2024-03-03'})]}));
 for(const [from,to,expected]of [['2024-01-01','2024-01-31',0],['2024-02-01','2024-02-29',1],['2024-03-01','2024-03-31',0]] as const){
  const selected={...filters,from,to},dashboard=buildDashboard({leads:[],events:[],payments:[],appointments:[],deals:[],ads:[],revisions:[],runs:[],aggregates:[]},selected,'live');
  const paidSales=selectPaidSalesPeriod(report.paidSales,from,to);
  applyBusinessReads(dashboard,{commerce:{available:true,source:'Notion',definitionState:'pending_business_choice',observedAt:report.observedAt,counts:report.totals,paidSales,coverage:report.coverage,reason:''},notion:null,leadDefinitions:null,receipts:null,meta:null},selected);
  assert.equal(dashboard.metrics.find(m=>m.id==='new_clients')!.value,expected);
  assert.equal(dashboard.metrics.find(m=>m.id==='paid_sales')!.value,expected);
 }
});
test('Missing commerce publication cannot fabricate zero Club cash',()=>{
 const dashboard=buildDashboard({leads:[],events:[],payments:[],appointments:[],deals:[],ads:[],revisions:[],runs:[],aggregates:[]},filters,'live');
 applyBusinessReads(dashboard,{commerce:{available:false,source:'Notion',definitionState:'pending_business_choice',observedAt:null,counts:null,paidSales:null,coverage:null,reason:'missing'},notion:null,leadDefinitions:null,receipts:null,meta:null},filters);
 assert.equal(dashboard.metrics.find(m=>m.id==='cash_club')!.value,null);
 assert.equal(dashboard.metrics.find(m=>m.id==='cash')!.scopeLabel,undefined);
 assert.equal(dashboard.metrics.find(m=>m.id==='new_clients')!.value,null);
});


test('Contract total belongs to signature day, not cash day, and repeated installment totals count once',()=>{
 const data=snapshot({parcours:[parcours('contract',{closingDay:'2024-01-30'})],payments:[payment('initial',{day:'2024-02-03',amountMinor:39000})],schedules:[schedule('one',{paymentIds:['initial'],totalMinor:117000,amountMinor:39000}),schedule('two',{installment:'2/3',totalMinor:117000,amountMinor:39000,paymentIds:[]}),schedule('three',{installment:'3/3',totalMinor:117000,amountMinor:39000,paymentIds:[]})]});
 const contracts=signedContracts(data);
 assert.equal(contractTotalMinor(contractsInPeriod(contracts,'2024-01-01','2024-01-31')),117000);
 assert.equal(contractTotalMinor(contractsInPeriod(contracts,'2024-02-01','2024-02-29')),0);
 assert.equal(contracts.length,1);
});
test('Signed but unpaid sale remains contracted; a missing total or ambiguous renewal remains pending',()=>{
 const data=snapshot({payments:[],schedules:[schedule('initial',{status:'À venir',paymentIds:[]})]});
 assert.equal(contractTotalMinor(signedContracts(data)),30000);
 assert.equal(signedContracts({...data,schedules:[schedule('missing',{totalMinor:null})]})[0].totalMinor,null);
 const renewals=signedContracts({...data,parcours:[parcours(),parcours('renewal',{order:2,closingDay:'2024-02-20'})]});
 assert.ok(renewals.every(row=>row.state==='pending'&&row.totalMinor===null));
 const contradiction=signedContracts({...data,schedules:[schedule('first'),schedule('second',{installment:'2/3',totalMinor:99000})]});
 assert.equal(contradiction[0].state,'pending');
});


test('Offer unknown stays in total signed but separate from Club; fully pending contracts are unavailable',()=>{
 const base=buildNotionCommerceReport(snapshot({payments:[]}));
 const dashboard=()=>buildDashboard({leads:[],events:[],payments:[],appointments:[],deals:[],ads:[],revisions:[],runs:[],aggregates:[]},filters,'live');
 for(const [contracts,expected] of [[base.contracts,300],[signedContracts(snapshot({schedules:[]})),null]] as const){
  const result=dashboard();
  applyBusinessReads(result,{commerce:{available:true,source:'Notion',definitionState:'pending_business_choice',observedAt:base.observedAt,counts:base.totals,paidSales:base.paidSales,contracts:[...contracts],coverage:base.coverage,reason:''},notion:null,leadDefinitions:null,receipts:null,meta:null},filters);
  const metric=result.metrics.find(m=>m.id==='contracted')!;
  assert.equal(metric.value,expected);assert.notEqual(metric.scopeLabel,'Hors BLG Club');
  if(expected!==null){assert.equal(metric.separateAmounts!.find(row=>row.label==='À classer')!.value,300);assert.equal(metric.separateAmounts!.find(row=>row.label==='BLG Club')!.value,0);}
 }
});
