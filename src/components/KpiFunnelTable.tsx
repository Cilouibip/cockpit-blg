'use client';

import { useEffect, useState } from 'react';
import type { KpiFunnelResponse, KpiFunnelSnapshot } from '../lib/kpi-funnel-contract';
import type { DashboardFilters } from '../lib/ui-contract';
import { filtersQuery } from './ui-format';
import { KPI_DETAIL_COLUMNS, KPI_EXCEL_COLUMNS, KPI_GROUPS, frenchDay, kpiCellReason, kpiCellValue, kpiCommonCoverage, kpiFunnelCsv, type KpiColumn, type KpiGroupKey, type KpiRow } from '../lib/kpi-funnel-export';
import { request } from '../lib/cockpit-request';
import { CURRENT_MASTERCLASS_CAMPAIGNS } from '../lib/current-campaigns';

const count = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
const money = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 0, maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat('fr-FR', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 2 });
const multiple = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const unitCost = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
const instant = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });

function shown(value: number | null, unit: 'count' | 'money' = 'count') {
  if (value === null) return <span className="kpi-funnel-missing">Non mesuré</span>;
  return unit === 'money' ? money.format(value) : count.format(value);
}

const plainCount = (value: number | null) => value === null ? 'Non mesuré' : count.format(value);

/** Cellule : valeur formatée, « Non mesuré » avec son motif en info-bulle, ou « Sans objet » grisé. */
function cellContent(row: KpiRow, column: Pick<KpiColumn,'id'|'format'|'field'|'ratio'|'derived'>) {
  const value = kpiCellValue(row, column), reason = kpiCellReason(row, column) ?? undefined;
  if (value === 'na') return <span className="kpi-funnel-na" title={reason}>Sans objet</span>;
  if (value === null) return <span className="kpi-funnel-missing" title={reason}>Non mesuré</span>;
  return column.format === 'money' ? (column.ratio ? unitCost : money).format(value) : column.format === 'percent' ? percent.format(value) : column.format === 'multiple' ? multiple.format(value) : count.format(value);
}
function focusedCell(row: KpiRow, column: Pick<KpiColumn,'id'|'format'|'field'|'ratio'|'derived'>) {
  const value = kpiCellValue(row, column);
  if (value === null || value === 'na') return <span className="kpi-funnel-missing" title={kpiCellReason(row, column) ?? undefined}>—</span>;
  return column.format === 'money' ? (column.ratio ? unitCost : money).format(value) : column.format === 'percent' ? percent.format(value) : column.format === 'multiple' ? multiple.format(value) : count.format(value);
}

const groupSize = (group: KpiGroupKey) => KPI_EXCEL_COLUMNS.filter(column => column.group === group).length;
const firstOfGroup = (index: number) => index === 0 || KPI_EXCEL_COLUMNS[index - 1].group !== KPI_EXCEL_COLUMNS[index].group;

function rowHeader(row: KpiRow) {
  if ('key' in row) {
    const [name, dates] = row.label.split(' · ');
    return <th scope="row"><strong>{name}</strong><small>{dates}</small>{row.partial_day && <small>{row.partial_day}</small>}</th>;
  }
  return <th scope="row"><strong>{day.format(new Date(`${row.date}T12:00:00+02:00`))}</strong>{partialLabel(row.partial_day) && <small>{partialLabel(row.partial_day)}</small>}</th>;
}
function focusedRowHeader(row: KpiRow) {
  if ('key' in row) {
    const [name, dates] = row.label.split(' · ');
    return <th scope="row"><strong>{name}</strong><small>{dates}</small></th>;
  }
  return <th scope="row"><strong>{day.format(new Date(`${row.date}T12:00:00+02:00`))}</strong></th>;
}

