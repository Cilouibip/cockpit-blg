import type { KpiFunnelSnapshot } from './kpi-funnel-contract';
const parisParts = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** Instant lisible à la minute, heure de Paris (« 22/09/2026 14:55 »). Une valeur illisible est rendue telle quelle. */
export function parisMinute(value: string | null | undefined): string {
 if (!value) return '';
 const date = new Date(value);
 if (Number.isNaN(date.getTime())) return String(value);
 const p = Object.fromEntries(parisParts.formatToParts(date).map(part => [part.type, part.value]));
 return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}
/** Couverture commune du tableau : la plus ancienne heure de couverture parmi les blocs disponibles (D3). */
export function kpiCommonCoverage(snapshot: KpiFunnelSnapshot): { through: string | null; stale: boolean } {
 const available = snapshot.coverage.filter(item => item.through && ['available','disponible'].includes(item.status));
 const oldest = available.sort((a,b)=>Date.parse(a.through!)-Date.parse(b.through!))[0];
 return { through: oldest?.through ?? null, stale: available.some(item => item.stale === true) };
}
const statusLabel = (status: string) => ({ available:'Disponible', disponible:'Disponible', missing:'Non mesuré', manquant:'Non mesuré' } as Record<string,string>)[status] ?? status;
/** Export the exact displayed snapshot: no second query and no conversion of null to zero. UTF-8 CSV opens in Excel. */
export function kpiFunnelCsv(snapshot: KpiFunnelSnapshot): string {
 const columns = [['date','Jour'],['spend_eur','Dépenses Meta EUR'],['impressions','Impressions'],['link_clicks','Clics lien'],['landing_page_views','Vues page Meta'],['wix_form_submission_occurrences','Occurrences Wix'],['reached_cta_oral','CTA oral atteint'],['booking_clicks','Clics bilan'],['booking_confirmed_browser','Confirmations navigateur'],['booking_meta_attributed','RDV Meta'],['calls_scheduled','Appels prévus'],['calls_held','Appels tenus'],['offers_made','Offres'],['sales','Ventes'],['cash_collected_eur','Cash EUR'],['contracted_revenue_eur','CA contracté EUR']] as const;
 const cell = (value: unknown) => { const text = value === null || value === undefined ? 'Non mesuré' : typeof value === 'number' ? String(value).replace('.',',') : String(value); return '"' + text.replace(/^[=+@-]/, "'$&").replaceAll('"','""') + '"'; };
 const common = kpiCommonCoverage(snapshot);
 const lines: unknown[][] = [['BLG · masterclass',snapshot.metadata.window_start,snapshot.metadata.window_end_meta],['Lecture',snapshot.metadata.generated_at],['Couverture commune (plus ancienne des sources disponibles, heure de Paris)',common.through?parisMinute(common.through):'Aucun bloc complet sur la période',common.through?(common.stale?'Au moins une source ancienne':'Sources à jour'):''],columns.map(c=>c[1])];
 for (const row of [{date:'Total',...snapshot.totals},...snapshot.daily]) lines.push(columns.map(([key])=>row[key]));
 lines.push([],['Inscriptions Wix','Occurrences','Contacts distincts','Répétitions'],['Total de la période',snapshot.totals.wix_form_submission_occurrences,snapshot.totals.wix_distinct_contacts,snapshot.totals.wix_repeat_occurrences]);
 lines.push([],['Sources','État','Actualisation','Données lues jusqu’au (heure de Paris)','Dernière tentative (heure de Paris)','Dernière erreur','Limite','Responsable et prochaine étape']);
 for (const row of snapshot.coverage) lines.push([row.field_group,statusLabel(row.status),row.through?(row.stale?'Ancienne':'À jour'):'',parisMinute(row.through),parisMinute(row.last_attempt),row.last_error??'',row.reason??row.warning??'',row.detail??'']);
 lines.push([],['Emails','Envoyés','Livrés','Ouvertures','Clics']);
 const all=snapshot.email_summary.all_three_forms,cohort=snapshot.email_summary.facebook_form_recipient_filter;
 lines.push(['Séquence complète',all.sent,all.delivered,all.opens_sum_by_message,all.clicks_sum_by_message],['Contacts de la landing',cohort.sent,cohort.delivered,cohort.opens,cohort.clicks]);
 lines.push([],['Définitions']);for(const [key,value] of Object.entries(snapshot.definitions))lines.push([key,value]);
 return '﻿'+lines.map(line=>line.map(cell).join(';')).join('\r\n');
}
