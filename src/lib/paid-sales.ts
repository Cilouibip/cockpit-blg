/**
 * A paid sale is a payment-history classification, never a division of cash.
 * The caller supplies only explicit Notion relations. Date/amount coincidence
 * is retained as a reconciliation lead and cannot enter the confirmed count.
 */
export const OFFER_CATEGORIES=['blg90','defi','club','other','unknown'] as const;
export type OfferCategory=typeof OFFER_CATEGORIES[number];
export type ConfirmedByOffer=Record<OfferCategory,number>;
export interface PaidSalePayment {providerId?:string|null;offerCategory?:OfferCategory;offerRaw?:string|null;id:string;notionUrl?:string|null;clientIds:string[];emailKey?:string|null;day:string|null;amountMinor:number|null;status:string}
export interface PaidSaleSchedule {id:string;notionUrl?:string|null;clientIds:string[];paymentIds:string[];day:string|null;amountMinor:number|null;status:string|null;installment:string|null;totalMinor:number|null}
export interface PaidSaleParcours {id:string;clientIds:string[];format:string|null}
export interface PaidSaleClient {id:string;name?:string|null;notionUrl?:string|null;emailKey?:string|null;emailBisKey?:string|null}
export type PaidSaleState='confirmed'|'reconciled'|'pending'|'excluded';
export interface PaidSaleDetail {offerCategory?:OfferCategory;offerRaw?:string|null;paymentId:string;paymentUrl:string|null;clientIds:string[];clientName:string|null;clientUrl:string|null;scheduleIds:string[];scheduleUrls:string[];parcoursIds:string[];day:string|null;amountMinor:number|null;state:PaidSaleState;reasons:string[]}
export interface PaidSalesReport {confirmedByOffer:ConfirmedByOffer;confirmedInitialSales:number;reconciledInitialSales:number;pendingInitialPaymentCases:number;excludedSubsequentPayments:number;refundCases:number;details:PaidSaleDetail[];coverage:{payments:number;schedules:number;parcours:number;unlinkedPayments:number}}
const stable=(values:string[])=>[...new Set(values)].sort();
const paid=(p:PaidSalePayment)=>p.status==='succeeded'&&p.day!==null&&p.amountMinor!==null&&p.amountMinor>0;

export interface PaymentIsolation {conflictingGroups:number;conflictingPaymentIds:Set<string>;affectedPaymentIds:Set<string>;clientConflictFrom:Map<string,string|null>}
/** Identity links are used only to propagate uncertainty, never to merge sales. */
export function isolatePaymentProviderConflicts(input:{payments:PaidSalePayment[];schedules:PaidSaleSchedule[];clients?:PaidSaleClient[]}):PaymentIsolation {
 const parents=new Map<string,string>();
 const root=(node:string):string=>{let next=parents.get(node);if(!next){parents.set(node,node);return node;}while(next!==parents.get(next))next=parents.get(next)!;let current=node;while(parents.get(current)!==next){const prior=parents.get(current)!;parents.set(current,next);current=prior;}return next;};
 const join=(nodes:string[])=>{if(!nodes.length)return;const first=root(nodes[0]);for(const node of nodes)parents.set(root(node),first);};
 const providers=new Map<string,PaidSalePayment[]>();
 for(const p of input.payments){join(['payment:'+p.id,...p.clientIds.map(id=>'client:'+id),...(p.emailKey?['email:'+p.emailKey]:[]),...(p.providerId?['provider:'+p.providerId]:[])]);if(p.providerId){const rows=providers.get(p.providerId)??[];rows.push(p);providers.set(p.providerId,rows);}}
 for(const c of input.clients??[])join(['client:'+c.id,...[c.emailKey,c.emailBisKey].filter((key):key is string=>!!key).map(key=>'email:'+key)]);
 for(const s of input.schedules)join(['schedule:'+s.id,...s.clientIds.map(id=>'client:'+id),...s.paymentIds.map(id=>'payment:'+id)]);
 const signature=(p:PaidSalePayment)=>JSON.stringify([p.day,p.amountMinor,p.status,p.emailKey??null,stable(p.clientIds),p.offerCategory??'unknown',p.offerRaw??null]);
 const conflictingPaymentIds=new Set<string>(),bounds=new Map<string,string|null>();let conflictingGroups=0;
 for(const group of providers.values())if(new Set(group.map(signature)).size>1){conflictingGroups++;for(const p of group){conflictingPaymentIds.add(p.id);const key=root('payment:'+p.id),old=bounds.get(key);bounds.set(key,!p.day||old===null?null:old===undefined||p.day<old?p.day:old);}}
 // An unresolved linked source row prevents claiming an earlier unaffected interval.
 const knownClients=new Set((input.clients??[]).map(c=>c.id)),knownPayments=new Set(input.payments.map(p=>p.id));
 for(const node of parents.keys())if((input.clients&&node.startsWith('client:')&&!knownClients.has(node.slice(7)))||(node.startsWith('payment:')&&!knownPayments.has(node.slice(8)))){const key=root(node);if(bounds.has(key))bounds.set(key,null);}
 // An undated reachable payment or schedule cannot locate the conflict after an earlier sale.
 for(const payment of input.payments)if(!payment.day){const key=root('payment:'+payment.id);if(bounds.has(key))bounds.set(key,null);}
 for(const schedule of input.schedules)if(!schedule.day){const key=root('schedule:'+schedule.id);if(bounds.has(key))bounds.set(key,null);}
 const affectedPaymentIds=new Set<string>(),clientConflictFrom=new Map<string,string|null>();
 for(const p of input.payments){const key=root('payment:'+p.id);if(bounds.has(key)){const from=bounds.get(key)!;if(conflictingPaymentIds.has(p.id)||from===null||!p.day||p.day>=from)affectedPaymentIds.add(p.id);}}
 for(const node of parents.keys())if(node.startsWith('client:')){const key=root(node);if(bounds.has(key))clientConflictFrom.set(node.slice(7),bounds.get(key)!);}
 return {conflictingGroups,conflictingPaymentIds,affectedPaymentIds,clientConflictFrom};
}
export const confirmedSalesByOffer=(details:PaidSaleDetail[]):ConfirmedByOffer=>{const counts=Object.fromEntries(OFFER_CATEGORIES.map(key=>[key,0])) as ConfirmedByOffer;for(const d of details)if(d.state==='confirmed')counts[d.offerCategory??'unknown']++;return counts;};

