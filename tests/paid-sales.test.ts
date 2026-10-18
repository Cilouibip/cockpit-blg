import assert from 'node:assert/strict';
import test from 'node:test';
import {buildPaidSalesReport,selectPaidSalesPeriod} from '../src/lib/paid-sales';
const payment=(id:string,extra:Partial<Parameters<typeof buildPaidSalesReport>[0]['payments'][number]>={})=>({id,clientIds:['client-a'],day:'2026-09-03',amountMinor:39000,status:'succeeded',...extra});
const schedule=(id:string,extra:Partial<Parameters<typeof buildPaidSalesReport>[0]['schedules'][number]>={})=>({id,clientIds:['client-a'],paymentIds:['p1'],day:'2026-09-03',amountMinor:39000,status:'Payé',installment:'1/3',totalMinor:117000,...extra});
test('counts one explicit first paid installment and excludes its later installment',()=>{
 const report=buildPaidSalesReport({payments:[payment('p1'),payment('p2',{day:'2026-10-03'})],schedules:[schedule('s1'),schedule('s2',{paymentIds:['p2'],day:'2026-10-03',installment:'2/3'})],parcours:[]});
 assert.equal(report.confirmedInitialSales,1);assert.equal(report.excludedSubsequentPayments,1);assert.equal(report.details.find(d=>d.paymentId==='p2')!.state,'excluded');
});
test('keeps exact client/date/amount schedule coincidence reconciled, never confirmed',()=>{
 const report=buildPaidSalesReport({payments:[payment('p1')],schedules:[schedule('s1',{paymentIds:[]})],parcours:[]});
 assert.equal(report.confirmedInitialSales,0);assert.equal(report.reconciledInitialSales,1);assert.ok(report.details[0].reasons.includes('payment_schedule_relation_missing'));
});
test('keeps a documented cash sale and leaves a replacement Client with the same email pending',()=>{
 const report=buildPaidSalesReport({payments:[payment('old',{day:'2026-08-01',clientIds:['old'],emailKey:'same'}),payment('replacement',{day:'2026-09-01',clientIds:['new'],emailKey:'same'})],schedules:[schedule('cash',{clientIds:['old'],paymentIds:['old'],installment:'1/1',day:'2026-08-01'})],parcours:[]});
 assert.equal(report.confirmedInitialSales,1);assert.equal(report.pendingInitialPaymentCases,1);assert.ok(report.details.find(d=>d.paymentId==='replacement')!.reasons.includes('payment_email_identity_conflicts_with_other_client'));
});
test('keeps DUO beneficiary first payment pending and never merges it into a payer sale',()=>{
 const report=buildPaidSalesReport({payments:[payment('old',{clientIds:['payer'],emailKey:'shared',day:'2026-08-03'}),payment('duo',{clientIds:['beneficiary'],emailKey:'shared',amountMinor:31410})],schedules:[],parcours:[{id:'duo-parcours',clientIds:['beneficiary'],format:'DUO - binôme'}]});
 assert.equal(report.pendingInitialPaymentCases,2);assert.ok(report.details.find(d=>d.paymentId==='duo')!.reasons.includes('duo_beneficiary_sale_relation_unresolved'));
});
test('refunds and clientless payments cannot enter first-paid-sale counts',()=>{
 const report=buildPaidSalesReport({payments:[payment('refund',{status:'refunded'}),payment('unknown',{clientIds:[]})],schedules:[],parcours:[]});
 assert.equal(report.refundCases,1);assert.equal(report.pendingInitialPaymentCases,1);assert.equal(report.confirmedInitialSales,0);
});
test('refuses a directly linked schedule whose client, day or amount contradicts the payment',()=>{
 const report=buildPaidSalesReport({payments:[payment('p1')],schedules:[schedule('s1',{clientIds:['other']})],parcours:[]});
 assert.equal(report.confirmedInitialSales,0);assert.deepEqual(report.details[0].reasons,['direct_schedule_payment_client_date_or_amount_conflict']);
});
test('period counters filter details without recalculating the whole payment history',()=>{
 const whole=buildPaidSalesReport({payments:[payment('old',{day:'2026-08-01',clientIds:['old']}),payment('new',{day:'2026-09-03',clientIds:['new']})],schedules:[schedule('old',{clientIds:['old'],paymentIds:['old'],day:'2026-08-01'}),schedule('new',{clientIds:['new'],paymentIds:['new']})],parcours:[]});
 const period=selectPaidSalesPeriod(whole,'2026-09-01','2026-09-10');assert.equal(whole.confirmedInitialSales,2);assert.equal(period.confirmedInitialSales,1);assert.equal(period.details[0].paymentId,'new');
});

