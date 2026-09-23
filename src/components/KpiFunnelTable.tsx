'use client';

import { useEffect, useState } from 'react';
import type { KpiFunnelDay, KpiFunnelResponse, KpiFunnelSnapshot } from '../lib/kpi-funnel-contract';
import type { DashboardFilters } from '../lib/ui-contract';
import { filtersQuery } from './ui-format';
import { kpiCommonCoverage, kpiFunnelCsv } from '../lib/kpi-funnel-export';
import { request } from '../lib/cockpit-request';

type FunnelNumbers = Omit<KpiFunnelDay, 'date' | 'partial_day'>;

const count = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
const money = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 0, maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat('fr-FR', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
const day = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
const instant = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });

function shown(value: number | null, unit: 'count' | 'money' = 'count') {
  if (value === null) return <span className="kpi-funnel-missing">Non mesuré</span>;
  return unit === 'money' ? money.format(value) : count.format(value);
}

const plainCount = (value: number | null) => value === null ? 'Non mesuré' : count.format(value);

function ratio(numerator: number | null, denominator: number | null) {
  return numerator === null || denominator === null || denominator <= 0 ? null : numerator / denominator;
}

function cost(spend: number | null, result: number | null) {
  return spend === null || result === null || result <= 0 ? null : spend / result;
}

function context(parts: Array<string | null>) {
  const values = parts.filter((value): value is string => Boolean(value));
  return values.length ? <small>{values.join(' · ')}</small> : null;
}

