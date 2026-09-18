'use client';

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { DashboardFilters, DashboardResponse, DetailRow, DetailsResponse, Metric } from '../lib/ui-contract';
import { matchingPeriod, resultPeriods, type PeriodId } from './result-periods';
import { filtersQuery, formatDate, formatNumber, validateDateRange } from './ui-format';
import { resultCopy, resultMessage, resultSource, resultState } from './result-copy';
import PaidSalesDetails from './PaidSalesDetails';
import type {PostHogClientState} from '../lib/posthog-report-client';
import type {AdFunnelReport,Rate} from '../lib/ad-funnel';

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
  return <Accordion title="Résultats par campagne et par lien" marker="04" count={`${formatNumber(pagination?.total ?? rows.length)} lignes`}><div className="results-campaigns" aria-busy={busy}>{error && <p className="results-error" role="alert">{error}</p>}{busy && <p role="status">Chargement…</p>}{rows.length ? <><div className="a-t-table-wrap results-table-scroll results-desktop-table" tabIndex={0} role="region" aria-label="Résultats par campagne et par lien"><table className="a-t-table results-table"><thead><tr><th>Campagne ou lien</th><th>Nouveaux leads</th><th>RDV réalisés</th><th>Clients</th><th>Dépenses</th></tr></thead><tbody>{rows.map(row => <tr className="a-t-row" key={row.id}><td><button className="a-t-name" onClick={() => setSelected(row)} aria-label={`Détail : ${row.label}`}>{row.label}</button><span className="a-t-context">{sourceName(row.source)}</span></td><td>{formatNumber(row.leads)}</td><td>{formatNumber(row.appointments)}</td><td>{formatNumber(row.clients)}</td><td>{formatNumber(row.spend,'eur')}</td></tr>)}</tbody></table></div><ul className="a-t-list results-mobile-list">{rows.map(row => <li key={row.id}><div className="a-t-item-copy"><button className="a-t-name" onClick={() => setSelected(row)}>{row.label} <span aria-hidden="true">→</span></button><span className="a-t-context">{sourceName(row.source)}</span><dl className="results-row-values"><div><dt>Nouveaux leads</dt><dd>{formatNumber(row.leads)}</dd></div><div><dt>RDV réalisés</dt><dd>{formatNumber(row.appointments)}</dd></div><div><dt>Clients</dt><dd>{formatNumber(row.clients)}</dd></div><div><dt>Dépenses</dt><dd>{formatNumber(row.spend,'eur')}</dd></div></dl></div></li>)}</ul></> : <p className="results-empty">Aucun résultat pour cette sélection.</p>}{pagination && <nav className="a-t-pagination" aria-label="Pagination des campagnes et liens"><p role="status">{rows.length ? `${pagination.page * pagination.pageSize + 1}–${pagination.page * pagination.pageSize + rows.length} sur ${formatNumber(pagination.total)}` : `0 sur ${formatNumber(pagination.total)}`}</p><div className="a-t-pages"><button className="a-button a-secondary" disabled={busy || pagination.page === 0} onClick={() => load(pagination.page - 1)}>Précédent</button><button className="a-button a-secondary" disabled={busy || (pagination.page + 1) * pagination.pageSize >= pagination.total} onClick={() => load(pagination.page + 1)}>Suivant</button></div></nav>}</div>{selected && <ResultDialog title={selected.label} onClose={() => setSelected(null)}><p>{sourceName(selected.source)}</p><dl className="a-t-facts"><div><dt>Nouveaux leads</dt><dd>{formatNumber(selected.leads)}</dd></div><div><dt>RDV réalisés</dt><dd>{formatNumber(selected.appointments)}</dd></div><div><dt>Clients</dt><dd>{formatNumber(selected.clients)}</dd></div><div><dt>Dépenses</dt><dd>{formatNumber(selected.spend,'eur')}</dd></div></dl><p className="results-reason">{selected.coverage}</p></ResultDialog>}</Accordion>;
}


/** Tableau par publicité : dépenses et clics Meta, visiteurs PostHog, inscrits, rendez-vous, ventes et encaissements, avec les trois
 * pourcentages validés le 16 septembre 2026 (opt-in, réservation, présence). Lecture à la demande (route /api/ad-funnel).
 * Chaque pourcentage montre son numérateur et son dénominateur ; sans dénominateur mesuré, il reste « — », jamais 0. */