import {paidSalesChunkKey} from '../src/lib/notion-commerce-storage';
test('paid sales chunk keys retain numeric detail order under lexical database ordering',()=>{
 const keys=[paidSalesChunkKey(0),paidSalesChunkKey(30),paidSalesChunkKey(300)];
 assert.deepEqual([...keys].sort(),keys);
});
test('same-day payments stay pending unless a unique direct initial schedule resolves the ambiguity',()=>{
 const pending=buildPaidSalesReport({payments:[payment('a'),payment('b')],schedules:[],parcours:[]});
 assert.equal(pending.pendingInitialPaymentCases,2);assert.ok(pending.details.every(d=>d.reasons.includes('multiple_succeeded_payments_same_client_day')));
 const resolved=buildPaidSalesReport({payments:[payment('a'),payment('b')],schedules:[schedule('a-sale',{paymentIds:['a']})],parcours:[]});
 assert.equal(resolved.confirmedInitialSales,1);assert.equal(resolved.pendingInitialPaymentCases,1);
});
test('an email shared by distinct Client records stays pending without a direct relation',()=>{
 const report=buildPaidSalesReport({payments:[payment('a',{clientIds:['client-a'],emailKey:'shared'}),payment('b',{clientIds:['client-b'],emailKey:'shared',day:'2026-09-04'})],schedules:[],parcours:[]});
 assert.ok(report.details.every(d=>d.reasons.includes('payment_email_identity_conflicts_with_other_client')));
});
test('two direct initial schedules for one Client and day remain pending',()=>{
 const report=buildPaidSalesReport({payments:[payment('a'),payment('b')],schedules:[schedule('sa',{paymentIds:['a']}),schedule('sb',{paymentIds:['b']})],parcours:[]});
 assert.equal(report.confirmedInitialSales,0);assert.equal(report.pendingInitialPaymentCases,2);
});
test('a payment email contradicting both Client email keys remains pending',()=>{
 const report=buildPaidSalesReport({clients:[{id:'client-a',emailKey:'client-email',emailBisKey:'client-email-bis'}],payments:[payment('a',{emailKey:'payment-email'})],schedules:[schedule('s',{paymentIds:['a']})],parcours:[]});
 assert.equal(report.details[0].state,'pending');assert.ok(report.details[0].reasons.includes('payment_email_conflicts_with_client'));
});

