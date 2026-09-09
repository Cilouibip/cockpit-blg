import test from 'node:test';
import assert from 'node:assert/strict';
import {countPositiveWixReceipts,readWixTransactionCount} from '../src/lib/wix-transaction-counts';
import {normalizeWixTransaction,type WixTransactionsBatch} from '../src/connectors/wix-transactions';
import type {Database} from '../src/lib/db';
const ctx={siteId:'44444444-4444-4444-8444-444444444444',observedAt:'2026-09-01T00:00:00Z',currencyExponents:{EUR:2}};
const raw=(id:string,status='APPROVED',amount=120)=>({transactionId:id,status,type:'SALE',createdAt:'2026-08-01T22:30:00Z',provider:'synthetic',paymentMethod:'card',amount:{amount,currency:'EUR'},refunds:[]});
test('positive receipts retain refunded originals, exclude zero and declined, and balance membership',()=>{
 const rows=[...normalizeWixTransaction(raw('receipt'),ctx),...normalizeWixTransaction({...raw('refunded','REFUND'),refunds:[{refundId:'r1',amount:120,type:'FULL',status:'SUCCEEDED',createdAt:'2026-08-05T10:00:00Z'}]},ctx),...normalizeWixTransaction(raw('zero','APPROVED',0),ctx),...normalizeWixTransaction(raw('declined','DECLINED'),ctx)];
 const count=countPositiveWixReceipts({records:rows} as WixTransactionsBatch);assert.equal(count.included,2);assert.equal(count.excluded,2);assert.equal(count.included+count.excluded,rows.filter(r=>r.kind==='payment').length);assert.equal(count.days.get('2026-08-02')?.receipts,2);assert.equal(count.days.get('2026-08-05')?.refunds,1);assert.equal(count.firstDay,'2026-08-02');
 assert.throws(()=>countPositiveWixReceipts({records:[...rows,rows[0]]} as WixTransactionsBatch),/répété/);assert.ok(rows.every(r=>!('effectiveAt'in r)));
});
test('missing Wix history is unavailable and never zero transactions',async()=>{
 const previous=process.env.WIX_SITE_ID;process.env.WIX_SITE_ID='synthetic';
 try{const db:Database={select:async()=>[],rpc:async<T>()=>({runs:[],aggregates:[],selections:[],validations:{},exactRunId:null,latestAttempt:null}) as T,upsert:async()=>assert.fail(),probe:async()=>{}};const m=await readWixTransactionCount(db,'2024-01-01','2025-01-01');assert.equal(m.value,null);assert.match(m.unavailableReason!,/historique Notion/);}finally{if(previous===undefined)delete process.env.WIX_SITE_ID;else process.env.WIX_SITE_ID=previous;}
});