function metricCells(row: FunnelNumbers) {
  const ctr = ratio(row.link_clicks, row.impressions);
  const cpm = row.impressions !== null && row.impressions > 0 && row.spend_eur !== null ? row.spend_eur / row.impressions * 1000 : null;
  const cpc = cost(row.spend_eur, row.link_clicks);
  const metaBookingCost = cost(row.spend_eur, row.booking_meta_attributed);
  const clickToBooking = ratio(row.booking_confirmed_browser, row.booking_clicks);
  const attendance = ratio(row.calls_held, row.calls_scheduled);
  const offerRate = ratio(row.offers_made, row.calls_held);
  const closeRate = ratio(row.sales, row.offers_made);
  return <>
    <td className="kpi-group-meta">{shown(row.spend_eur, 'money')}</td>
    <td className="kpi-group-meta">{shown(row.impressions)}{context([cpm === null ? null : `${money.format(cpm)} CPM`])}</td>
    <td className="kpi-group-meta">{shown(row.link_clicks)}{context([ctr === null ? null : `${percent.format(ctr)} CTR`, cpc === null ? null : `${money.format(cpc)} / clic`])}</td>
    <td className="kpi-group-meta">{shown(row.landing_page_views)}</td>
    <td className="kpi-group-acquisition kpi-funnel-separated">{shown(row.wix_form_submission_occurrences)}<small>Occurrences confirmées</small></td>
    <td className="kpi-group-acquisition">{shown(row.reached_cta_oral)}</td>
    <td className="kpi-group-acquisition">{shown(row.booking_clicks)}</td>
    <td className="kpi-group-acquisition">{shown(row.booking_confirmed_browser)}{context([clickToBooking === null ? null : `${percent.format(clickToBooking)} des clics bilan`])}</td>
    <td className="kpi-group-acquisition">{shown(row.booking_meta_attributed)}{context([metaBookingCost === null ? null : `${money.format(metaBookingCost)} / RDV Meta`])}</td>
    <td className="kpi-group-commercial kpi-funnel-separated">{shown(row.calls_scheduled)}</td>
    <td className="kpi-group-commercial">{shown(row.calls_held)}{context([attendance === null ? null : `${percent.format(attendance)} de présence`])}</td>
    <td className="kpi-group-commercial">{shown(row.offers_made)}{context([offerRate === null ? null : `${percent.format(offerRate)} des appels tenus`])}</td>
    <td className="kpi-group-commercial">{shown(row.sales)}{context([closeRate === null ? null : `${percent.format(closeRate)} des offres`])}</td>
    <td className="kpi-group-commercial">{shown(row.cash_collected_eur, 'money')}</td>
    <td className="kpi-group-commercial">{shown(row.contracted_revenue_eur, 'money')}</td>
  </>;
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
  const labels: Record<string, string> = { spend_eur:'Dépenses Meta',impressions:'Impressions',link_clicks:'Clics lien',unique_link_clicks_campaign_sum:'Clics uniques additionnés',landing_page_views:'Vues de page Meta',wix_form_submission_occurrences:'Occurrences du formulaire Wix',wix_distinct_contacts:'Contacts Wix distincts',reached_cta_oral:'CTA oral atteint',booking_clicks:'Clics bilan',booking_confirmed_browser:'Confirmation navigateur',booking_meta_attributed:'RDV attribués Meta',calls_scheduled:'Appels prévus',calls_held:'Appels tenus',offers_made:'Offres',sales:'Ventes',cash_collected_eur:'Cash encaissé',contracted_revenue_eur:'CA contracté' };
  const statuses: Record<string, string> = { available:'Disponible',disponible:'Disponible',available_not_paid_attributed:'Disponible, sans attribution publicitaire',missing:'Non mesuré',manquant:'Non mesuré' };
  const sourceLabels: Record<string,string> = {'Meta daily campaign export':'Export quotidien des campagnes Meta','Wix submissions summary':'Synthèse des soumissions Wix','Wix submissions live bounded context read':'Lecture bornée des contextes Wix','PostHog booking cohort':'Cohorte des clics bilan PostHog','Wix email analytics':'Statistiques email Wix','Definitions and limitations':'Définitions et limites'};
  const contextLabels: Record<string,string> = { unresolved_macro_ad_id:'Macro annonce non résolue',missing_context:'Contexte manquant' };
  const wixContext = Object.entries(snapshot.attribution_breakdown.wix_submission_context.selected_first_origin_else_arrival);
  // Une date n’est affichée que si une lecture complète des clics bilan existe : une tentative ne prouve pas la couverture.
  const bookingRead = snapshot.coverage.find(item => item.field_group === 'Clics bilan et confirmations navigateur')?.through ?? null;
  return <details className="kpi-funnel-details"><summary>Sources, fraîcheur et définitions</summary><div className="kpi-funnel-detail-grid"><section><h3>Couverture</h3><ul>{snapshot.coverage.map(item => <li key={item.field_group}><strong>{item.field_group}</strong><span>{statuses[item.status] ?? item.status}{item.stale ? ' · ancien (actualisation en retard)' : ''}{item.last_error ? ' · dernière tentative en échec' : ''}{item.through ? ` · jusqu’au ${instant.format(new Date(item.through))}` : ''}</span>{(item.reason || item.warning) && <p>{item.reason ?? item.warning}</p>}{item.detail && <p>{item.detail}</p>}</li>)}</ul></section><section><h3>Répartition des clics bilan</h3><div className="kpi-attribution"><table><thead><tr><th>Publicité</th><th>Clics bilan</th><th>Confirmations</th></tr></thead><tbody>{snapshot.attribution_breakdown.rows.map((row, index) => <tr key={`${row.ad_id ?? ''}|${row.label}|${index}`}><td>{row.label}</td><td>{count.format(row.booking_click_sessions)}</td><td>{count.format(row.booking_confirmed_browser)}</td></tr>)}</tbody></table></div><p className="kpi-detail-note">{snapshot.attribution_breakdown.metric} · {bookingRead ? `lu jusqu’au ${instant.format(new Date(bookingRead))}` : 'aucune lecture complète des clics bilan sur la période'}.</p><h3 className="kpi-subheading">Contexte Wix retenu</h3><div className="kpi-context-list">{wixContext.map(([label,value]) => <span key={label}><strong>{contextLabels[label] ?? label}</strong>{count.format(value)}</span>)}</div><p className="kpi-detail-note">Première origine lorsqu’elle existe, sinon arrivée. {snapshot.attribution_breakdown.wix_submission_context.interpretation}</p></section><section><h3>Sources</h3><ul>{snapshot.source_locators.map(item => <li key={`${item.source}-${item.locator}`}><strong>{sourceLabels[item.source] ?? item.source}</strong><span>{item.locator}</span></li>)}</ul></section><section className="kpi-funnel-definitions"><h3>Définitions</h3><dl>{Object.entries(snapshot.definitions).map(([key, value]) => <div key={key}><dt>{labels[key] ?? key}</dt><dd>{value}</dd></div>)}</dl></section></div></details>;
}

/** Heure de couverture de chaque bloc, visible sans ouvrir le détail : « à jour » ou « ancien » selon la cadence de son flux. */
function CoverageStrip({ snapshot }: { snapshot: KpiFunnelSnapshot }) {
  const statuses: Record<string, string> = { available:'Disponible', disponible:'Disponible', missing:'Non mesuré', manquant:'Non mesuré' };
  return <ul className="kpi-funnel-coverage" aria-label="Couverture par bloc, heure de Paris">{snapshot.coverage.map(item => {
    const state = item.through ? (item.stale ? 'ancien' : 'à jour') : null;
    return <li key={item.field_group} className={item.stale ? 'is-stale' : ['available','disponible'].includes(item.status) ? 'is-fresh' : 'is-missing'}><strong>{item.field_group}</strong><span>{[statuses[item.status] ?? item.status, state, item.through ? `jusqu’au ${instant.format(new Date(item.through))}` : null].filter(Boolean).join(' · ')}</span></li>;
  })}</ul>;
}