function ExcelRow({ row }: { row: KpiRow }) {
  return <tr className={'key' in row ? `kpi-funnel-total kpi-funnel-summary kpi-summary-${row.key}` : undefined}>{rowHeader(row)}{KPI_EXCEL_COLUMNS.map((column, index) => <td key={column.id} className={`kpi-g-${column.group}${firstOfGroup(index) ? ' kpi-funnel-separated' : ''}${column.format === 'na' ? ' kpi-funnel-na-cell' : ''}`}>{cellContent(row, column)}</td>)}</tr>;
}
function FocusedExcelRow({ row }: { row: KpiRow }) {
  return <tr className={'key' in row ? `kpi-funnel-total kpi-funnel-summary kpi-summary-${row.key}` : undefined}>{focusedRowHeader(row)}{KPI_EXCEL_COLUMNS.map((column, index) => <td key={column.id} className={`kpi-g-${column.group}${firstOfGroup(index) ? ' kpi-funnel-separated' : ''}${column.format === 'na' ? ' kpi-funnel-na-cell' : ''}`}>{focusedCell(row, column)}</td>)}</tr>;
}

/** Mesures sans équivalent dans l'Excel : par jour et par récapitulatif, dans le détail. */
function DetailMeasures({ snapshot }: { snapshot: KpiFunnelSnapshot }) {
  const rows: KpiRow[] = [...snapshot.summaries, ...snapshot.daily];
  return <section className="kpi-funnel-detail-measures"><h3>Autres mesures par jour</h3><div className="kpi-attribution kpi-detail-scroll" tabIndex={0} aria-label="Autres mesures par jour, défilement horizontal"><table><thead><tr><th scope="col">Jour</th>{KPI_DETAIL_COLUMNS.map(column => <th key={column.id} scope="col" title={column.definition}>{column.label}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={'key' in row ? row.key : row.date}>{'key' in row ? <th scope="row">{row.label}</th> : <th scope="row">{day.format(new Date(`${row.date}T12:00:00+02:00`))}</th>}{KPI_DETAIL_COLUMNS.map(column => <td key={column.id}>{cellContent(row, column)}</td>)}</tr>)}</tbody></table></div><p className="kpi-detail-note">Ces mesures restent dans l’export. « Ventes / appels réalisés » est une variante mesurable, jamais présentée comme le taux de closing de l’Excel (ventes / offres).</p></section>;
}

function partialLabel(value: string | null) {
  if (value === 'from_20_00_paris') return 'À partir de 20 h';
  if (value === 'through_16_58_paris') return 'Jusqu’à 16 h 58';
  return value;
}

function EmailSummary({ snapshot }: { snapshot: KpiFunnelSnapshot }) {
  const landingContacts = plainCount(snapshot.email_summary.facebook_form_recipient_filter.distinct_emails);
  const rows = [
    { label:'Ensemble de la séquence · 3 formulaires', submissions:null, distinct:null, sent:snapshot.email_summary.all_three_forms.sent, delivered:snapshot.email_summary.all_three_forms.delivered, opens:snapshot.email_summary.all_three_forms.opens_sum_by_message, clicks:snapshot.email_summary.all_three_forms.clicks_sum_by_message, note:'Totaux cumulés par message' },
    { label:landingContacts==='Non mesuré'?'Emails aux contacts de cette landing':`Emails aux ${landingContacts} contacts de cette landing`, submissions:snapshot.email_summary.facebook_form_recipient_filter.submissions, distinct:snapshot.email_summary.facebook_form_recipient_filter.distinct_emails, sent:snapshot.email_summary.facebook_form_recipient_filter.sent, delivered:snapshot.email_summary.facebook_form_recipient_filter.delivered, opens:snapshot.email_summary.facebook_form_recipient_filter.opens, clicks:snapshot.email_summary.facebook_form_recipient_filter.clicks, note:'Activité des contacts de cette landing' },
  ];
  return <section className="kpi-email" aria-labelledby="kpi-email-title"><div><span className="blg-eyebrow">SOURCE · WIX</span><h3 id="kpi-email-title">Emails de suivi</h3></div><div className="kpi-email-scroll"><table><thead><tr><th>Groupe</th><th>Soumissions</th><th>Emails distincts</th><th>Envoyés</th><th>Livrés</th><th>Ouvertures</th><th>Clics</th></tr></thead><tbody>{rows.map(row => <tr key={row.label}><td>{row.label}<small>{row.note}</small></td><td>{row.submissions === null ? '—' : count.format(row.submissions)}</td><td>{row.distinct === null ? '—' : count.format(row.distinct)}</td><td>{shown(row.sent)}</td><td>{shown(row.delivered)}</td><td>{shown(row.opens)}</td><td>{shown(row.clicks)}</td></tr>)}</tbody></table></div><p>Une personne peut recevoir plusieurs emails. Les ouvertures et les clics sont cumulés par message : ils ne représentent pas des personnes uniques. Le filtre des destinataires ne prouve pas quel formulaire a déclenché chaque message.</p></section>;
}

