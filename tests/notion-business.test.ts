import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeNotionBusiness,sourceBusinessDay} from '../src/connectors/notion-business';
import {emailIdentity} from '../src/domain/identity';
import {applyNotionBusiness,type BusinessRollup} from '../src/lib/business-dashboard';
import {buildDashboard} from '../src/lib/dashboard';
const secret='synthetic-identity-secret-for-tests-only';
const date=(start:string)=>({date:{start}});
test('business dates retain date-only values and use Paris for instants across midnight and DST',()=>{
 assert.equal(sourceBusinessDay('2024-02-29'),'2024-02-29');assert.equal(sourceBusinessDay('2026-03-28T23:30:00Z'),'2026-03-29');
 assert.equal(sourceBusinessDay('2026-10-25T23:30:00Z'),'2026-10-26');assert.throws(()=>sourceBusinessDay('2026-02-29'));
 const b=normalizeNotionBusiness({'Date acquisition reelle':date('2025-12-31'),'Date Exponensia':date('2024-01-01'),'Date Wix':date('2023-01-01')},{createdAt:'2026-08-01T10:00:00Z'});
 assert.equal(b.acquisitionDay,'2025-12-31');assert.equal(b.acquisitionBasis,'real');assert.equal(b.dates.legacy,'2024-01-01');
 const onlyCreated=normalizeNotionBusiness({},{createdAt:'2026-08-01T10:00:00Z'});assert.equal(onlyCreated.acquisitionDay,null);assert.ok(onlyCreated.createdAt);
});
test('Notion and signed backend share identity normalization and HMAC domain without alias merging',()=>{
 const email=' TEST+source@Example.test ';
 const b=normalizeNotionBusiness({'E-mail':{email}},{identitySecret:secret});
 assert.equal(b.identityKey,emailIdentity(email,secret));assert.notEqual(b.identityKey,emailIdentity('test@example.test',secret));
 assert.equal(normalizeNotionBusiness({'E-mail':{email:'invalid'}},{identitySecret:secret}).identityKey,null);
 assert.equal(normalizeNotionBusiness({'E-mail':{email}},{ }).identityKey,null);
 assert.throws(()=>normalizeNotionBusiness({'E-mail':{email}},{identitySecret:'short'}),/SECRET_TOO_SHORT/);
 assert.ok(!JSON.stringify(b).includes('Example'));
});
test('source classification preserves provenance and never creates an attendance event',()=>{
 const p={"Groupe d'état Noshow":{formula:{string:'Show up'}}};
 const current=normalizeNotionBusiness(p,{status:'Closé',appointmentAt:'2026-08-10'});assert.equal(current.attendance,'show_up');assert.equal(current.attendanceBasis,'source_group');assert.equal(current.explicitFinished,false);assert.ok(!('attendedAt'in current));
 assert.equal(normalizeNotionBusiness(p,{status:'Noshow'}).attendance,'unknown');
 const finished=normalizeNotionBusiness({},{status:'RDV Terminé'});assert.equal(finished.attendance,'show_up');assert.equal(finished.explicitFinished,true);
 assert.equal(normalizeNotionBusiness({},{status:'Unexpected'}).attendance,'unknown');
});
test('known leads stay visible beside unresolved and creation-only rows; denominator excludes cancelled and unknown',()=>{
 const filters={from:'2026-08-01',to:'2026-08-31',source:'all' as const,tunnel:'all' as const,campaign:'',compare:false};
 const data=buildDashboard({leads:[],events:[],payments:[],appointments:[],deals:[],ads:[],revisions:[],runs:[],aggregates:[]},filters,'live');
 const r:BusinessRollup={available:true,observedAt:'2026-09-01T00:00:00Z',sourceRows:12,leads:{rows:7,known:4,unresolved:1,creationOnly:5,archivedRows:1},appointments:{total:12,attended:4,explicitFinished:1,noShow:2,cancelled:3,unknown:3,booked:8,closed:1}};
 applyNotionBusiness(data,r,filters);assert.equal(data.metrics.length,8);assert.equal(data.metrics.find(m=>m.id==='leads')?.value,4);assert.equal(data.metrics.find(m=>m.id==='leads')?.completeness,'partial');
 const showup=data.pillars.flatMap(p=>p.metrics).find(m=>m.id==='showup')!;assert.equal(showup.numerator,4);assert.equal(showup.denominator,6);assert.equal(showup.value,4/6*100);
 assert.ok(data.pillars.find(p=>p.id==='acquisition')?.metrics.some(m=>m.id==='ad_customer_cost'));
 applyNotionBusiness(data,r,{...filters,source:'paid'});assert.equal(data.metrics.find(m=>m.id==='leads')?.value,null);assert.match(data.metrics.find(m=>m.id==='leads')!.unavailableReason!,/filtre/);
});