test('provider conflict preserves every original and prevents a later installment from becoming a first sale',()=>{
 const report=buildPaidSalesReport({payments:[payment('conflict-a',{providerId:'ch_synthetic'}),payment('conflict-b',{providerId:'ch_synthetic',amountMinor:0,clientIds:[]}),payment('later',{day:'2026-10-03'}),payment('independent',{clientIds:['safe'],offerCategory:'defi'})],schedules:[schedule('later',{paymentIds:['later'],day:'2026-10-03'}),schedule('safe',{clientIds:['safe'],paymentIds:['independent']})],parcours:[]});
 assert.equal(report.confirmedInitialSales,1);assert.equal(report.pendingInitialPaymentCases,3);assert.equal(report.details.length,4);
 assert.ok(report.details.find(d=>d.paymentId==='later')!.reasons.includes('payment_history_affected_by_provider_conflict'));
 assert.equal(report.confirmedByOffer.defi,1);
});
test('conflict propagates transitively through schedule links, Client and both Client email identities',()=>{
 const report=buildPaidSalesReport({clients:[{id:'a',emailBisKey:'shared'},{id:'b',emailKey:'shared'},{id:'c'}],payments:[payment('conflict-a',{providerId:'ch_synthetic',clientIds:['a'],emailKey:'raw'}),payment('conflict-b',{providerId:'ch_synthetic',clientIds:[],amountMinor:0}),payment('later-b',{clientIds:['b'],day:'2026-10-03'}),payment('later-c',{clientIds:['c'],day:'2026-10-03'})],schedules:[schedule('bridge',{clientIds:['c'],paymentIds:['conflict-b']}),schedule('b',{clientIds:['b'],paymentIds:['later-b'],day:'2026-10-03'}),schedule('c',{clientIds:['c'],paymentIds:['later-c'],day:'2026-10-03'})],parcours:[]});
 assert.equal(report.confirmedInitialSales,0);assert.equal(report.pendingInitialPaymentCases,4);
 assert.ok(report.details.filter(d=>d.paymentId.startsWith('later')).every(d=>d.reasons.includes('payment_history_affected_by_provider_conflict')));
});
test('known earlier sales survive a later dated conflict but an undated conflict keeps the entire identity pending',()=>{
 const source={clients:[{id:'client-a'}],payments:[payment('earlier',{day:'2026-08-01'}),payment('conflict-a',{providerId:'ch_synthetic'}),payment('conflict-b',{providerId:'ch_synthetic',amountMinor:0})],schedules:[schedule('earlier',{paymentIds:['earlier'],day:'2026-08-01'})],parcours:[]};
 const known=buildPaidSalesReport(source);assert.equal(known.confirmedInitialSales,1);assert.equal(known.details.find(d=>d.paymentId==='earlier')!.state,'confirmed');
 const unknown=buildPaidSalesReport({...source,payments:source.payments.map(p=>p.id==='conflict-b'?{...p,day:null}:p)});
 assert.equal(unknown.confirmedInitialSales,0);assert.equal(unknown.details.find(d=>d.paymentId==='earlier')!.state,'pending');
 const linkedUndated=buildPaidSalesReport({...source,payments:[...source.payments,payment('undated',{day:null})]});assert.equal(linkedUndated.confirmedInitialSales,0);
 const undatedSchedule=buildPaidSalesReport({...source,schedules:[...source.schedules,schedule('undated',{paymentIds:[],day:null})]});assert.equal(undatedSchedule.confirmedInitialSales,0);
 const unresolved=buildPaidSalesReport({...source,schedules:[...source.schedules,schedule('missing-link',{paymentIds:['missing']})]});
 assert.equal(unresolved.confirmedInitialSales,0,'an unresolved connected source payment cannot establish an earlier unaffected interval');
});
test('a succeeded/refunded provider contradiction stays pending, while independent refunds remain excluded',()=>{
 const report=buildPaidSalesReport({payments:[payment('a',{providerId:'ch_synthetic'}),payment('b',{providerId:'ch_synthetic',status:'refunded'}),payment('refund',{clientIds:['other'],status:'refunded'})],schedules:[],parcours:[]});
 assert.equal(report.pendingInitialPaymentCases,2);assert.equal(report.refundCases,1);assert.equal(report.confirmedInitialSales,0);
});
test('confirmed offer totals use explicit source attribution and exactly the same period as the total',()=>{
 const categories=['blg90','defi','club','other','unknown'] as const;
 const report=buildPaidSalesReport({payments:categories.map((offerCategory,i)=>payment('p'+i,{clientIds:['c'+i],day:i===0?'2026-08-01':'2026-09-03',offerCategory,offerRaw:offerCategory==='unknown'?null:'Source '+offerCategory})),schedules:categories.map((_,i)=>schedule('s'+i,{clientIds:['c'+i],paymentIds:['p'+i],day:i===0?'2026-08-01':'2026-09-03'})),parcours:[]});
 assert.equal(report.confirmedInitialSales,5);assert.deepEqual(report.confirmedByOffer,{blg90:1,defi:1,club:1,other:1,unknown:1});
 const period=selectPaidSalesPeriod(report,'2026-09-01','2026-09-30');assert.equal(period.confirmedInitialSales,4);assert.equal(period.confirmedByOffer.blg90,0);assert.equal(Object.values(period.confirmedByOffer).reduce((a,b)=>a+b,0),period.confirmedInitialSales);
 assert.equal(period.details.find(d=>d.offerCategory==='club')!.offerRaw,'Source club');
});
