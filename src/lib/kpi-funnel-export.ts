import type { KpiFunnelSnapshot } from './kpi-funnel-contract';
/** Export the exact displayed snapshot: no second query and no conversion of null to zero. UTF-8 CSV opens in Excel. */
export function kpiFunnelCsv(snapshot: KpiFunnelSnapshot): string {
 const columns = [['date','Jour'],['spend_eur','Dépenses Meta EUR'],['impressions','Impressions'],['link_clicks','Clics lien'],['landing_page_views','Vues page Meta'],['wix_form_submission_occurrences','Occurrences Wix'],['reached_cta_oral','CTA oral atteint'],['booking_clicks','Clics bilan'],['booking_confirmed_browser','Confirmations navigateur'],['booking_meta_attributed','RDV Meta'],['calls_scheduled','Appels prévus'],['calls_held','Appels tenus'],['offers_made','Offres'],['sales','Ventes'],['cash_collected_eur','Cash EUR'],['contracted_revenue_eur','CA contracté EUR']] as const;
 const cell = (value: unknown) => { const text = value === null || value === undefined ? 'Non mesuré' : typeof value === 'number' ? String(value).replace('.',',') : String(value); return '"' + text.replace(/^[=+@-]/, "'$&").replaceAll('"','""') + '"'; };
 const lines: unknown[][] = [['BLG · masterclass',snapshot.metadata.window_start,snapshot.metadata.window_end_meta],['Lecture',snapshot.metadata.generated_at],columns.map(c=>c[1])];
 for (const row of [{date:'Total',...snapshot.totals},...snapshot.daily]) lines.push(columns.map(([key])=>row[key]));
 lines.push([],['Sources','État','Données lues jusqu’au','Dernière tentative','Limite']);
 for (const row of snapshot.coverage) lines.push([row.field_group,row.status,row.through??'',row.last_attempt??'',row.reason??row.detail??'']);
 lines.push([],['Emails','Envoyés','Livrés','Ouvertures','Clics']);
 const all=snapshot.email_summary.all_three_forms,cohort=snapshot.email_summary.facebook_form_recipient_filter;
 lines.push(['Séquence complète',all.sent,all.delivered,all.opens_sum_by_message,all.clicks_sum_by_message],['Contacts de la landing',cohort.sent,cohort.delivered,cohort.opens,cohort.clicks]);
 lines.push([],['Définitions']);for(const [key,value] of Object.entries(snapshot.definitions))lines.push([key,value]);
 return '\uFEFF'+lines.map(line=>line.map(cell).join(';')).join('\r\n');
}
