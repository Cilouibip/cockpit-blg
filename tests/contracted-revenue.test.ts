import test from 'node:test';
import assert from 'node:assert/strict';
import {mapContractedRevenueRelations,projectContractedRevenue,type ContractedRevenueCandidate} from '../src/lib/contracted-revenue';
const row=(overrides:Partial<ContractedRevenueCandidate>={}):ContractedRevenueCandidate=>({saleId:'sale-a',saleDate:'2026-03-02',totalMinor:120000,scheduleIds:['schedule-1'],beneficiaryClientIds:['client-a'],...overrides});
test('three installments and both DUO beneficiaries remain one explicitly identified sale',()=>{
 const result=projectContractedRevenue([row({scheduleIds:['schedule-1']}),row({scheduleIds:['schedule-2']}),row({scheduleIds:['schedule-3'],beneficiaryClientIds:['client-a','client-b']})]);
 assert.equal(result.candidates.length,1);assert.equal(result.contractedMinor,120000);assert.deepEqual(result.candidates[0].scheduleIds,['schedule-1','schedule-2','schedule-3']);assert.deepEqual(result.candidates[0].beneficiaryClientIds,['client-a','client-b']);
});
test('distinct sale IDs count separately even when their date, amount and Client are identical',()=>{
 const result=projectContractedRevenue([row(),row({saleId:'sale-b',scheduleIds:['schedule-2']})]);
 assert.equal(result.candidates.length,2);assert.equal(result.contractedMinor,240000);
});
test('an unmapped or incomplete candidate keeps every global total unavailable',()=>{
 const result=projectContractedRevenue([row(),row({saleId:null,saleDate:null,totalMinor:null,scheduleIds:[]})]);
 assert.equal(result.candidates.length,1);assert.equal(result.contractedMinor,null);assert.deepEqual(result.incomplete,{missingSaleId:1,missingSaleDate:0,missingTotal:0,missingScheduleLink:0,conflictingSaleEvidence:0});
});
test('conflicting date or total under one sale ID is incomplete instead of a silent choice',()=>{
 const result=projectContractedRevenue([row(),row({totalMinor:110000,scheduleIds:['schedule-2']})]);
 assert.equal(result.candidates.length,0);assert.equal(result.contractedMinor,null);assert.equal(result.incomplete.conflictingSaleEvidence,1);
});
test('Échéancier to Paiements to Parcours maps three installments and DUO beneficiaries to one candidate sale',()=>{
 const result=mapContractedRevenueRelations({schedules:[{id:'s1',paymentIds:['p1'],totalMinor:120000,beneficiaryClientIds:['payer']},{id:'s2',paymentIds:['p2'],totalMinor:120000,beneficiaryClientIds:['payer','duo']},{id:'s3',paymentIds:['p3'],totalMinor:120000,beneficiaryClientIds:['payer','duo']}],payments:[{id:'p1',parcoursIds:['parcours-a']},{id:'p2',parcoursIds:['parcours-a']},{id:'p3',parcoursIds:['parcours-a']}],parcours:[{id:'parcours-a',closingDay:'2026-03-02'}]});
 assert.equal(result.candidates.length,1);assert.equal(result.contractedMinor,120000);assert.deepEqual(result.candidates[0].beneficiaryClientIds,['duo','payer']);
});
test('unlinked schedules and a payment linked to several Parcours keep the global total unavailable',()=>{
 const result=mapContractedRevenueRelations({schedules:[{id:'unlinked',paymentIds:[],totalMinor:120000,beneficiaryClientIds:[]},{id:'ambiguous',paymentIds:['p1'],totalMinor:120000,beneficiaryClientIds:[]}],payments:[{id:'p1',parcoursIds:['a','b']}],parcours:[{id:'a',closingDay:'2026-03-02'},{id:'b',closingDay:'2026-03-02'}]});
 assert.equal(result.contractedMinor,null);assert.deepEqual(result.incomplete,{withoutPaymentRelation:1,unmappedLinkedSchedules:0,ambiguousScheduleRelations:1,missingClosing:0,missingTotal:0,conflictingTotals:0});
});
