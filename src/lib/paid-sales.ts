/**
 * A paid sale is a payment-history classification, never a division of cash.
 * The caller supplies only explicit Notion relations. Date/amount coincidence
 * is retained as a reconciliation lead and cannot enter the confirmed count.
 */
export interface PaidSalePayment {id:string;notionUrl?:string|null;clientIds:string[];emailKey?:string|null;day:string|null;amountMinor:number|null;status:string}
export interface PaidSaleSchedule {id:string;notionUrl?:string|null;clientIds:string[];paymentIds:string[];day:string|null;amountMinor:number|null;status:string|null;installment:string|null;totalMinor:number|null}
export interface PaidSaleParcours {id:string;clientIds:string[];format:string|null}
export interface PaidSaleClient {id:string;name?:string|null;notionUrl?:string|null;emailKey?:string|null;emailBisKey?:string|null}
export type PaidSaleState='confirmed'|'reconciled'|'pending'|'excluded';
export interface PaidSaleDetail {paymentId:string;paymentUrl:string|null;clientIds:string[];clientName:string|null;clientUrl:string|null;scheduleIds:string[];scheduleUrls:string[];parcoursIds:string[];day:string|null;amountMinor:number|null;state:PaidSaleState;reasons:string[]}
export interface PaidSalesReport {confirmedInitialSales:number;reconciledInitialSales:number;pendingInitialPaymentCases:number;excludedSubsequentPayments:number;refundCases:number;details:PaidSaleDetail[];coverage:{payments:number;schedules:number;parcours:number;unlinkedPayments:number}}
const stable=(values:string[])=>[...new Set(values)].sort();
const paid=(p:PaidSalePayment)=>p.status==='succeeded'&&p.day!==null&&p.amountMinor!==null&&p.amountMinor>0;
/** 1/1 cash sales and the first row of a documented payment plan are eligible. Other labels remain pending. */
const initial=(s:PaidSaleSchedule)=>s.status==='Payé'&&(s.installment==='1/1'||s.installment==='1/3');
/** Does not merge people by email: Client is the stable source identity in this report. */
export function buildPaidSalesReport(input:{payments:PaidSalePayment[];schedules:PaidSaleSchedule[];parcours:PaidSaleParcours[];clients?:PaidSaleClient[]}):PaidSalesReport{
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
  const base={paymentId:payment.id,paymentUrl:payment.notionUrl??null,clientIds:clients,clientName:client?.name??null,clientUrl:client?.notionUrl??null,scheduleIds:direct,scheduleUrls:stable(directSchedules.map(s=>s.notionUrl).filter((url):url is string=>!!url)),parcoursIds:parcours,day:payment.day,amountMinor:payment.amountMinor};
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
 return {confirmedInitialSales:details.filter(d=>d.state==='confirmed').length,reconciledInitialSales:details.filter(d=>d.state==='reconciled').length,pendingInitialPaymentCases:details.filter(d=>d.state==='pending').length,excludedSubsequentPayments:details.filter(d=>d.reasons.some(r=>r.startsWith('subsequent_payment_for_client'))).length,refundCases:details.filter(d=>d.reasons.includes('payment_refunded')).length,details,coverage:{payments:input.payments.length,schedules:input.schedules.length,parcours:input.parcours.length,unlinkedPayments:details.filter(d=>d.clientIds.length!==1).length}};
}
/** The history remains whole-source; only presentation counters are period-scoped. */
export function selectPaidSalesPeriod(report:PaidSalesReport,from:string,to:string):PaidSalesReport{
 const details=report.details.filter(row=>!!row.day&&row.day>=from&&row.day<=to);
 return {...report,confirmedInitialSales:details.filter(d=>d.state==='confirmed').length,reconciledInitialSales:details.filter(d=>d.state==='reconciled').length,pendingInitialPaymentCases:details.filter(d=>d.state==='pending').length,excludedSubsequentPayments:details.filter(d=>d.reasons.some(r=>r.startsWith('subsequent_payment_for_client'))).length,refundCases:details.filter(d=>d.reasons.includes('payment_refunded')).length,details};
}