function SnapshotDetails({ snapshot }: { snapshot: KpiFunnelSnapshot }) {
  const labels: Record<string, string> = { ...Object.fromEntries([...KPI_EXCEL_COLUMNS, ...KPI_DETAIL_COLUMNS].map(column => [column.id, column.label])), unique_link_clicks_campaign_sum: 'Clics uniques additionnés (relevé seulement)', wix_distinct_contacts: 'Contacts distincts de la période' };
  const statuses: Record<string, string> = { available:'Disponible',disponible:'Disponible',available_not_paid_attributed:'Disponible, sans attribution publicitaire',missing:'Non mesuré',manquant:'Non mesuré' };
  const sourceLabels: Record<string,string> = {'Meta daily campaign export':'Export quotidien des campagnes Meta','Wix submissions summary':'Synthèse des soumissions Wix','Wix submissions live bounded context read':'Lecture bornée des contextes Wix','PostHog booking cohort':'Cohorte des clics bilan PostHog','Wix email analytics':'Statistiques email Wix','Definitions and limitations':'Définitions et limites'};
  const contextLabels: Record<string,string> = { unresolved_macro_ad_id:'Macro annonce non résolue',missing_context:'Contexte manquant' };
  const wixContext = Object.entries(snapshot.attribution_breakdown.wix_submission_context.selected_first_origin_else_arrival);
  // Une date n’est affichée que si une lecture complète des clics bilan existe : une tentative ne prouve pas la couverture.
  const bookingRead = snapshot.coverage.find(item => item.field_group === 'Clics bilan et confirmations navigateur')?.through ?? null;
  return <details className="kpi-funnel-details"><summary>Sources, fraîcheur et définitions</summary><div className="kpi-funnel-detail-grid"><DetailMeasures snapshot={snapshot} /><section><h3>Couverture</h3><ul>{snapshot.coverage.map(item => <li key={item.field_group}><strong>{item.field_group}</strong><span>{statuses[item.status] ?? item.status}{item.stale ? ' · ancien (actualisation en retard)' : ''}{item.last_error ? ' · dernière tentative en échec' : ''}{item.through ? ` · jusqu’au ${instant.format(new Date(item.through))}` : ''}</span>{(item.reason || item.warning) && <p>{item.reason ?? item.warning}</p>}{item.detail && <p>{item.detail}</p>}</li>)}</ul></section><section><h3>Répartition des clics bilan</h3><div className="kpi-attribution"><table><thead><tr><th>Publicité</th><th>Clics bilan</th><th>Confirmations</th></tr></thead><tbody>{snapshot.attribution_breakdown.rows.map((row, index) => <tr key={`${row.ad_id ?? ''}|${row.label}|${index}`}><td>{row.label}</td><td>{count.format(row.booking_click_sessions)}</td><td>{count.format(row.booking_confirmed_browser)}</td></tr>)}</tbody></table></div><p className="kpi-detail-note">{snapshot.attribution_breakdown.metric} · {bookingRead ? `lu jusqu’au ${instant.format(new Date(bookingRead))}` : 'aucune lecture complète des clics bilan sur la période'}.</p><h3 className="kpi-subheading">Contexte Wix retenu</h3><div className="kpi-context-list">{wixContext.map(([label,value]) => <span key={label}><strong>{contextLabels[label] ?? label}</strong>{count.format(value)}</span>)}</div><p className="kpi-detail-note">Première origine lorsqu’elle existe, sinon arrivée. {snapshot.attribution_breakdown.wix_submission_context.interpretation}</p></section><section><h3>Sources</h3><ul>{snapshot.source_locators.map(item => <li key={`${item.source}-${item.locator}`}><strong>{sourceLabels[item.source] ?? item.source}</strong><span>{item.locator}</span></li>)}</ul></section><section className="kpi-funnel-definitions"><h3>Définitions</h3><dl>{Object.entries(snapshot.definitions).map(([key, value]) => <div key={key}><dt>{labels[key] ?? key}</dt><dd>{value}</dd></div>)}</dl></section></div></details>;
}