function AdFunnelTable({ filters }: { filters: DashboardFilters }) {
  const [includeTests, setIncludeTests] = useState(false);
  const [open, setOpen] = useState(false); const [loaded, setLoaded] = useState<{ query: string; value: AdFunnelReport } | null>(null); const [busyQuery, setBusyQuery] = useState<string | null>(null); const [failure, setFailure] = useState<{ query: string; message: string } | null>(null); const [attempt, setAttempt] = useState(0); const id = useId();
  const query = `${filtersQuery(filters)}&includeTests=${includeTests}`;
  const report = loaded?.query === query ? loaded.value : null; const busy = busyQuery === query; const error = failure?.query === query ? failure.message : '';
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); setBusyQuery(query); setFailure(null); setLoaded(current => current?.query === query ? null : current);
    fetch(`/api/ad-funnel?${query}`, { signal: controller.signal, credentials: 'same-origin', cache: 'no-store' })
      .then(async response => { const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error ?? 'Lecture indisponible.'); return body as AdFunnelReport; })
      .then(result => { if (!controller.signal.aborted) setLoaded({ query, value: result }); })
      .catch(err => { if (!controller.signal.aborted) setFailure({ query, message: err instanceof Error ? err.message : 'Lecture indisponible.' }); })
      .finally(() => { if (!controller.signal.aborted) setBusyQuery(current => current === query ? null : current); });
    return () => controller.abort();
  }, [open, query, attempt]);
  type Line = AdFunnelReport['rows'][number] | AdFunnelReport['totals'];
  const eur = (minor: number | null) => minor === null ? formatNumber(null, 'eur') : formatNumber(minor / 100, 'eur');
  const sum = (counts: { quiz: number | null; masterclass: number | null }) => counts.quiz === null && counts.masterclass === null ? null : (counts.quiz ?? 0) + (counts.masterclass ?? 0);
  const visitors = (row: Line) => { const value = sum(row.visitors), views = sum(row.pageviews); return value === null ? <span className="results-state">Non lues</span> : <>{formatNumber(value)}{views !== null && views !== value ? <span className="a-t-context">{formatNumber(views)} pages vues</span> : null}</>; };
  const pct = (r: Rate, extra?: string | null) => r.value === null ? <span className="results-state" title={r.reason}>—{extra ? <span className="a-t-context">{extra}</span> : null}</span> : <>{formatNumber(r.value * 100, 'percent')}<span className="a-t-context">{formatNumber(r.numerator)} / {formatNumber(r.denominator)}{extra ? ` · ${extra}` : ''}</span></>;
  const optinExtra = (row: Line) => { const u = row.optin.unlinkableVisitors; const n = u ? (filters.tunnel === 'all' ? u.quiz + u.masterclass : u[filters.tunnel]) : 0; return n ? `${formatNumber(n)} sans identifiant` : null; };
  const leads = (row: Line) => <>{formatNumber(report?.available && (row.uniqueRegistrants > 0 || report.coverage.leads.complete !== false) ? row.uniqueRegistrants : null)}<span className="a-t-context">{formatNumber(row.registrations)} inscription{row.registrations > 1 ? 's' : ''}{row.uniqueLeads !== row.uniqueRegistrants ? ` · ${formatNumber(row.uniqueLeads)} nouveau${row.uniqueLeads > 1 ? 'x' : ''}` : ''}{row.knownBefore ? ` · ${formatNumber(row.knownBefore)} déjà connu${row.knownBefore > 1 ? 's' : ''}` : ''}{row.unresolvedIdentity ? ` · ${formatNumber(row.unresolvedIdentity)} sans identité` : ''}</span></>;
  const booked = (row: Line) => <>{formatNumber(row.appointmentsBooked > 0 || report?.coverage.appointments.available ? row.appointmentsBooked : null)}<span className="a-t-context">{[row.appointmentsUpcoming ? `${formatNumber(row.appointmentsUpcoming)} à venir` : null, row.appointmentsCancelled ? `${formatNumber(row.appointmentsCancelled)} annulé${row.appointmentsCancelled > 1 ? 's' : ''}` : null, row.appointmentsRescheduled ? `${formatNumber(row.appointmentsRescheduled)} reporté${row.appointmentsRescheduled > 1 ? 's' : ''}` : null].filter(Boolean).join(' · ')}</span></>;
  const attended = (row: Line) => <>{formatNumber(row.appointmentsAttended > 0 || report?.coverage.appointments.available ? row.appointmentsAttended : null)}<span className="a-t-context">{[row.appointmentsNoShow ? `${formatNumber(row.appointmentsNoShow)} absent${row.appointmentsNoShow > 1 ? 's' : ''}` : null, row.appointmentsUnknown ? `${formatNumber(row.appointmentsUnknown)} sans issue` : null].filter(Boolean).join(' · ')}</span></>;
  const sales = (row: Line) => <>{formatNumber(row.firstSalesConfirmed === null || row.firstSalesReconciled === null ? null : row.firstSalesConfirmed + row.firstSalesReconciled)}{row.firstSalesPending ? <span className="a-t-context">+{formatNumber(row.firstSalesPending)} en attente</span> : null}</>;
  const cash = (row: Line) => <>{eur(row.cashMinor)}{row.refundsMinor ? <span className="a-t-context">{eur(row.refundsMinor)} remboursé</span> : null}</>;
  const cells = (row: Line) => <><td>{eur(row.spendMinor)}</td><td>{formatNumber(row.outboundClicks)}</td><td>{visitors(row)}</td><td>{leads(row)}</td><td>{pct(row.rates.optin, optinExtra(row))}</td><td>{booked(row)}</td><td>{pct(row.rates.booking)}</td><td>{attended(row)}</td><td>{pct(row.rates.attendance)}</td><td>{sales(row)}</td><td>{cash(row)}</td></>;
  const tunnelLabel = (row: AdFunnelReport['rows'][number]) => row.tunnels.length === 0 ? '' : row.tunnels.map(t => t === 'quiz' ? 'Quiz' : 'Masterclass').join(' + ');
  return <section className="results-accordion"><h3><button className="a-h-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}><span className="a-h-marker a-luminous-marker">05</span><span className="a-h-copy"><span className="a-h-title">Par publicité, du clic à l’encaissement</span></span><span className="a-h-meta">{report && <span className="a-h-count">{formatNumber(report.rows.length)} lignes</span>}<span className="a-h-chevron"><Arrow /></span></span></button></h3>
    <div id={id} hidden={!open}><div className="results-campaigns" aria-busy={busy}>
      <label className="blg-traffic-toggle"><input type="checkbox" checked={includeTests} onChange={event => setIncludeTests(event.target.checked)} />Inclure les essais dans ce tableau</label>
      <p className="a-d-data-note">{includeTests ? 'Visiteurs et inscriptions : essais identifiés inclus.' : 'Visiteurs et inscriptions : essais explicitement identifiés exclus.'} Les dépenses et clics Meta gardent le périmètre publicitaire sélectionné.</p>
      {error && <p className="results-error" role="alert">{error} <button type="button" className="a-button a-secondary" onClick={() => setAttempt(value => value + 1)}>Réessayer</button></p>}{busy && <p role="status">Lecture des publicités, visiteurs, inscriptions, rendez-vous et paiements…</p>}
      {report && <>
        <p className="a-d-data-note">Chaque personne est créditée à la première publicité mesurée, même si elle s’inscrit plus tard par une autre. Visiteurs par date de visite, inscrits par date d’inscription, rendez-vous par date du créneau, ventes et encaissements par date de paiement.</p>
        {report.notices.map(notice => <p className="a-d-data-note" key={notice}>{notice}</p>)}
        {report.rows.length ? <div className="a-t-table-wrap results-table-scroll" tabIndex={0} role="region" aria-label="Résultats par publicité"><table className="a-t-table results-table results-table-wide"><thead><tr><th>Publicité</th><th>Dépenses</th><th>Clics Meta</th><th>Visiteurs</th><th>Inscrits</th><th>Opt-in</th><th>RDV réservés</th><th>Réservation</th><th>RDV réalisés</th><th>Présence</th><th>Nouvelles ventes</th><th>Encaissé</th></tr></thead><tbody>
          {report.rows.map(row => <tr className="a-t-row" key={row.key}><td><span className="a-t-name">{row.label}</span><span className="a-t-context">{[row.campaignLabel, row.creativeId ? `créative ${row.creativeId}` : row.kind === 'ad' && row.adId ? 'créative non lue' : null, tunnelLabel(row), row.links.length ? `${row.links.length} lien${row.links.length > 1 ? 's' : ''} cockpit` : null].filter(Boolean).join(' · ')}</span></td>{cells(row)}</tr>)}
          <tr className="a-t-row"><td><strong>Total</strong></td>{cells(report.totals)}</tr>
        </tbody></table></div> : <p className="a-d-data-note">Aucune inscription ni visite publiée sur cette période.</p>}
        <p className="a-d-data-note">Opt-in = visiteurs entrés dans la période (identifiant de navigateur) devenus inscrits ensuite, sur le même tunnel{filters.tunnel === 'all' ? ' ou sur l’un des deux' : ''}, lus le {formatDate(report.coverage.optin.observedAt, true)}{report.coverage.optin.available ? ` ; hors calcul : ${formatNumber(report.coverage.optin.visitorsUnlinkable)} visiteur${(report.coverage.optin.visitorsUnlinkable ?? 0) > 1 ? 's' : ''} sans identifiant, ${formatNumber(report.coverage.optin.registrationsWithoutVisitor + report.coverage.optin.registrationsOutsideCohort)} inscription${report.coverage.optin.registrationsWithoutVisitor + report.coverage.optin.registrationsOutsideCohort > 1 ? 's' : ''} sans visite raccordable dans la période` : ` ; ${report.coverage.optin.reason ?? 'indisponible'}`}. Réservation = inscrits ayant un rendez-vous ÷ inscrits ; Présence = présents ÷ (présents + absents) sur les rendez-vous passés. Un tiret signifie qu’il manque une mesure, pas un zéro.</p>
        <p className="a-d-data-note">Dernières lectures : inscriptions {formatDate(report.coverage.leads.observedAt, true)} · dépenses Meta jusqu’au {formatDate(report.coverage.meta.lastDay)} · ventes {formatDate(report.coverage.commerce.observedAt, true)} · visiteurs {report.coverage.visits.available ? `lus le ${formatDate(report.coverage.visits.observedAt, true)}` : 'non lus'}. Première publicité mesurée sur {formatNumber(report.totals.attributionBasis.firstTouch)} inscription{report.totals.attributionBasis.firstTouch > 1 ? 's' : ''}, arrivée de l’inscription sur {formatNumber(report.totals.attributionBasis.arrival)}.</p>
      </>}
    </div></div></section>;
}

