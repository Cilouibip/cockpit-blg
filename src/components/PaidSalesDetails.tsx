'use client';
import type { PaidSaleDetail, PaidSalesReport } from '../lib/paid-sales';
import { formatDate, formatNumber } from './ui-format';

const reasons: Record<string,string> = {
  payment_refunded:'Paiement remboursé',
  payment_not_succeeded_or_amount_missing:'Paiement réussi ou montant non établi',
  client_relation_missing_or_ambiguous:'Client à rattacher au paiement',
  subsequent_payment_for_client_or_stable_email:'Paiement suivant d’un client déjà payant',
  subsequent_payment_for_client:'Paiement suivant d’un client déjà payant',
  prior_payment_for_different_client_same_email:'Identité partagée à rapprocher',
  client_email_identity_conflict:'Identité partagée à rapprocher',
  multiple_first_day_payments:'Plusieurs paiements le premier jour',
  same_day_first_payment_ambiguous:'Plusieurs paiements le premier jour',
  multiple_initial_schedule_relations:'Plusieurs ventes possibles pour ce paiement',
  payment_schedule_relation_missing:'Première mensualité retrouvée ; liaison à compléter',
  duo_beneficiary_sale_relation_unresolved:'Vente du binôme à rattacher',
  no_initial_schedule_relation:'Première échéance ou vente au comptant à rattacher',
  explicit_schedule_payment_conflict:'Le paiement et l’échéance ne concordent pas',
};
const noteworthy = (row:PaidSaleDetail) => row.state==='confirmed' ? 'Paiement relié à la première échéance réglée' : row.state==='reconciled' ? 'Client, date et montant concordent ; liaison à compléter' : row.reasons.map(reason=>reasons[reason]).filter(Boolean).join(' · ') || 'Rattachement à examiner';
const notionLink=(value:string|null|undefined)=>{try{if(!value)return null;const url=new URL(value);return url.protocol==='https:'&&(url.hostname==='notion.so'||url.hostname==='www.notion.so')?url.toString():null;}catch{return null;}};
function SourceLink({url,label}:{url:string|null|undefined;label:string}){const href=notionLink(url);return href?<a href={href} target="_blank" rel="noopener noreferrer">{label}</a>:null;}
export default function PaidSalesDetails({report}:{report:PaidSalesReport}){
 const groups=[{state:'confirmed',title:'Ventes identifiées',open:true},{state:'reconciled',title:'Paiements rapprochés — liaison à compléter',open:true},{state:'pending',title:'Cas à rattacher',open:true},{state:'excluded',title:'Autres paiements et remboursements',open:false}] as const;
 return <section className="paid-sales-details" aria-label="Ventes et paiements de la période">
  <p className="results-reason">{report.confirmedInitialSales} ventes identifiées · {report.reconciledInitialSales} paiements rapprochés · {report.pendingInitialPaymentCases} cas à rattacher. Les deux derniers groupes restent hors du compteur principal.</p>
  {groups.map(group=>{const rows=report.details.filter(row=>row.state===group.state);if(!rows.length)return null;return <details className="paid-sales-group" key={group.state} open={group.open}><summary>{group.title} ({rows.length})</summary><div className="results-table-scroll" role="region" aria-label={group.title} tabIndex={0}><table className="a-d-data-table"><thead><tr><th>Client</th><th>Paiement</th><th>Montant reçu</th><th>Rattachement</th></tr></thead><tbody>{rows.map(row=><tr key={row.paymentId}><td>{row.clientName??'Client à identifier'}<div><SourceLink url={row.clientUrl} label="Fiche client" /></div></td><td>{formatDate(row.day)}<div><SourceLink url={row.paymentUrl} label="Voir le paiement" /></div></td><td>{formatNumber(row.amountMinor===null?null:row.amountMinor/100,'eur')}</td><td>{noteworthy(row)}{row.scheduleUrls?.length>0&&<div>{row.scheduleUrls.map((url,i)=><span key={url}><SourceLink url={url} label={row.scheduleUrls.length===1?'Voir l’échéance':`Échéance ${i+1}`} />{' '}</span>)}</div>}</td></tr>)}</tbody></table></div></details>;})}
  {!report.details.length&&<p>Aucun paiement daté dans cette période parmi les données lues.</p>}
 </section>;
}