/** Heure de couverture de chaque bloc, visible sans ouvrir le détail : « à jour » ou « ancien » selon la cadence de son flux. */
function CoverageStrip({ snapshot }: { snapshot: KpiFunnelSnapshot }) {
  const statuses: Record<string, string> = { available:'Disponible', disponible:'Disponible', missing:'Non mesuré', manquant:'Non mesuré' };
  return <ul className="kpi-funnel-coverage" aria-label="Couverture par bloc, heure de Paris">{snapshot.coverage.map(item => {
    const state = item.through ? (item.stale ? 'ancien' : 'à jour') : null;
    return <li key={item.field_group} className={item.stale ? 'is-stale' : ['available','disponible'].includes(item.status) ? 'is-fresh' : 'is-missing'}><strong>{item.field_group}</strong><span>{[statuses[item.status] ?? item.status, state, item.through ? `jusqu’au ${instant.format(new Date(item.through))}` : null].filter(Boolean).join(' · ')}</span></li>;
  })}</ul>;
}

const SUMMARY_COLUMNS = ['spend_eur','ctru','registrants','cost_per_registrant','calls_booked','cost_per_booking','registrant_to_booked','sales'] as const;
const STAGES = [
  { id:'publicite', label:'Publicité', groups:['publicite'] },
  { id:'inscription', label:'Inscription', groups:['inscription'] },
  { id:'video', label:'Vidéo', groups:['video'] },
  { id:'rdv', label:'Rendez-vous', groups:['formulaire','reservation','appels'] },
  { id:'commercial', label:'Commercial et finance', groups:['offres','ventes'] },
] as const;

function FocusedSummary({ snapshot, campaignLabel }: { snapshot: KpiFunnelSnapshot; campaignLabel: string }) {
  const [stage, setStage] = useState<(typeof STAGES)[number]['id']>('publicite');
  const [showAll, setShowAll] = useState(false);
  const summary = snapshot.summaries.find(row => row.key === 'global');
  const selected = STAGES.find(item => item.id === stage)!;
  const columns = KPI_EXCEL_COLUMNS.filter(column => (selected.groups as readonly string[]).includes(column.group));
  const days = showAll ? snapshot.daily : snapshot.daily.slice(-7);
  if (!summary) return null;
  return <>
    <section className="a-d-stage results-kpis kpi-focused-summary" aria-label={`Synthèse ${campaignLabel}`}>
      <header className="kpi-funnel-heading"><div><span className="blg-eyebrow">MASTERCLASS · {campaignLabel.toLocaleUpperCase('fr')}</span><h2>Synthèse</h2><p>{frenchDay(summary.from)} — {frenchDay(summary.to)}</p></div></header>
      <div className="a-d-cards">{SUMMARY_COLUMNS.map(id => { const column = KPI_EXCEL_COLUMNS.find(item => item.id === id)!; return <article className="a-d-card results-kpi" key={id}><h3>{column.label}</h3><div className="a-d-value">{focusedCell(summary,column)}</div><div className="results-card-foot"><span>{frenchDay(summary.from)} — {frenchDay(summary.to)}</span></div></article>; })}</div>
    </section>
    <section className="a-d-stage kpi-funnel kpi-focused-stage" aria-labelledby="kpi-stage-title">
      <header className="kpi-funnel-heading"><div><span className="blg-eyebrow">PARCOURS · MASTERCLASS</span><h2 id="kpi-stage-title">Détail par étape</h2><p>{frenchDay(summary.from)} — {frenchDay(summary.to)}</p></div></header>
      <div className="a-t-viewbar"><div className="a-t-views kpi-stage-tabs" role="tablist" aria-label="Étape du parcours">{STAGES.map(item => <button className="a-t-view" key={item.id} type="button" role="tab" aria-pressed={stage === item.id} aria-selected={stage === item.id} onClick={() => setStage(item.id)}>{item.label}</button>)}</div></div>
      <div className="kpi-funnel-scroll" tabIndex={0} aria-label={`Détail ${selected.label}, défilement horizontal`}><table className="kpi-stage-table"><thead><tr><th scope="col">Jour</th>{columns.map(column => <th key={column.id} scope="col" title={column.definition}>{column.label}</th>)}</tr></thead><tbody>{[summary,...days].map(row => <tr key={'key' in row ? row.key : row.date} className={'key' in row ? 'kpi-funnel-total' : undefined}>{focusedRowHeader(row)}{columns.map(column => <td key={column.id}>{focusedCell(row,column)}</td>)}</tr>)}</tbody></table></div>
      {snapshot.daily.length > 7 && <div className="kpi-stage-more"><button type="button" className="a-button a-secondary" onClick={() => setShowAll(value => !value)}>{showAll ? 'Voir 7 jours' : `Voir tous les jours (${snapshot.daily.length})`}</button></div>}
    </section>
  </>;
}