export default function ResultsPage({ data, filters,posthog={},retryPosthog }: { data: DashboardResponse; filters: DashboardFilters;posthog?:PostHogClientState;retryPosthog?:()=>void }) {
  const [metricId, setMetricId] = useState<string | null>(null);
  const metric=[...data.metrics,...data.pillars.flatMap(p=>p.metrics)].find(m=>m.id===metricId)??null;
  const setMetric=(metric:Metric|null)=>setMetricId(metric?.id??null);
  return <div className="blg-results"><section className="a-d-stage results-kpis" aria-label="Indicateurs principaux"><div className="a-d-cards">{data.metrics.map(item => <Card key={item.id} metric={item} compare={filters.compare} onOpen={setMetric} />)}</div></section><Chart series={data.series} /><div className="results-section-heading"><h2>Comprendre les résultats</h2><span>Le détail par activité</span></div><div className="a-h-stage results-pillars">{data.pillars.map((pillar, i) => <Accordion key={pillar.id} title={pillar.title} marker={`0${i + 1}`} count={`${pillar.metrics.length} indicateurs`}><div className="results-pillar-metrics">{pillar.metrics.map(item => <button className="results-metric-row" key={item.id} onClick={() => setMetric(item)}><span>{name(item)}</span><strong>{formatNumber(item.value,item.unit)}</strong><span className="results-state">{item.id==='arrivals' && posthog.current && ['loading','waiting'].includes(posthog.current.state)?'Chargement…':item.value === null ? 'Indisponible' : ''}</span><Arrow /></button>)}</div></Accordion>)}</div><div className="a-h-stage results-pillars"><Campaigns data={data} filters={filters} /><AdFunnelTable filters={filters} /></div>{metric && <MetricDrawer metric={metric} filters={filters} posthog={posthog} retryPosthog={retryPosthog} onClose={() => setMetric(null)} />}</div>;
}
