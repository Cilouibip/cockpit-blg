/** A candidate is usable only when a source has already established the sale. */
export interface ContractedRevenueCandidate {
 saleId:string|null;
 saleDate:string|null;
 totalMinor:number|null;
 scheduleIds:string[];
 beneficiaryClientIds:string[];
}
export interface ContractedRevenueSale {saleId:string;saleDate:string;totalMinor:number;scheduleIds:string[];beneficiaryClientIds:string[]}
export interface ContractedRevenueProjection {
 candidates:ContractedRevenueSale[];
 incomplete:{missingSaleId:number;missingSaleDate:number;missingTotal:number;missingScheduleLink:number;conflictingSaleEvidence:number};
 contractedMinor:number|null;
}
export interface ContractedRevenueSchedule {id:string;paymentIds:string[];totalMinor:number|null;beneficiaryClientIds:string[]}
export interface ContractedRevenuePayment {id:string;parcoursIds:string[]}
export interface ContractedRevenueParcours {id:string;closingDay:string|null}
export interface ContractedRevenueRelationMapping {
 candidates:ContractedRevenueSale[];
 incomplete:{withoutPaymentRelation:number;unmappedLinkedSchedules:number;ambiguousScheduleRelations:number;missingClosing:number;missingTotal:number;conflictingTotals:number};
 contractedMinor:number|null;
}
const stable=(values:string[])=>[...new Set(values)].sort();
/**
 * This projection never derives a sale from a payment status, an installment
 * number, a Client, or an installment date. Several schedule rows and several
 * DUO beneficiaries can describe the same explicitly identified sale.
 */
export function projectContractedRevenue(rows:ContractedRevenueCandidate[]):ContractedRevenueProjection{
 const incomplete={missingSaleId:0,missingSaleDate:0,missingTotal:0,missingScheduleLink:0,conflictingSaleEvidence:0};
 const grouped=new Map<string,ContractedRevenueCandidate[]>();
 for(const row of rows){
  if(!row.saleId){incomplete.missingSaleId++;continue;}
  if(!row.saleDate){incomplete.missingSaleDate++;continue;}
  if(row.totalMinor===null||!Number.isSafeInteger(row.totalMinor)||row.totalMinor<=0){incomplete.missingTotal++;continue;}
  if(row.scheduleIds.length===0){incomplete.missingScheduleLink++;continue;}
  const group=grouped.get(row.saleId)??[];group.push(row);grouped.set(row.saleId,group);
 }
 const candidates:ContractedRevenueSale[]=[];
 for(const [saleId,group] of grouped){
  const dates=stable(group.map(row=>row.saleDate!)),totals=stable(group.map(row=>String(row.totalMinor)));
  if(dates.length!==1||totals.length!==1){incomplete.conflictingSaleEvidence++;continue;}
  candidates.push({saleId,saleDate:dates[0],totalMinor:Number(totals[0]),scheduleIds:stable(group.flatMap(row=>row.scheduleIds)),beneficiaryClientIds:stable(group.flatMap(row=>row.beneficiaryClientIds))});
 }
 candidates.sort((a,b)=>a.saleDate.localeCompare(b.saleDate)||a.saleId.localeCompare(b.saleId));
 const hasIncomplete=Object.values(incomplete).some(value=>value>0);
 return {candidates,incomplete,contractedMinor:hasIncomplete?null:candidates.reduce((sum,sale)=>sum+sale.totalMinor,0)};
}
/**
 * Uses only the established Échéancier → Paiements → Parcours relation. A
 * Parcours ID is the candidate sale ID; its Date de closing is retained as the
 * source candidate date. Any unlinked or ambiguous schedule keeps the total
 * unavailable rather than being guessed from its Client, amount or due date.
 */
export function mapContractedRevenueRelations(input:{schedules:ContractedRevenueSchedule[];payments:ContractedRevenuePayment[];parcours:ContractedRevenueParcours[]}):ContractedRevenueRelationMapping{
 const payments=new Map(input.payments.map(row=>[row.id,row])),parcours=new Map(input.parcours.map(row=>[row.id,row]));
 const incomplete={withoutPaymentRelation:0,unmappedLinkedSchedules:0,ambiguousScheduleRelations:0,missingClosing:0,missingTotal:0,conflictingTotals:0};
 const grouped=new Map<string,ContractedRevenueSchedule[]>();
 for(const schedule of input.schedules){
  if(schedule.paymentIds.length===0){incomplete.withoutPaymentRelation++;continue;}
  const ids=stable(schedule.paymentIds.flatMap(id=>payments.get(id)?.parcoursIds??[]));
  if(ids.length===0){incomplete.unmappedLinkedSchedules++;continue;}
  if(ids.length!==1){incomplete.ambiguousScheduleRelations++;continue;}
  const rows=grouped.get(ids[0])??[];rows.push(schedule);grouped.set(ids[0],rows);
 }
 const candidates:ContractedRevenueSale[]=[];
 for(const [saleId,rows] of grouped){
  const saleDate=parcours.get(saleId)?.closingDay;
  if(!saleDate){incomplete.missingClosing++;continue;}
  const totals=stable(rows.filter(row=>row.totalMinor!==null&&Number.isSafeInteger(row.totalMinor)&&row.totalMinor!>0).map(row=>String(row.totalMinor)));
  if(totals.length===0){incomplete.missingTotal++;continue;}
  if(totals.length!==1){incomplete.conflictingTotals++;continue;}
  candidates.push({saleId,saleDate,totalMinor:Number(totals[0]),scheduleIds:stable(rows.map(row=>row.id)),beneficiaryClientIds:stable(rows.flatMap(row=>row.beneficiaryClientIds))});
 }
 candidates.sort((a,b)=>a.saleDate.localeCompare(b.saleDate)||a.saleId.localeCompare(b.saleId));
 return {candidates,incomplete,contractedMinor:Object.values(incomplete).some(value=>value>0)?null:candidates.reduce((sum,sale)=>sum+sale.totalMinor,0)};
}