function ReadyTable({ snapshot, campaignLabel }: { snapshot: KpiFunnelSnapshot; campaignLabel?: string }) {
  const meta = snapshot.metadata;
  const common = kpiCommonCoverage(snapshot);
  const delayed = snapshot.coverage.some(item => item.stale || item.last_error);
  const oldest = snapshot.coverage.filter(item => item.through).map(item => item.through!).sort((a,b)=>Date.parse(a)-Date.parse(b))[0];
  const headline = `${instant.format(new Date(meta.window_start))} → ${instant.format(new Date(meta.window_end_meta))}`;
  const download = () => { const url = URL.createObjectURL(new Blob([kpiFunnelCsv(snapshot)], { type:'text/csv;charset=utf-8' })); const link=document.createElement('a');link.href=url;link.download=`blg-kpi-${meta.window_start.slice(0,10)}-${meta.window_end_meta.slice(0,10)}.csv`;link.click();URL.revokeObjectURL(url); };
  return <>{campaignLabel && <FocusedSummary snapshot={snapshot} campaignLabel={campaignLabel} />}<section className="a-d-stage kpi-funnel" aria-labelledby="kpi-funnel-title"><header className="kpi-funnel-heading"><div><span className="blg-eyebrow">SUIVI QUOTIDIEN · MASTERCLASS</span><h2 id="kpi-funnel-title">Suivi quotidien du funnel</h2><p>{headline} · heure de Paris</p></div><div><button className="a-button a-secondary" onClick={download}>Exporter pour Excel</button></div></header>{!campaignLabel && <><div className="kpi-funnel-notes"><p><strong>{delayed ? 'Certaines sources attendent une mise à jour.' : 'Derniers relevés disponibles.'}</strong> {common.through ? `Lecture la plus ancienne des blocs disponibles (couverture commune) : ${instant.format(new Date(common.through))}, heure de Paris.` : oldest ? `Lecture la plus ancienne : ${instant.format(new Date(oldest))}, heure de Paris ; aucun bloc n’est complet sur toute la période.` : 'Aucune lecture complète sur la période.'} Chaque bloc indique ci-dessous sa propre heure.</p><p>La période et les filtres sélectionnés s’appliquent à la masterclass. Chaque bloc garde sa propre source et sa fraîcheur.</p><p>{plainCount(snapshot.totals.wix_form_submission_occurrences)} soumissions du formulaire : {plainCount(snapshot.totals.registrants)} inscrits (contacts distincts) et {plainCount(snapshot.totals.wix_repeat_occurrences)} répétitions sur la période. Récapitulatifs : sommes des jours puis taux des sommes ; inscrits et CTRU relus sur la fenêtre entière, jamais additionnés ni moyennés.</p></div><CoverageStrip snapshot={snapshot} /></>}<div className="kpi-funnel-scroll" tabIndex={0} aria-label="Tableau quotidien du funnel, défilement horizontal"><table className="kpi-funnel-excel"><thead><tr><th rowSpan={2} scope="col">Jour</th>{KPI_GROUPS.map(group => <th key={group.key} scope="colgroup" colSpan={groupSize(group.key)} className={`kpi-group-heading kpi-g-${group.key} kpi-funnel-separated`}>{group.label}</th>)}</tr><tr>{KPI_EXCEL_COLUMNS.map((column, index) => <th key={column.id} scope="col" title={column.definition} className={`kpi-g-${column.group}${firstOfGroup(index) ? ' kpi-funnel-separated' : ''}${column.format === 'na' ? ' kpi-funnel-na-cell' : ''}`}>{column.label}</th>)}</tr></thead><tbody>{snapshot.summaries.map(summary => campaignLabel ? <FocusedExcelRow key={summary.key} row={summary} /> : <ExcelRow key={summary.key} row={summary} />)}{snapshot.daily.map(row => campaignLabel ? <FocusedExcelRow key={row.date} row={row} /> : <ExcelRow key={row.date} row={row} />)}</tbody></table></div>{!campaignLabel && <p className="kpi-funnel-legend">« Non mesuré » ne signifie jamais zéro : survoler la cellule pour lire le motif et le responsable. Un taux ou un coût qui croise deux sources n’est calculé que si chacune couvre le jour, ou toute la fenêtre pour un récapitulatif. <strong>Sans objet</strong> : étape absente de ce tunnel, colonne conservée en attente d’arbitrage. Les définitions s’affichent au survol des en-têtes ; les mesures sans équivalent dans l’Excel (vues de page Meta, clics bilan, confirmations navigateur, RDV attribués Meta, soumissions et répétitions) sont dans le détail et dans l’export.</p>}{!campaignLabel && <EmailSummary snapshot={snapshot} />}<SnapshotDetails snapshot={snapshot} /></section></>;
}

