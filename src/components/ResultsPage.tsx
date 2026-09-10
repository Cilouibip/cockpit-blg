'use client';

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { DashboardFilters, DashboardResponse, DetailRow, DetailsResponse, Metric } from '../lib/ui-contract';
import { matchingPeriod, resultPeriods, type PeriodId } from './result-periods';
import { filtersQuery, formatDate, formatNumber, validateDateRange } from './ui-format';
import { resultCopy, resultMessage, resultSource, resultState } from './result-copy';
import PaidSalesDetails from './PaidSalesDetails';
import type {PostHogClientState} from '../lib/posthog-report-client';

// Atelier A: A.11.4 cards/curve, A.10.3 tables/filters, A.04.2 hierarchy and A.08 dialogs.
// Presentation only. The API remains the authority for amounts, ratios and availability.
const name = (metric: Metric) => resultCopy[metric.id]?.label ?? metric.label;
const sourceName = (source: string) => ({ paid: 'Publicité', organic: 'Organique', unknown: 'Source non renseignée' }[source] ?? source);
function Arrow({ down = false }: { down?: boolean }) { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d={down ? 'm6 9 6 6 6-6' : 'm9 5 7 7-7 7'} /></svg>; }

export function ResultDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null); const id = useId();
  useEffect(() => { const opener = document.activeElement as HTMLElement | null; const node = ref.current; node?.showModal(); return () => { node?.close(); if (opener?.isConnected) opener.focus(); }; }, []);
  return <dialog ref={ref} className="a-r-dialog results-drawer" aria-labelledby={id} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === ref.current) onClose(); }}><header className="a-r-dialog-head"><h2 id={id}>{title}</h2><button className="a-button a-secondary results-close" onClick={onClose} aria-label="Fermer le détail">×</button></header><div className="a-r-dialog-body">{children}</div></dialog>;
}

export function DemoIndicator() {
  const [open, setOpen] = useState(false);
  return <><button className="results-demo" onClick={() => setOpen(true)} aria-label="Démo — en savoir plus">Démo <span aria-hidden="true">ⓘ</span></button>{open && <ResultDialog title="Espace de démonstration" onClose={() => setOpen(false)}><p>Les chiffres, prospects et connexions présentés ici sont fictifs. Ils permettent d’essayer le cockpit et ses filtres.</p><p>Aucune donnée réelle de l’activité n’est affichée dans cet espace.</p></ResultDialog>}</>;
}

