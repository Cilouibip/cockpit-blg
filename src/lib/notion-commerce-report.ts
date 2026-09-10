import {createHash} from 'node:crypto';
import {Temporal} from '@js-temporal/polyfill';
import {buildPaidSalesReport,type PaidSalesReport} from './paid-sales';
export const NOTION_COMMERCE_VERSION='notion-commerce-accompaniment-v2';
export interface CommerceClient {id:string;name:string|null;notionUrl:string|null;emailKey:string|null;emailBisKey:string|null;startedDay:string|null;prospectIds:string[];binomeIds:string[]}
export interface CommercePayment {id:string;notionUrl:string|null;clientIds:string[];emailKey:string|null;providerId:string|null;day:string|null;rawDate:string|null;amountMinor:number|null;status:string}
export interface CommerceSchedule {id:string;notionUrl:string|null;clientIds:string[];paymentIds:string[];day:string|null;rawDate:string|null;amountMinor:number|null;status:string|null;installment:string|null;totalMinor:number|null}
export interface CommerceParcours {id:string;clientIds:string[];order:number|null;format:string|null;startDay:string|null;closingDay:string|null;rawStart:string|null;rawClosing:string|null;status:string|null}
export interface CommerceSnapshot {clients:CommerceClient[];payments:CommercePayment[];schedules:CommerceSchedule[];parcours:CommerceParcours[];startedAt:string;observedAt:string;paginationComplete:boolean;sourceCounts:Record<string,number>}
export const COMMERCE_COUNTERS=['firstAccompanimentsStarted','firstClientsDeclared','firstClassifiedPayersDeclared','firstBeneficiariesDeclared','firstClassifiedPayerDatesConcordant','firstPaymentDatesConcordant','firstPurchaseEvidenceConcordant','firstDateDisagreements','firstNoPaymentObserved','firstPaymentEmailContradictions','earlierClientBounds','parcoursDeclared','classifiedPayerParcours','beneficiaryParcours','repeatParcours'] as const;
export type CommerceCounters=Record<typeof COMMERCE_COUNTERS[number],number>;
export interface CommerceMember {parcoursId:string;clientIds:string[];personKey:string|null;identityBasis:'email_hmac_v1'|'source_client'|'unresolved';day:string|null;closingDay:string|null;order:number|null;format:string|null;firstDeclaration:boolean;firstPaymentDay:string|null;paymentIds:string[];paymentEmailConcordant:boolean|null;earlierParcours:boolean;earlierClientBound:boolean;reasons:string[]}
export interface CommerceAccompanimentMember {clientId:string;personKey:string;identityBasis:'email_hmac_v1'|'source_client';day:string|null;firstStart:boolean;reasons:string[]}
export interface CommerceReport {version:string;startedAt:string;observedAt:string;daily:{date:string;counts:CommerceCounters}[];totals:CommerceCounters;paidSales:PaidSalesReport;members:CommerceMember[];accompanimentMembers:CommerceAccompanimentMember[];sourceMembers:{clients:string[];payments:string[];schedules:string[];parcours:string[]};membershipHash:string;coverage:{sourceRows:Record<string,number>;publishedPopulation:string;historicalExhaustivity:false;undatedParcours:number;undatedClientStarts:number;futureClientStarts:number;unresolvedClientRelations:number;deduplicatedPayments:number;firstPaymentObservedDay:string|null};paginationComplete:true}
const counters=():CommerceCounters=>Object.fromEntries(COMMERCE_COUNTERS.map(k=>[k,0])) as CommerceCounters;
const classifiedPayer=(f:string|null)=>f==='Solo'||f==='DUO - payeur';
const stable=(values:string[])=>[...new Set(values)].sort();
/** Whole-source calculation precedes all period filters. No canonical payment/deal is emitted. */
export function buildNotionCommerceReport(snapshot:CommerceSnapshot):CommerceReport {
 if(!snapshot.paginationComplete)throw Error('COMMERCE_SOURCE_INCOMPLETE');
 for(const list of [snapshot.clients,snapshot.payments,snapshot.schedules,snapshot.parcours])if(new Set(list.map(r=>r.id)).size!==list.length)throw Error('DUPLICATE_SOURCE_ROWS');
 const clients=new Map(snapshot.clients.map(r=>[r.id,r])),canonicalPayments:CommercePayment[]=[],provider=new Map<string,CommercePayment>(),duplicateToCanonical=new Map<string,string>();let deduplicatedPayments=0;
 for(const p of [...snapshot.payments].sort((a,b)=>a.id.localeCompare(b.id))){
  if(p.amountMinor!==null&&(!Number.isSafeInteger(p.amountMinor)||p.amountMinor<0))throw Error('INVALID_PAYMENT_AMOUNT');
  if(p.providerId){const old=provider.get(p.providerId);if(old){if(old.day!==p.day||old.amountMinor!==p.amountMinor||old.status!==p.status||old.emailKey!==p.emailKey||JSON.stringify(stable(old.clientIds))!==JSON.stringify(stable(p.clientIds)))throw Error('PAYMENT_PROVIDER_CONFLICT');deduplicatedPayments++;duplicateToCanonical.set(p.id,old.id);continue;}provider.set(p.providerId,p);}
  canonicalPayments.push(p);
 }
 const personKey=(client:CommerceClient)=>client.emailKey??client.emailBisKey??'client:'+client.id;
 const paidByClient=new Map<string,CommercePayment[]>();for(const p of canonicalPayments)if(p.day&&p.amountMinor!==null&&p.amountMinor>0&&['succeeded','refunded'].includes(p.status))for(const id of stable(p.clientIds)){const client=clients.get(id);if(!client)continue;const key=personKey(client),rows=paidByClient.get(key)??[];if(!rows.some(r=>r.id===p.id))rows.push(p);paidByClient.set(key,rows);}
 const earliestParcours=new Map<string,string>(),earliestClientStart=new Map<string,string>();
 for(const p of snapshot.parcours)if(p.startDay)for(const id of p.clientIds){const c=clients.get(id);if(c){const key=personKey(c);if(!earliestParcours.has(key)||p.startDay<earliestParcours.get(key)!)earliestParcours.set(key,p.startDay);}}
 for(const c of snapshot.clients)if(c.startedDay){const key=personKey(c);if(!earliestClientStart.has(key)||c.startedDay<earliestClientStart.get(key)!)earliestClientStart.set(key,c.startedDay);}
 const sourceMembers={clients:snapshot.clients.map(c=>c.id).sort(),payments:snapshot.payments.map(p=>p.id).sort(),schedules:snapshot.schedules.map(s=>s.id).sort(),parcours:snapshot.parcours.map(p=>p.id).sort()};
 const members:CommerceMember[]=snapshot.parcours.map(p=>{
  const ids=stable(p.clientIds),client=ids.length===1?clients.get(ids[0]):undefined,key=client?personKey(client):null;
  const payments=client?(paidByClient.get(personKey(client))??[]):[],first=payments.map(p=>p.day!).sort()[0]??null,firstPayments=payments.filter(p=>p.day===first),emailKeys=client?[client.emailKey,client.emailBisKey].filter(Boolean):[];
  const emailConcordant=firstPayments.length?firstPayments.every(p=>!!p.emailKey&&emailKeys.includes(p.emailKey)):null;
  const earlierParcours=!!key&&!!p.startDay&&!!earliestParcours.get(key)&&earliestParcours.get(key)!<p.startDay;
  const earlierClientBound=!!key&&!!p.startDay&&!!earliestClientStart.get(key)&&earliestClientStart.get(key)!<p.startDay;
  const reasons=[...(!client?['client_relation_unresolved']:[]),...(!p.startDay?['purchase_declaration_undated']:[]),...(first&&first!==p.startDay?['source_dates_disagree']:[]),...(emailConcordant===false?['payment_email_differs_or_missing']:[]),...(earlierParcours?['earlier_parcours_observed']:[]),...(earlierClientBound?['earlier_client_start_bound']:[]),...(p.format==='DUO - binôme'&&!client?.binomeIds.length?['beneficiary_payor_relation_unavailable']:[])];
  return {parcoursId:p.id,clientIds:ids,personKey:key,identityBasis:!client?'unresolved':client.emailKey||client.emailBisKey?'email_hmac_v1':'source_client',day:p.startDay,closingDay:p.closingDay,order:p.order,format:p.format,firstDeclaration:false,firstPaymentDay:first,paymentIds:payments.map(p=>p.id).sort(),paymentEmailConcordant:emailConcordant,earlierParcours,earlierClientBound,reasons};
 });
 // A person has one earliest source first-purchase declaration globally. Repeated source rows remain members.
 const firstByPerson=new Map<string,CommerceMember>();
 for(const m of [...members].sort((a,b)=>(a.day??'9999').localeCompare(b.day??'9999')||a.parcoursId.localeCompare(b.parcoursId)))if(m.order===1&&m.personKey&&m.day&&!firstByPerson.has(m.personKey)){m.firstDeclaration=true;firstByPerson.set(m.personKey,m);}
 const observedDay=Temporal.Instant.from(snapshot.observedAt).toZonedDateTimeISO('Europe/Paris').toPlainDate().toString();
 // An email is evidence for payment reconciliation only. It never merges Client records:
 // an explicit reciprocal Binôme can legitimately share an email while representing two people.
 const accompanimentMembers:CommerceAccompanimentMember[]=snapshot.clients.map(c=>({clientId:c.id,personKey:'client:'+c.id,identityBasis:'source_client',day:c.startedDay,firstStart:false,reasons:!c.startedDay?['client_start_undated']:c.startedDay>observedDay?['client_start_future']:[]}));
 const firstStartByPerson=new Map<string,CommerceAccompanimentMember>();
 for(const m of [...accompanimentMembers].sort((a,b)=>(a.day??'9999').localeCompare(b.day??'9999')||a.clientId.localeCompare(b.clientId)))if(m.day&&m.day<=observedDay&&!firstStartByPerson.has(m.personKey)){m.firstStart=true;firstStartByPerson.set(m.personKey,m);}
 const days=new Map<string,CommerceCounters>();
 for(const m of accompanimentMembers)if(m.firstStart&&m.day){const c=days.get(m.day)??counters();days.set(m.day,c);c.firstAccompanimentsStarted++;}
 for(const m of members){if(!m.day)continue;const c=days.get(m.day)??counters();days.set(m.day,c);c.parcoursDeclared++;if(classifiedPayer(m.format))c.classifiedPayerParcours++;if(m.format==='DUO - binôme')c.beneficiaryParcours++;if(m.order!==null&&m.order>1)c.repeatParcours++;
  if(!m.firstDeclaration)continue;c.firstClientsDeclared++;if(classifiedPayer(m.format))c.firstClassifiedPayersDeclared++;if(m.format==='DUO - binôme')c.firstBeneficiariesDeclared++;
  const concordant=m.firstPaymentDay===m.day;
  if(concordant&&m.paymentEmailConcordant===true&&!m.earlierParcours&&!m.earlierClientBound)c.firstPurchaseEvidenceConcordant++;
  if(concordant){c.firstPaymentDatesConcordant++;if(classifiedPayer(m.format))c.firstClassifiedPayerDatesConcordant++;}
  if(m.firstPaymentDay&&m.firstPaymentDay!==m.day)c.firstDateDisagreements++;if(!m.firstPaymentDay)c.firstNoPaymentObserved++;if(m.paymentEmailConcordant===false)c.firstPaymentEmailContradictions++;if(m.earlierClientBound)c.earlierClientBounds++;
 }
 const daily=[...days].sort(([a],[b])=>a.localeCompare(b)).map(([date,counts])=>({date,counts})),totals=counters();for(const d of daily)for(const k of COMMERCE_COUNTERS)totals[k]+=d.counts[k];
 members.sort((a,b)=>a.parcoursId.localeCompare(b.parcoursId));
 const schedulesForPayments=snapshot.schedules.map(schedule=>({...schedule,paymentIds:stable(schedule.paymentIds.map(id=>duplicateToCanonical.get(id)??id))}));
 const paidSales=buildPaidSalesReport({clients:snapshot.clients,payments:canonicalPayments,schedules:schedulesForPayments,parcours:snapshot.parcours});
 return {version:NOTION_COMMERCE_VERSION,startedAt:snapshot.startedAt,observedAt:snapshot.observedAt,daily,totals,paidSales,members,accompanimentMembers,sourceMembers,membershipHash:createHash('sha256').update(JSON.stringify({members,accompanimentMembers})).digest('hex'),coverage:{sourceRows:snapshot.sourceCounts,publishedPopulation:'Premiers accompagnements par Démarrage Client effectif et premiers achats déclarés dans les Parcours Notion disponibles. Les binômes sont inclus au même titre que les autres Clients ; paiement, classement payeur et bénéficiaire restent distincts.',historicalExhaustivity:false,undatedParcours:members.filter(m=>!m.day).length,undatedClientStarts:accompanimentMembers.filter(m=>!m.day).length,futureClientStarts:accompanimentMembers.filter(m=>m.reasons.includes('client_start_future')).length,unresolvedClientRelations:members.filter(m=>!m.personKey).length,deduplicatedPayments,firstPaymentObservedDay:canonicalPayments.filter(p=>p.day&&p.amountMinor!==null&&p.amountMinor>0&&['succeeded','refunded'].includes(p.status)).map(p=>p.day!).sort()[0]??null},paginationComplete:true};
}
