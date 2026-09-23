import type { KpiCountField, KpiFunnelDay, KpiFunnelSnapshot, KpiFunnelSummary, KpiRatioKey } from './kpi-funnel-contract';
const parisParts = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** Instant lisible à la minute, heure de Paris (« 22/09/2026 14:55 »). Une valeur illisible est rendue telle quelle. */
export function parisMinute(value: string | null | undefined): string {
 if (!value) return '';
 const date = new Date(value);
 if (Number.isNaN(date.getTime())) return String(value);
 const p = Object.fromEntries(parisParts.formatToParts(date).map(part => [part.type, part.value]));
 return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}
/** Jour civil lisible (« 23/09/2026 »). */
export const frenchDay = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
/** Couverture commune du tableau : la plus ancienne heure de couverture parmi les blocs disponibles (D3). */
export function kpiCommonCoverage(snapshot: KpiFunnelSnapshot): { through: string | null; stale: boolean } {
 const available = snapshot.coverage.filter(item => item.through && ['available','disponible'].includes(item.status));
 const oldest = available.sort((a,b)=>Date.parse(a.through!)-Date.parse(b.through!))[0];
 return { through: oldest?.through ?? null, stale: available.some(item => item.stale === true) };
}

// Colonnes de l'Excel de référence (A→AI, V vide) : ordre, intitulés métier, groupes et définitions.
export type KpiGroupKey = 'publicite'|'inscription'|'video'|'formulaire'|'reservation'|'appels'|'offres'|'ventes';
export const KPI_GROUPS: { key: KpiGroupKey; label: string }[] = [
 { key: 'publicite', label: 'Publicité' }, { key: 'inscription', label: 'Inscription' }, { key: 'video', label: 'Vidéo' }, { key: 'formulaire', label: 'Formulaire' },
 { key: 'reservation', label: 'Réservation' }, { key: 'appels', label: 'Appels' }, { key: 'offres', label: 'Offres' }, { key: 'ventes', label: 'Ventes' },
];
export type KpiFormat = 'count'|'money'|'percent'|'multiple'|'na';
export interface KpiColumn { id: string; excel: string; label: string; group: KpiGroupKey; format: KpiFormat; field?: KpiCountField; ratio?: KpiRatioKey; derived?: 'repeats'; definition: string }
const NOT_APPLICABLE = 'Sans objet dans ce tunnel : aucun formulaire entre la vidéo et l’appel (le formulaire d’inscription est compté dans « Inscrits » ; un clic vers le calendrier n’est pas un formulaire envoyé). En attente d’arbitrage (ambiguïté 4, Mehdi) : colonne grisée conservée.';
export const KPI_NOT_APPLICABLE_REASON = NOT_APPLICABLE;
export const KPI_EXCEL_COLUMNS: KpiColumn[] = [
 { id: 'spend_eur', excel: 'B', label: 'Dépense', group: 'publicite', format: 'money', field: 'spend_eur', definition: 'Dépense Meta des campagnes Masterclass identifiées, par jour de diffusion, en euros.' },
 { id: 'impressions', excel: 'C', label: 'Impressions', group: 'publicite', format: 'count', field: 'impressions', definition: 'Impressions Meta des campagnes Masterclass, par jour.' },
 { id: 'cpm', excel: 'D', label: 'CPM', group: 'publicite', format: 'money', ratio: 'cpm', definition: 'Dépense × 1 000 / impressions, même jour, même bloc.' },
 { id: 'link_clicks', excel: 'E', label: 'Clics lien', group: 'publicite', format: 'count', field: 'link_clicks', definition: 'Clics sur le lien de la publicité (Meta inline_link_clicks), pas les clics de tous types (ambiguïté 1 : « Clics » de l’Excel = clics lien, règle actée, à confirmer).' },
 { id: 'ctr', excel: 'F', label: 'CTR', group: 'publicite', format: 'percent', ratio: 'ctr', definition: 'Clics lien / impressions, même jour.' },
 { id: 'cpc', excel: 'G', label: 'CPC', group: 'publicite', format: 'money', ratio: 'cpc', definition: 'Dépense / clics lien, même jour.' },
 { id: 'ctru', excel: 'H', label: 'CTRU', group: 'publicite', format: 'percent', ratio: 'ctru', definition: 'CTR unique Meta : comptes ayant cliqué le lien / comptes touchés (reach) ; les jours ne s’additionnent pas. Récapitulatifs : lecture Meta de la fenêtre entière (niveau compte, campagnes Masterclass), jamais une moyenne ni une somme de jours. Aucun repère affiché : la mesure visée par Marc reste à confirmer (ambiguïté 2).' },
 { id: 'registrants', excel: 'I', label: 'Inscrits', group: 'inscription', format: 'count', field: 'registrants', definition: 'Contacts distincts (clé de contact) parmi les soumissions confirmées et éligibles du formulaire Masterclass du jour, essais exclus. Récapitulatifs : contacts distincts de la fenêtre, les jours ne s’additionnent pas. Proposition par défaut (ambiguïté 3), en attente de confirmation par Mehdi ; l’alternative « nouveaux contacts » n’est pas appliquée. Non mesuré si une soumission n’a pas de clé de contact.' },
 { id: 'registrants_per_click', excel: 'J', label: 'Inscrits / clics', group: 'inscription', format: 'percent', ratio: 'registrants_per_click', definition: 'Inscrits / clics lien Meta (pas des visites), calculé seulement si Meta et les inscriptions couvrent le jour (D3).' },
 { id: 'cost_per_registrant', excel: 'K', label: 'Coût par inscrit', group: 'inscription', format: 'money', ratio: 'cost_per_registrant', definition: 'Dépense / inscrits du même jour ; Meta et inscriptions couvrent le jour (D3).' },
 { id: 'reached_cta_oral', excel: 'L', label: 'Vues du CTA', group: 'video', format: 'count', field: 'reached_cta_oral', definition: 'Personnes ayant atteint le passage de la vidéo où la réservation est proposée (ni démarrage, ni bouton vu, ni clic). Non mesuré : aucun signal validé (responsable : Mehdi et Codex).' },
 { id: 'cta_views_per_registrant', excel: 'M', label: 'Vues CTA / inscrits', group: 'video', format: 'percent', ratio: 'cta_views_per_registrant', definition: 'Vues du CTA / inscrits ; non mesuré tant que les vues du CTA ne le sont pas.' },
 { id: 'cost_per_cta_view', excel: 'N', label: 'Coût par vue du CTA', group: 'video', format: 'money', ratio: 'cost_per_cta_view', definition: 'Dépense / vues du CTA ; non mesuré tant que les vues du CTA ne le sont pas.' },
 { id: 'forms', excel: 'O', label: 'Formulaires', group: 'formulaire', format: 'na', definition: NOT_APPLICABLE },
 { id: 'forms_per_cta_view', excel: 'P', label: 'Formulaires / vues CTA', group: 'formulaire', format: 'na', definition: NOT_APPLICABLE },
 { id: 'cost_per_form', excel: 'Q', label: 'Coût par formulaire', group: 'formulaire', format: 'na', definition: NOT_APPLICABLE },
 { id: 'calls_booked', excel: 'R', label: 'Appels réservés', group: 'reservation', format: 'count', field: 'calls_booked', definition: 'Réservations des inscrits de la période, datées au jour de réservation à Paris (date de réservation explicite de Notion, jamais la création de la fiche ni le jour du call), essais exclus ; une réservation annulée ou reportée ensuite reste comptée une fois à sa date, comme la carte Résultats « Réservés · date de réservation ». Un clic, une confirmation navigateur ou une conversion Meta ne comptent jamais.' },
 { id: 'booked_per_cta_view', excel: 'S', label: 'Réservés / vues du CTA', group: 'reservation', format: 'percent', ratio: 'booked_per_cta_view', definition: 'Appels réservés / vues du CTA (remplace « formulaires » de l’Excel, ambiguïté 4) ; non mesuré tant que les vues du CTA ne le sont pas.' },
 { id: 'cost_per_booking', excel: 'T', label: 'Coût par réservation', group: 'reservation', format: 'money', ratio: 'cost_per_booking', definition: 'Dépense du même jour / appels réservés du jour (l’Excel divisait la dépense de la veille : corrigé) ; Meta et Notion couvrent le jour (D3).' },
 { id: 'registrant_to_booked', excel: 'U', label: 'Inscrits → réservés', group: 'reservation', format: 'percent', ratio: 'registrant_to_booked', definition: 'Appels réservés / inscrits du même jour ; Notion et inscriptions couvrent le jour (D3).' },
 { id: 'calls_scheduled', excel: 'W', label: 'Appels planifiés', group: 'appels', format: 'count', field: 'calls_scheduled', definition: 'Créneaux effectifs (ni annulés ni reportés) des inscrits de la période, datés au jour du call.' },
 { id: 'calls_held', excel: 'X', label: 'Appels réalisés', group: 'appels', format: 'count', field: 'calls_held', definition: 'Présences classées dans Notion, datées au jour du call.' },
 { id: 'attendance', excel: 'Y', label: 'Présence', group: 'appels', format: 'percent', ratio: 'attendance', definition: 'Appels réalisés / appels planifiés du même jour.' },
 { id: 'offers_made', excel: 'Z', label: 'Offres faites', group: 'offres', format: 'count', field: 'offers_made', definition: 'Offre commerciale faite lors de l’appel. Non mesuré : aucun champ source validé (responsable : Jérôme avec Codex).' },
 { id: 'offers_per_call_held', excel: 'AA', label: 'Offres / appels réalisés', group: 'offres', format: 'percent', ratio: 'offers_per_call_held', definition: 'Offres faites / appels réalisés ; non mesuré tant que les offres ne le sont pas.' },
 { id: 'cost_per_offer', excel: 'AB', label: 'Coût par offre', group: 'offres', format: 'money', ratio: 'cost_per_offer', definition: 'Dépense / offres faites ; non mesuré tant que les offres ne le sont pas.' },
 { id: 'sales', excel: 'AC', label: 'Ventes', group: 'ventes', format: 'count', field: 'sales', definition: 'Premières ventes payées confirmées des inscrits de la période, à la date du paiement.' },
 { id: 'close_rate', excel: 'AD', label: 'Ventes / offres', group: 'ventes', format: 'percent', ratio: 'close_rate', definition: 'Ventes / offres faites (« closing rate » de l’Excel) ; non mesuré tant que les offres ne le sont pas. La variante mesurable « Ventes / appels réalisés » est dans le détail (ambiguïté 5).' },
 { id: 'cost_per_customer', excel: 'AE', label: 'Coût par client', group: 'ventes', format: 'money', ratio: 'cost_per_customer', definition: 'Dépense / ventes ; Meta et ventes couvrent le jour (D3).' },
 { id: 'cash_collected_eur', excel: 'AF', label: 'Cash encaissé', group: 'ventes', format: 'money', field: 'cash_collected_eur', definition: 'Paiements confirmés (et paiements ultérieurs du même client) avant remboursements, à la date du paiement.' },
 { id: 'contracted_revenue_eur', excel: 'AG', label: 'CA contracté', group: 'ventes', format: 'money', field: 'contracted_revenue_eur', definition: 'Montant contractuel. Non mesuré : aucune source alignée (responsable : lot finance de la suite).' },
 { id: 'roas_cash', excel: 'AH', label: 'ROAS cash', group: 'ventes', format: 'multiple', ratio: 'roas_cash', definition: 'Cash encaissé / dépense ; ventes et Meta couvrent le jour (D3).' },
 { id: 'roas', excel: 'AI', label: 'ROAS', group: 'ventes', format: 'multiple', ratio: 'roas', definition: 'CA contracté / dépense ; non mesuré tant que le CA contracté ne l’est pas.' },
];
/** Mesures du tableau précédent sans équivalent dans l'Excel : détail et fin du CSV. */
export const KPI_DETAIL_COLUMNS: Omit<KpiColumn,'excel'|'group'>[] = [
 { id: 'wix_form_submission_occurrences', label: 'Inscriptions (soumissions)', format: 'count', field: 'wix_form_submission_occurrences', definition: 'Soumissions confirmées du formulaire Masterclass, répétitions conservées.' },
 { id: 'repeats', label: 'Répétitions', format: 'count', derived: 'repeats', definition: 'Soumissions − inscrits (même contact inscrit plusieurs fois dans le jour ou la fenêtre).' },
 { id: 'landing_page_views', label: 'Vues de page Meta', format: 'count', field: 'landing_page_views', definition: 'Vues de landing attribuées par Meta ; différentes des visites mesurées sur le site.' },
 { id: 'outbound_clicks', label: 'Clics sortants', format: 'count', field: 'outbound_clicks', definition: 'Clics sortants Meta (outbound_clicks) des campagnes Masterclass.' },
 { id: 'outbound_click_rate', label: 'Clics sortants / impressions', format: 'percent', ratio: 'outbound_click_rate', definition: 'Clics sortants / impressions, même jour. Mesure distincte du CTR unique (ambiguïté 2) ; aucun repère affiché.' },
 { id: 'meta_reach', label: 'Comptes touchés (reach)', format: 'count', field: 'meta_reach', definition: 'Comptes Meta ayant vu au moins une publicité Masterclass (niveau compte, dédoublonné entre campagnes) ; fenêtre lue entière, jamais une somme de jours.' },
 { id: 'meta_unique_link_clicks', label: 'Comptes ayant cliqué le lien', format: 'count', field: 'meta_unique_link_clicks', definition: 'Comptes Meta ayant cliqué le lien (unique_inline_link_clicks, niveau compte) ; jamais une somme de jours ni de campagnes.' },
 { id: 'booking_clicks', label: 'Clics bilan', format: 'count', field: 'booking_clicks', definition: 'Sessions de production (PostHog), datées au premier clic bilan ; ce ne sont pas des réservations.' },
 { id: 'booking_confirmed_browser', label: 'Confirmations navigateur', format: 'count', field: 'booking_confirmed_browser', definition: 'Sessions avec confirmation du calendrier dans le navigateur ; distinctes des appels réservés.' },
 { id: 'booking_confirmation_rate', label: 'Clics bilan → confirmation', format: 'percent', ratio: 'booking_confirmation_rate', definition: 'Confirmations navigateur / clics bilan, même jour.' },
 { id: 'booking_meta_attributed', label: 'RDV attribués Meta', format: 'count', field: 'booking_meta_attributed', definition: 'Conversion personnalisée Meta « RDV Calendly BLG HOMME », 7 jours clic / 1 jour vue, au jour de l’impression ; distincte d’une réservation.' },
 { id: 'cost_per_meta_booking', label: 'Coût par RDV Meta', format: 'money', ratio: 'cost_per_meta_booking', definition: 'Dépense / RDV attribués Meta, même jour.' },
 { id: 'sales_per_call_held', label: 'Ventes / appels réalisés', format: 'percent', ratio: 'sales_per_call_held', definition: 'Ventes / appels réalisés (variante mesurable, jamais présentée comme « closing rate », ambiguïté 5).' },
];
export type KpiRow = KpiFunnelDay | KpiFunnelSummary;
/** Valeur d'une cellule telle qu'affichée et exportée : nombre, null (non mesuré) ou « sans objet ». */
export function kpiCellValue(row: KpiRow, column: Pick<KpiColumn,'format'|'field'|'ratio'|'derived'>): number | null | 'na' {
 if (column.format === 'na') return 'na';
 if (column.ratio) return row.ratios[column.ratio];
 if (column.derived === 'repeats') return row.wix_form_submission_occurrences === null || row.registrants === null ? null : row.wix_form_submission_occurrences - row.registrants;
 return column.field ? row[column.field] : null;
}
/** Motif d'une cellule non mesurée (taux : motif calculé ; compte : motif du jour, sinon aucun). */
export function kpiCellReason(row: KpiRow, column: Pick<KpiColumn,'format'|'field'|'ratio'|'id'>): string | null {
 if (column.format === 'na') return NOT_APPLICABLE;
 return row.reasons[column.ratio ?? column.field ?? column.id] ?? null;
}
const round = (value: number, digits: number) => { const factor = 10 ** digits; return Math.round(value * factor) / factor; };
/** Valeur CSV : taux en pourcentage décimal (virgule, lisible par Excel), coûts à deux décimales, null jamais converti en zéro. */
function csvNumber(value: number | null | 'na', format: KpiFormat): unknown {
 if (value === 'na') return 'Sans objet';
 if (value === null) return null;
 return format === 'percent' ? round(value * 100, 2) : format === 'money' || format === 'multiple' ? round(value, 2) : value;
}
const csvHeader = (column: { label: string; format: KpiFormat }) => column.format === 'percent' ? `${column.label} (%)` : column.format === 'money' ? `${column.label} (EUR)` : column.label;
const statusLabel = (status: string) => ({ available:'Disponible', disponible:'Disponible', missing:'Non mesuré', manquant:'Non mesuré' } as Record<string,string>)[status] ?? status;
/** Export the exact displayed snapshot: no second query and no conversion of null to zero. UTF-8 CSV opens in Excel. */
export function kpiFunnelCsv(snapshot: KpiFunnelSnapshot): string {
 const cell = (value: unknown) => { const text = value === null || value === undefined ? 'Non mesuré' : typeof value === 'number' ? String(value).replace('.',',') : String(value); return '"' + text.replace(/^[=+@-]/, "'$&").replaceAll('"','""') + '"'; };
 const common = kpiCommonCoverage(snapshot);
 const lines: unknown[][] = [['BLG · masterclass',snapshot.metadata.window_start,snapshot.metadata.window_end_meta],['Lecture',snapshot.metadata.generated_at],['Couverture commune (plus ancienne des sources disponibles, heure de Paris)',common.through?parisMinute(common.through):'Aucun bloc complet sur la période',common.through?(common.stale?'Au moins une source ancienne':'Sources à jour'):'']];
 // Ordre et intitulés de l'Excel (A→AI, V vide), puis les colonnes du détail.
 const excel = KPI_EXCEL_COLUMNS.flatMap(column => column.excel === 'W' ? [null, column] : [column]);
 lines.push(['Jour', ...excel.map(column => column ? csvHeader(column) : ''), ...KPI_DETAIL_COLUMNS.map(csvHeader)]);
 const rowCells = (label: string, row: KpiRow) => [label, ...excel.map(column => column ? csvNumber(kpiCellValue(row, column), column.format) : ''), ...KPI_DETAIL_COLUMNS.map(column => csvNumber(kpiCellValue(row, column), column.format))];
 for (const summary of snapshot.summaries) lines.push(rowCells(summary.label, summary));
 for (const day of snapshot.daily) lines.push(rowCells(frenchDay(day.date), day));
 lines.push(['Lecture des récapitulatifs','Sommes des jours puis taux des sommes, jamais une moyenne de taux. Inscrits : contacts distincts de la fenêtre (les jours ne s’additionnent pas). CTRU : lecture Meta de la fenêtre entière, sinon non mesuré. Un jour non mesuré rend la somme non mesurée.']);
 lines.push([],['Inscriptions Wix','Occurrences','Contacts distincts','Répétitions'],['Total de la période',snapshot.totals.wix_form_submission_occurrences,snapshot.totals.wix_distinct_contacts,snapshot.totals.wix_repeat_occurrences]);
 lines.push([],['Sources','État','Actualisation','Données lues jusqu’au (heure de Paris)','Dernière tentative (heure de Paris)','Dernière erreur','Limite','Responsable et prochaine étape']);
 for (const row of snapshot.coverage) lines.push([row.field_group,statusLabel(row.status),row.through?(row.stale?'Ancienne':'À jour'):'',parisMinute(row.through),parisMinute(row.last_attempt),row.last_error??'',row.reason??row.warning??'',row.detail??'']);
 lines.push([],['Emails','Envoyés','Livrés','Ouvertures','Clics']);
 const all=snapshot.email_summary.all_three_forms,cohort=snapshot.email_summary.facebook_form_recipient_filter;
 lines.push(['Séquence complète',all.sent,all.delivered,all.opens_sum_by_message,all.clicks_sum_by_message],['Contacts de la landing',cohort.sent,cohort.delivered,cohort.opens,cohort.clicks]);
 lines.push([],['Définitions']);for(const [key,value] of Object.entries(snapshot.definitions))lines.push([key,value]);
 return '﻿'+lines.map(line=>line.map(cell).join(';')).join('\r\n');
}