export function ResultsFilters({ draft, applied, onChange, onApply, campaigns, busy, error }: { draft: DashboardFilters; applied: DashboardFilters; onChange: (value: DashboardFilters) => void; onApply: (event: FormEvent) => void; campaigns: DashboardResponse['campaigns']; busy: boolean; error: string }) {
  const [open, setOpen] = useState(false); const id = useId();
  const [period, setPeriod] = useState<PeriodId>(() => matchingPeriod(draft.from, draft.to));
  const periods = resultPeriods();
  function choosePeriod(value: PeriodId) {
    setPeriod(value);
    const selected = periods.find(p => p.id === value);
    if (selected) onChange({ ...draft, from: selected.from, to: selected.to });
  }
  const count = Number(applied.source !== 'all') + Number(applied.tunnel !== 'all') + Number(!!applied.campaign);
  const changed = filtersQuery(draft) !== filtersQuery(applied);
  function submit(event: FormEvent) { onApply(event); if (!validateDateRange(draft.from, draft.to)) setOpen(false); }
  return <form className="results-filter-form" onSubmit={submit}>
    <div className="results-toolbar"><label className="a-f-field results-period" data-emphasis="quiet"><span className="blg-sr-only">Période rapide</span><span className="a-field-shell"><select aria-label="Période rapide" value={period} onChange={e => choosePeriod(e.target.value as PeriodId)}>{periods.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}<option value="custom">Dates personnalisées</option></select></span></label><div className="results-dates"><label className="a-f-field" data-emphasis="quiet"><span>Du</span><span className="a-field-shell"><input type="date" value={draft.from} onChange={e => { setPeriod('custom'); onChange({ ...draft, from: e.target.value }); }} required /></span></label><label className="a-f-field" data-emphasis="quiet"><span>Au</span><span className="a-field-shell"><input type="date" value={draft.to} onChange={e => { setPeriod('custom'); onChange({ ...draft, to: e.target.value }); }} required /></span></label></div>
      <button type="button" className="a-button a-secondary results-filter-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>Filtres{count > 0 && <span className="results-count">{count}</span>}<Arrow down /></button>
      <label className="a-t-check results-compare"><input type="checkbox" checked={draft.compare} onChange={e => onChange({ ...draft, compare: e.target.checked })} />Comparer</label>
      <button className="a-button a-primary" disabled={busy}>Appliquer</button>
    </div>
    {open && <div className="results-secondary a-t-filters" id={id}><label className="a-f-field" data-emphasis="quiet">Source<span className="a-field-shell"><select aria-label="Source" value={draft.source} onChange={e => onChange({ ...draft, source: e.target.value as DashboardFilters['source'] })}><option value="all">Toutes les sources</option><option value="paid">Publicité</option><option value="organic">Organique</option><option value="unknown">Non renseignée</option></select></span></label><label className="a-f-field" data-emphasis="quiet">Tunnel<span className="a-field-shell"><select aria-label="Tunnel" value={draft.tunnel} onChange={e => onChange({ ...draft, tunnel: e.target.value as DashboardFilters['tunnel'] })}><option value="all">Tous les tunnels</option><option value="quiz">Quiz</option><option value="masterclass">Masterclass</option></select></span></label><label className="a-f-field" data-emphasis="quiet">Campagne, publicité ou créative<span className="a-field-shell"><select aria-label="Campagne, publicité ou créative" value={draft.campaign} onChange={e => onChange({ ...draft, campaign: e.target.value })}><option value="">Toutes</option>{campaigns.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select></span></label><button type="button" className="a-button a-n-quiet" onClick={() => onChange({ ...draft, source: 'all', tunnel: 'all', campaign: '' })}>Effacer les filtres</button></div>}
    {error && <p className="results-error" role="alert">{error}</p>}{changed && !error && <p className="results-pending" role="status">Applique les modifications pour mettre les chiffres à jour.</p>}
  </form>;
}

function Change({ metric, compare }: { metric: Metric; compare: boolean }) {
  if (!compare || metric.completeness === 'partial' || metric.value === null || metric.previous == null) return null;
  const change = metric.value - metric.previous;
  const direction = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
  const text = metric.previous === 0 ? `De 0 à ${formatNumber(metric.value, metric.unit)}` : `${change > 0 ? '+' : ''}${formatNumber(change / Math.abs(metric.previous) * 100, 'percent')}`;
  return <span className="a-d-change" data-direction={direction}><span aria-hidden="true">{direction === 'up' ? '↗' : direction === 'down' ? '↘' : ''}</span>{text}</span>;
}
function Card({ metric, compare, onOpen }: { metric: Metric; compare: boolean; onOpen: (metric: Metric) => void }) {
  const state = resultState(metric);
  return <article className="a-d-card results-kpi" data-metric={metric.id}><h3>{name(metric)}</h3><div className="a-d-value">{formatNumber(metric.value, metric.unit)}</div><div className="results-card-foot"><span>{state ? <span className="results-state">{state}</span> : <Change metric={metric} compare={compare} />}</span><button className="a-button a-n-quiet" onClick={() => onOpen(metric)} aria-label={`Voir le détail : ${name(metric)}`}>Détail <Arrow /></button></div></article>;
}

export function ReportStatus({reports,retry}:{reports:PostHogClientState;retry?:()=>void}) {
  const current=reports.current,previous=reports.previous;
  return <>{current && current.state!=='ready' && <p className="results-reason" role="status">{current.message}</p>}{previous && previous.state!=='ready' && <p className="results-reason" role="status">{['loading','waiting'].includes(previous.state)?'Chargement de la comparaison…':'La comparaison n’est pas disponible pour cette période.'}</p>}{retry && [current,previous].some(s=>s?.state==='failed') && <button className="a-button a-secondary" onClick={retry}>Réessayer ces chiffres</button>}</>;
}
function MetricDrawer({ metric, onClose, filters,posthog={},retryPosthog }: { metric: Metric; onClose: () => void; filters: DashboardFilters;posthog?:PostHogClientState;retryPosthog?:()=>void }) {
  const text = resultCopy[metric.id], source = resultSource(metric), message = resultMessage(metric, filters);
  const report=metric.id==='arrivals'?posthog.current:undefined;
  return <ResultDialog title={name(metric)} onClose={onClose}>
    <p className="results-drawer-period">Du {formatDate(filters.from)} au {formatDate(filters.to)}</p>
    <div className="a-d-value">{formatNumber(metric.value, metric.unit)}</div>
    <Change metric={metric} compare={filters.compare} />
    {metric.value === null && <span className="results-state">{report && ['loading','waiting'].includes(report.state)?'Chargement…':'Indisponible'}</span>}
    {text && <p className="results-drawer-description">{text.description}</p>}
    {message && (!report || report.state==='ready') && <p className="results-reason">{message}</p>}
    {metric.id==='paid_sales' && metric.paidSales && <PaidSalesDetails report={metric.paidSales} />}
    {metric.id==='arrivals' && <ReportStatus reports={posthog} retry={retryPosthog} />}
    {(source || metric.updatedAt) && <p className="results-source">{source && <span>{source}</span>}{metric.updatedAt && <span>Mis à jour le {formatDate(metric.updatedAt, true)}</span>}</p>}
  </ResultDialog>;
}

function Chart({ series }: { series: DashboardResponse['series'] }) {
  const [selected, setSelected] = useState<'revenue' | 'spend'>('revenue'); const [point, setPoint] = useState<number | null>(null); const id = useId();
  const values = series.map(day => day[selected]); const available = values.filter((v): v is number => v !== null);
  const min = Math.min(...available, 0), max = Math.max(...available, 1), range = max - min;
  const x = (i: number) => 72 + i / Math.max(series.length - 1, 1) * 832;
  const y = (v: number) => 184 - (v - min) / range * 154;
  const paths: string[] = []; let path = '';
  values.forEach((value, i) => { if (value === null) { if (path) paths.push(path); path = ''; } else path += `${path ? ' L' : 'M'}${x(i)} ${y(value)}`; }); if (path) paths.push(path);
  return <section className="a-d-stage results-chart" aria-label="Évolution quotidienne"><div className="results-chart-heading"><h2>Évolution quotidienne</h2><div className="a-t-views" aria-label="Montant affiché">{(['revenue','spend'] as const).map(key => <button className="a-t-view" key={key} aria-pressed={selected === key} onClick={() => { setSelected(key); setPoint(null); }}>{key === 'revenue' ? 'CA encaissé' : 'Dépenses publicitaires'}</button>)}</div></div>
    {!available.length ? <p className="results-chart-empty">Aucun montant disponible sur cette période.</p> : <><div className="results-chart-readout" aria-live="polite">{point !== null && series[point] ? `${formatDate(series[point].date)} · ${formatNumber(values[point], 'eur')}` : 'Survole un point ou sélectionne-le au clavier.'}</div><svg className="a-d-plot" viewBox="0 0 936 230" role="group" aria-label={`${selected === 'revenue' ? 'CA encaissé' : 'Dépenses publicitaires'} par jour, en euros`}><defs><linearGradient id={id} x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stopColor="#7973ea" /><stop offset="100%" stopColor="#67bddc" /></linearGradient></defs>{[0,.5,1].map(ratio => <g key={ratio}><line className="a-d-grid-line" x1="72" x2="904" y1={y(min+range*ratio)} y2={y(min+range*ratio)} /><text className="a-d-axis" x="60" y={y(min+range*ratio)+4} textAnchor="end">{formatNumber(min+range*ratio)}</text></g>)}{paths.map((d, i) => <path key={i} d={d} fill="none" stroke={`url(#${id})`} strokeWidth="2.5" />)}{values.map((v,i) => v !== null && <g key={series[i].date}><circle className="a-d-visible-point" cx={x(i)} cy={y(v)} r="3.5" /><circle className="a-d-chart-point" cx={x(i)} cy={y(v)} r="12" tabIndex={0} role="img" aria-label={`${formatDate(series[i].date)} : ${formatNumber(v,'eur')}`} onMouseEnter={() => setPoint(i)} onFocus={() => setPoint(i)} onClick={() => setPoint(i)} /></g>)}<text className="a-d-axis" x="72" y="218">{formatDate(series[0]?.date)}</text><text className="a-d-axis" x="904" y="218" textAnchor="end">{formatDate(series.at(-1)?.date)}</text></svg></>}
    <details className="a-d-values"><summary>Voir les montants par jour</summary><div className="results-table-scroll" tabIndex={0} role="region" aria-label="Montants par jour"><table className="a-d-data-table"><thead><tr><th>Date</th><th>CA encaissé</th><th>Dépenses publicitaires</th></tr></thead><tbody>{series.map(day => <tr key={day.date}><th scope="row">{formatDate(day.date)}</th><td>{formatNumber(day.revenue,'eur')}</td><td>{formatNumber(day.spend,'eur')}</td></tr>)}</tbody></table></div></details>
  </section>;
}

function Accordion({ title, marker, count, children }: { title: string; marker: string; count?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false); const id = useId();
  return <section className="results-accordion"><h3><button className="a-h-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}><span className="a-h-marker a-luminous-marker">{marker}</span><span className="a-h-copy"><span className="a-h-title">{title}</span></span><span className="a-h-meta">{count && <span className="a-h-count">{count}</span>}<span className="a-h-chevron"><Arrow /></span></span></button></h3><div id={id} hidden={!open}>{children}</div></section>;
}

function Campaigns({ data, filters }: { data: DashboardResponse; filters: DashboardFilters }) {
  const [rows, setRows] = useState(data.details); const [pagination, setPagination] = useState(data.detailsPagination); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [selected, setSelected] = useState<DetailRow | null>(null); const pending = useRef<AbortController | null>(null);
  const query = filtersQuery(filters);
  useEffect(() => { pending.current?.abort(); setRows(data.details); setPagination(data.detailsPagination); setBusy(false); setError(''); setSelected(null); return () => pending.current?.abort(); }, [data.details, data.detailsPagination, query]);
  async function load(page: number) {
    if (!pagination || page < 0 || page * pagination.pageSize >= pagination.total) return;
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller; setBusy(true); setError('');
    try { const response = await fetch(`/api/details?${query}&page=${page}`, { signal: controller.signal, credentials: 'same-origin', cache: 'no-store' }); if (!response.ok) throw new Error(); const result: DetailsResponse = await response.json(); if (!controller.signal.aborted) { setRows(result.details); setPagination(result.pagination); } }
    catch { if (!controller.signal.aborted) setError('Cette page n’a pas pu être chargée. Réessaie.'); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <Accordion title="Résultats par campagne et par lien" marker="04" count={`${formatNumber(pagination?.total ?? rows.length)} lignes`}><div className="results-campaigns" aria-busy={busy}>{error && <p className="results-error" role="alert">{error}</p>}{busy && <p role="status">Chargement…</p>}{rows.length ? <><div className="a-t-table-wrap results-table-scroll results-desktop-table" tabIndex={0} role="region" aria-label="Résultats par campagne et par lien"><table className="a-t-table results-table"><thead><tr><th>Campagne ou lien</th><th>Leads</th><th>RDV réalisés</th><th>Clients</th><th>Dépenses</th></tr></thead><tbody>{rows.map(row => <tr className="a-t-row" key={row.id}><td><button className="a-t-name" onClick={() => setSelected(row)} aria-label={`Détail : ${row.label}`}>{row.label}</button><span className="a-t-context">{sourceName(row.source)}</span></td><td>{formatNumber(row.leads)}</td><td>{formatNumber(row.appointments)}</td><td>{formatNumber(row.clients)}</td><td>{formatNumber(row.spend,'eur')}</td></tr>)}</tbody></table></div><ul className="a-t-list results-mobile-list">{rows.map(row => <li key={row.id}><div className="a-t-item-copy"><button className="a-t-name" onClick={() => setSelected(row)}>{row.label} <span aria-hidden="true">→</span></button><span className="a-t-context">{sourceName(row.source)}</span><dl className="results-row-values"><div><dt>Leads</dt><dd>{formatNumber(row.leads)}</dd></div><div><dt>RDV réalisés</dt><dd>{formatNumber(row.appointments)}</dd></div><div><dt>Clients</dt><dd>{formatNumber(row.clients)}</dd></div><div><dt>Dépenses</dt><dd>{formatNumber(row.spend,'eur')}</dd></div></dl></div></li>)}</ul></> : <p className="results-empty">Aucun résultat pour cette sélection.</p>}{pagination && <nav className="a-t-pagination" aria-label="Pagination des campagnes et liens"><p role="status">{rows.length ? `${pagination.page * pagination.pageSize + 1}–${pagination.page * pagination.pageSize + rows.length} sur ${formatNumber(pagination.total)}` : `0 sur ${formatNumber(pagination.total)}`}</p><div className="a-t-pages"><button className="a-button a-secondary" disabled={busy || pagination.page === 0} onClick={() => load(pagination.page - 1)}>Précédent</button><button className="a-button a-secondary" disabled={busy || (pagination.page + 1) * pagination.pageSize >= pagination.total} onClick={() => load(pagination.page + 1)}>Suivant</button></div></nav>}</div>{selected && <ResultDialog title={selected.label} onClose={() => setSelected(null)}><p>{sourceName(selected.source)}</p><dl className="a-t-facts"><div><dt>Leads</dt><dd>{formatNumber(selected.leads)}</dd></div><div><dt>RDV réalisés</dt><dd>{formatNumber(selected.appointments)}</dd></div><div><dt>Clients</dt><dd>{formatNumber(selected.clients)}</dd></div><div><dt>Dépenses</dt><dd>{formatNumber(selected.spend,'eur')}</dd></div></dl>{[selected.leads, selected.appointments, selected.clients].some(value => value === null) && <p className="results-reason">Les contacts et les ventes ne sont pas encore tous reliés à cette campagne ou à ce lien.</p>}</ResultDialog>}</Accordion>;
}

export default function ResultsPage({ data, filters,posthog={},retryPosthog }: { data: DashboardResponse; filters: DashboardFilters;posthog?:PostHogClientState;retryPosthog?:()=>void }) {
  const [metricId, setMetricId] = useState<string | null>(null);
  const metric=[...data.metrics,...data.pillars.flatMap(p=>p.metrics)].find(m=>m.id===metricId)??null;
  const setMetric=(metric:Metric|null)=>setMetricId(metric?.id??null);
  return <div className="blg-results"><section className="a-d-stage results-kpis" aria-label="Indicateurs principaux"><div className="a-d-cards">{data.metrics.map(item => <Card key={item.id} metric={item} compare={filters.compare} onOpen={setMetric} />)}</div></section><Chart series={data.series} /><div className="results-section-heading"><h2>Comprendre les résultats</h2><span>Le détail par activité</span></div><div className="a-h-stage results-pillars">{data.pillars.map((pillar, i) => <Accordion key={pillar.id} title={pillar.title} marker={`0${i + 1}`} count={`${pillar.metrics.length} indicateurs`}><div className="results-pillar-metrics">{pillar.metrics.map(item => <button className="results-metric-row" key={item.id} onClick={() => setMetric(item)}><span>{name(item)}</span><strong>{formatNumber(item.value,item.unit)}</strong><span className="results-state">{item.id==='arrivals' && posthog.current && ['loading','waiting'].includes(posthog.current.state)?'Chargement…':item.value === null ? 'Indisponible' : ''}</span><Arrow /></button>)}</div></Accordion>)}</div><div className="a-h-stage results-pillars"><Campaigns data={data} filters={filters} /></div>{metric && <MetricDrawer metric={metric} filters={filters} posthog={posthog} retryPosthog={retryPosthog} onClose={() => setMetric(null)} />}</div>;
}