function ReadyTable({ snapshot }: { snapshot: KpiFunnelSnapshot }) {
  const meta = snapshot.metadata;
  const common = kpiCommonCoverage(snapshot);
  const delayed = snapshot.coverage.some(item => item.stale || item.last_error);
  const headline = `${instant.format(new Date(meta.window_start))} → ${instant.format(new Date(meta.window_end_meta))}`;
  const download = () => { const url = URL.createObjectURL(new Blob([kpiFunnelCsv(snapshot)], { type:'text/csv;charset=utf-8' })); const link=document.createElement('a');link.href=url;link.download=`blg-kpi-${meta.window_start.slice(0,10)}-${meta.window_end_meta.slice(0,10)}.csv`;link.click();URL.revokeObjectURL(url); };
  return <section className="a-d-stage kpi-funnel" aria-labelledby="kpi-funnel-title"><header className="kpi-funnel-heading"><div><span className="blg-eyebrow">SUIVI AUTOMATIQUE · MASTERCLASS</span><h2 id="kpi-funnel-title">Suivi quotidien du funnel</h2><p>{headline} · heure de Paris</p></div><div><span className="kpi-funnel-badge">Lecture automatique</span><button className="a-button a-secondary" onClick={download}>Exporter pour Excel</button></div></header><div className="kpi-funnel-notes"><p><strong>{delayed ? 'Certaines sources attendent une mise à jour.' : 'Derniers relevés disponibles.'}</strong> {common.through ? `Couverture commune : ${instant.format(new Date(common.through))}, heure de Paris (plus ancienne des sources disponibles).` : 'Aucun bloc n’est mesuré sur toute la période.'} Chaque bloc indique ci-dessous sa propre heure.</p><p>La période et les filtres sélectionnés s’appliquent à la masterclass. Chaque bloc garde sa propre source et sa fraîcheur.</p><p>{plainCount(snapshot.totals.wix_form_submission_occurrences)} occurrences Wix : {plainCount(snapshot.totals.wix_distinct_contacts)} contacts distincts et {plainCount(snapshot.totals.wix_repeat_occurrences)} répétitions. Conversion page et CPL restent indisponibles.</p></div><CoverageStrip snapshot={snapshot} /><div className="kpi-funnel-scroll" tabIndex={0} aria-label="Tableau quotidien du funnel, défilement horizontal"><table><thead><tr><th rowSpan={2}>Jour</th><th className="kpi-group-heading kpi-group-meta" colSpan={4}>Publicité Meta</th><th className="kpi-group-heading kpi-group-acquisition" colSpan={5}>Inscription et rendez-vous</th><th className="kpi-group-heading kpi-group-commercial" colSpan={6}>Commercial et revenu</th></tr><tr><th className="kpi-group-meta">Dépenses</th><th className="kpi-group-meta">Impressions</th><th className="kpi-group-meta">Clics lien</th><th className="kpi-group-meta">Vues page</th><th className="kpi-group-acquisition kpi-funnel-separated">Occurrences Wix</th><th className="kpi-group-acquisition">CTA oral atteint</th><th className="kpi-group-acquisition">Clics bilan</th><th className="kpi-group-acquisition">Confirmation navigateur</th><th className="kpi-group-acquisition">RDV attribués Meta</th><th className="kpi-group-commercial kpi-funnel-separated">Appels prévus</th><th className="kpi-group-commercial">Appels tenus</th><th className="kpi-group-commercial">Offres</th><th className="kpi-group-commercial">Ventes</th><th className="kpi-group-commercial">Cash encaissé</th><th className="kpi-group-commercial">CA contracté</th></tr></thead><tbody><tr className="kpi-funnel-total"><th scope="row"><strong>Total</strong><small>Fenêtre du relevé</small></th>{metricCells(snapshot.totals)}</tr>{snapshot.daily.map(row => <tr key={row.date}><th scope="row"><strong>{day.format(new Date(`${row.date}T12:00:00+02:00`))}</strong>{partialLabel(row.partial_day) && <small>{partialLabel(row.partial_day)}</small>}</th>{metricCells(row)}</tr>)}</tbody></table></div><p className="kpi-funnel-legend"><strong>RDV attribués Meta</strong> désigne la conversion publicitaire Meta. La confirmation navigateur, l’appel prévu, l’appel tenu et le client restent des mesures distinctes. « Non mesuré » ne signifie jamais zéro.</p><EmailSummary snapshot={snapshot} /><SnapshotDetails snapshot={snapshot} /></section>;
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
  return <>{controls}{error&&<p role="alert">{error} La dernière lecture de cette sélection reste affichée.</p>}{response.status==='ready'?<ReadyTable snapshot={response.snapshot}/>:<section className="a-d-stage kpi-funnel kpi-funnel-empty"><h2>Suivi quotidien du funnel</h2><p>{response.message}</p></section>}</>;
}