/** 1/1 cash sales and the first row of a documented payment plan are eligible. Other labels remain pending. */
const initial=(s:PaidSaleSchedule)=>s.status==='Payé'&&(s.installment==='1/1'||s.installment==='1/3');
/** Does not merge people by email: Client is the stable source identity in this report. */
export function buildPaidSalesReport(input:{payments:PaidSalePayment[];schedules:PaidSaleSchedule[];parcours:PaidSaleParcours[];clients?:PaidSaleClient[]}):PaidSalesReport{
 const isolation=isolatePaymentProviderConflicts(input);
 const scheduleByPayment=new Map<string,PaidSaleSchedule[]>(),schedulesByClient=new Map<string,PaidSaleSchedule[]>(),parcoursByClient=new Map<string,string[]>();
 for(const s of input.schedules){for(const id of stable(s.paymentIds)){const rows=scheduleByPayment.get(id)??[];rows.push(s);scheduleByPayment.set(id,rows);}for(const id of stable(s.clientIds)){const rows=schedulesByClient.get(id)??[];rows.push(s);schedulesByClient.set(id,rows);}}
 for(const p of input.parcours)for(const id of stable(p.clientIds)){const rows=parcoursByClient.get(id)??[];rows.push(p.id);parcoursByClient.set(id,rows);}
 const clientById=new Map((input.clients??[]).map(c=>[c.id,c])),emailClients=new Map<string,Set<string>>();
 type Earliest={day:string;ids:Set<string>};const earliestByClient=new Map<string,Earliest>();
 for(const p of input.payments.filter(paid)){
  for(const client of stable(p.clientIds)){const prior=earliestByClient.get(client);if(!prior||p.day!<prior.day)earliestByClient.set(client,{day:p.day!,ids:new Set([p.id])});else if(p.day===prior.day)prior.ids.add(p.id);}
  if(p.emailKey){const ids=emailClients.get(p.emailKey)??new Set<string>();for(const client of p.clientIds)ids.add(client);emailClients.set(p.emailKey,ids);}
 }
 const directCandidates=new Map<string,Set<string>>();
 for(const payment of input.payments.filter(paid)){const clients=stable(payment.clientIds);if(clients.length!==1)continue;const linked=scheduleByPayment.get(payment.id)??[],initials=linked.filter(initial),consistent=initials.filter(s=>s.clientIds.includes(clients[0])&&s.day===payment.day&&s.amountMinor===payment.amountMinor);if(initials.length===1&&consistent.length===1){const key=clients[0]+'\u0000'+payment.day;const ids=directCandidates.get(key)??new Set<string>();ids.add(payment.id);directCandidates.set(key,ids);}}
 const details:PaidSaleDetail[]=input.payments.map((payment):PaidSaleDetail=>{
  const clients=stable(payment.clientIds),directSchedules=scheduleByPayment.get(payment.id)??[],direct=stable(directSchedules.map(s=>s.id)),allSchedules=stable(clients.flatMap(id=>schedulesByClient.get(id)??[]).map(s=>s.id)),parcours=stable(clients.flatMap(id=>parcoursByClient.get(id)??[])),client=clients.length===1?clientById.get(clients[0]):undefined;
  const base={offerCategory:payment.offerCategory??'unknown',offerRaw:payment.offerRaw??null,paymentId:payment.id,paymentUrl:payment.notionUrl??null,clientIds:clients,clientName:client?.name??null,clientUrl:client?.notionUrl??null,scheduleIds:direct,scheduleUrls:stable(directSchedules.map(s=>s.notionUrl).filter((url):url is string=>!!url)),parcoursIds:parcours,day:payment.day,amountMinor:payment.amountMinor};
  if(isolation.affectedPaymentIds.has(payment.id))return {...base,state:'pending',reasons:[isolation.conflictingPaymentIds.has(payment.id)?'payment_provider_conflict':'payment_history_affected_by_provider_conflict']};
  if(payment.status==='refunded')return {...base,state:'excluded',reasons:['payment_refunded']};
  if(!paid(payment))return {...base,state:'excluded',reasons:['payment_not_succeeded_or_amount_missing']};
  if(clients.length!==1)return {...base,state:'pending',reasons:['client_relation_missing_or_ambiguous']};
  const duo=parcours.some(id=>input.parcours.find(p=>p.id===id)?.format==='DUO - binôme');
  const first=earliestByClient.get(clients[0])!,directInitial=directSchedules.filter(initial),consistent=directInitial.filter(s=>s.clientIds.includes(clients[0])&&s.day===payment.day&&s.amountMinor===payment.amountMinor),hasUniqueDirect=directInitial.length===1&&consistent.length===1&&directCandidates.get(clients[0]+'\u0000'+payment.day)?.size===1;
  if(payment.day!>first.day)return {...base,state:'excluded',reasons:['subsequent_payment_for_client']};
  const emailContradictsClient=!!payment.emailKey&&!!client&&(!!client.emailKey||!!client.emailBisKey)&&payment.emailKey!==client.emailKey&&payment.emailKey!==client.emailBisKey;
  if(emailContradictsClient)return {...base,state:'pending',reasons:['payment_email_conflicts_with_client']};
  // A direct payment-to-schedule relation can resolve an otherwise ambiguous
  // same-day record. Email alone cannot merge two explicit Client records.
  if(hasUniqueDirect)return {...base,state:'confirmed',reasons:['first_succeeded_payment_for_client','explicit_payment_to_schedule_relation','paid_initial_schedule']};
  if(first.ids.size>1)return {...base,state:'pending',reasons:['multiple_succeeded_payments_same_client_day']};
  const sharedEmailWithOtherClient=!!payment.emailKey&&[...(emailClients.get(payment.emailKey)??[])].some(id=>id!==clients[0]);
  if(sharedEmailWithOtherClient)return {...base,state:'pending',reasons:['payment_email_identity_conflicts_with_other_client',...(duo?['duo_beneficiary_sale_relation_unresolved']:[])]};
  if(directInitial.length>0)return {...base,state:'pending',reasons:[directInitial.length>1?'multiple_initial_schedule_relations':'direct_schedule_payment_client_date_or_amount_conflict']};
  const corroborated=(schedulesByClient.get(clients[0])??[]).filter(s=>initial(s)&&s.day===payment.day&&s.amountMinor===payment.amountMinor);
  if(corroborated.length===1)return {...base,scheduleIds:stable([...direct,corroborated[0].id]),scheduleUrls:stable([...base.scheduleUrls,...(corroborated[0].notionUrl?[corroborated[0].notionUrl]:[])]),state:'reconciled',reasons:['first_succeeded_payment_for_client','same_client_day_amount_as_paid_initial_schedule','payment_schedule_relation_missing']};
  return {...base,scheduleIds:allSchedules,scheduleUrls:stable((schedulesByClient.get(clients[0])??[]).map(s=>s.notionUrl).filter((url):url is string=>!!url)),state:'pending',reasons:[duo?'duo_beneficiary_sale_relation_unresolved':'no_initial_schedule_relation']};
 }).sort((a,b)=>(a.day??'9999').localeCompare(b.day??'9999')||a.paymentId.localeCompare(b.paymentId));
 return {confirmedByOffer:confirmedSalesByOffer(details),confirmedInitialSales:details.filter(d=>d.state==='confirmed').length,reconciledInitialSales:details.filter(d=>d.state==='reconciled').length,pendingInitialPaymentCases:details.filter(d=>d.state==='pending').length,excludedSubsequentPayments:details.filter(d=>d.reasons.some(r=>r.startsWith('subsequent_payment_for_client'))).length,refundCases:details.filter(d=>d.reasons.includes('payment_refunded')).length,details,coverage:{payments:input.payments.length,schedules:input.schedules.length,parcours:input.parcours.length,unlinkedPayments:details.filter(d=>d.clientIds.length!==1).length}};
}
/** The history remains whole-source; only presentation counters are period-scoped. */
export function selectPaidSalesPeriod(report:PaidSalesReport,from:string,to:string):PaidSalesReport{
 const details=report.details.filter(row=>!!row.day&&row.day>=from&&row.day<=to);
 return {...report,confirmedByOffer:confirmedSalesByOffer(details),confirmedInitialSales:details.filter(d=>d.state==='confirmed').length,reconciledInitialSales:details.filter(d=>d.state==='reconciled').length,pendingInitialPaymentCases:details.filter(d=>d.state==='pending').length,excludedSubsequentPayments:details.filter(d=>d.reasons.some(r=>r.startsWith('subsequent_payment_for_client'))).length,refundCases:details.filter(d=>d.reasons.includes('payment_refunded')).length,details};
}
