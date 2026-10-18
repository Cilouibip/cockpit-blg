import type {PaidSaleDetail} from './paid-sales';
/** Club receipts are separate from Wix cash. A refunded payment contributes zero net cash;
 * unresolved provider duplicates are preserved as pending and never summed twice.
 * Sale classification is irrelevant here: subsequent monthly payments remain receipts. */
export function clubCashMinor(details:PaidSaleDetail[]):number {
 return details.filter(row=>row.offerCategory==='club'&&row.day&&row.amountMinor!==null&&row.amountMinor>0
  &&!row.reasons.some(reason=>['payment_refunded','payment_not_succeeded_or_amount_missing','payment_provider_conflict','payment_history_affected_by_provider_conflict'].includes(reason)))
  .reduce((sum,row)=>sum+row.amountMinor!,0);
}

import type {CommerceSnapshot,CommerceSchedule} from './notion-commerce-report';
import type {OfferCategory} from './paid-sales';
export interface SignedContract {
 parcoursId:string;clientId:string|null;signedDay:string|null;totalMinor:number|null;
 offerCategory:OfferCategory;state:'identified'|'pending'|'beneficiary';scheduleIds:string[];reasons:string[];
}
/** The source repeats Total vente on installments. Only one contract is emitted
 * per signed Parcours. A shared client or inconsistent totals never creates an inferred contract. */
export function signedContracts(snapshot:CommerceSnapshot):SignedContract[] {
 const byClient=new Map<string,typeof snapshot.parcours>();
 for(const parcours of snapshot.parcours)for(const id of new Set(parcours.clientIds)){const rows=byClient.get(id)??[];rows.push(parcours);byClient.set(id,rows);}
 return snapshot.parcours.map(parcours=>{
  const ids=[...new Set(parcours.clientIds)],clientId=ids.length===1?ids[0]:null;
  const base={parcoursId:parcours.id,clientId,signedDay:parcours.closingDay,totalMinor:null,offerCategory:'unknown' as OfferCategory,scheduleIds:[] as string[]};
  if(parcours.format==='DUO - binôme')return {...base,state:'beneficiary' as const,reasons:['beneficiary_not_separate_contract']};
  const reasons:string[]=[];
  if(!parcours.closingDay)reasons.push('signature_date_missing');
  if(!clientId)reasons.push('client_relation_ambiguous');
  const payerParcours=clientId?(byClient.get(clientId)??[]).filter(row=>row.format!=='DUO - binôme'):[];
  if(payerParcours.length!==1)reasons.push('multiple_contracts_for_client');
  // Initial installments define a sale plan, regardless of whether paid yet.
  const schedules=clientId?snapshot.schedules.filter(row=>row.clientIds.length===1&&row.clientIds[0]===clientId&&/^1\/[1-9]\d*$/.test(row.installment??'')):[];
  if(schedules.length!==1)reasons.push('initial_sale_plan_missing_or_ambiguous');
  const planTotals=new Set(snapshot.schedules.filter(row=>clientId&&row.clientIds.includes(clientId)).map(row=>row.totalMinor));
  if(planTotals.size!==1||planTotals.has(null))reasons.push('contract_totals_disagree');
  const initial:CommerceSchedule|undefined=schedules.length===1?schedules[0]:undefined;
  if(!initial||!Number.isSafeInteger(initial.totalMinor)||initial.totalMinor!<=0)reasons.push('contract_total_missing');
  const payments=initial?snapshot.payments.filter(row=>initial.paymentIds.includes(row.id)):[];
  const offers=[...new Set(payments.map(row=>row.offerCategory??'unknown'))];
  const offerCategory=offers.length===1?offers[0]:'unknown';
  return {...base,offerCategory,scheduleIds:schedules.length===1?[schedules[0].id]:[],totalMinor:reasons.length?null:initial!.totalMinor,state:reasons.length?'pending' as const:'identified' as const,reasons};
 }).sort((a,b)=>(a.signedDay??'9999').localeCompare(b.signedDay??'9999')||a.parcoursId.localeCompare(b.parcoursId));
}
export function contractsInPeriod(contracts:SignedContract[],from:string,to:string){return contracts.filter(row=>row.signedDay&&row.signedDay>=from&&row.signedDay<=to);}
export function contractTotalMinor(contracts:SignedContract[],category?:OfferCategory):number{return contracts.filter(row=>row.state==='identified'&&(!category||row.offerCategory===category)).reduce((sum,row)=>sum+row.totalMinor!,0);}