/** Rendu d’un relevé prêt, exporté pour les tests de rendu serveur. */
export { ReadyTable as KpiFunnelReadyTable };

export default function KpiFunnelTable({ filters, revision = 0 }: { filters: DashboardFilters; revision?: number }) {
  const [includeTests,setIncludeTests]=useState(false);
  const query = `${filtersQuery(filters)}&includeTests=${includeTests}`;
  const [loaded,setLoaded]=useState<{query:string;value:KpiFunnelResponse}|null>(null);
  const [failure,setFailure]=useState<{query:string;message:string}|null>(null);
  useEffect(() => {
    const controller=new AbortController();let busy=false;
    const read=async()=>{if(busy)return;busy=true;try{const value=await request<KpiFunnelResponse>(`/api/kpi-funnel?${query}`,{signal:controller.signal});if(!controller.signal.aborted){setLoaded({query,value});setFailure(null);}}catch(value){if(!controller.signal.aborted)setFailure({query,message:value instanceof Error?value.message:'La lecture a échoué.'});}finally{busy=false;}};
    void read();const timer=window.setInterval(()=>{if(document.visibilityState==='visible')void read();},60000);
    return()=>{controller.abort();window.clearInterval(timer);};
  },[query,revision]);
  const response=loaded?.query===query?loaded.value:null,error=failure?.query===query?failure.message:'';
  const controls=<label className="kpi-funnel-tests"><input type="checkbox" checked={includeTests} onChange={e=>setIncludeTests(e.target.checked)} /> Inclure les essais explicitement marqués</label>;
  if(!response)return <section className="a-d-stage kpi-funnel kpi-funnel-empty"><h2>Suivi quotidien du funnel</h2>{controls}<p role="status">{error||'Lecture des données…'}</p></section>;
  const campaignLabel = CURRENT_MASTERCLASS_CAMPAIGNS.find(campaign => filters.campaign === `meta:${campaign.id}`)?.label;
  return <>{controls}{error&&<p role="alert">{error} La dernière lecture de cette sélection reste affichée.</p>}{response.status==='ready'?<ReadyTable snapshot={response.snapshot} campaignLabel={campaignLabel}/>:<section className="a-d-stage kpi-funnel kpi-funnel-empty"><h2>Suivi quotidien du funnel</h2><p>{response.message}</p></section>}</>;
}
