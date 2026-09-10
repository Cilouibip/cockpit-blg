'use client';
import {metaRefreshPeriods,refreshNotionToCompletion} from '../lib/refresh-plan';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { ApiError, Connection, ConnectionsResponse, DashboardFilters, DashboardResponse, DataMode, DetailsResponse, Pagination, ProspectsQuery, LinkInput, LinkMutation, LinkPlacement, LinksResponse, Metric, Prospect, ProspectsResponse, TrackedLink } from '../lib/ui-contract';
import CommercialPage from './CommercialPage';
import type { CommercialDashboard, CommercialQuery } from '../lib/commercial-contract';
import { serializeCommercialQuery } from '../lib/commercial-query';
import type { LinkWriteResult } from '../lib/link-write-result';
import { request } from '../lib/cockpit-request';
import ResultsPage, { DemoIndicator, ResultsFilters, ReportStatus } from './ResultsPage';
import {usePostHogReports} from './use-posthog-reports';
import type {PostHogClientState} from '../lib/posthog-report-client';
import { defaultFilters, filtersQuery, formatDate, formatNumber, validateDateRange, variation } from './ui-format';

type View = 'results' | 'journey' | 'sales' | 'links' | 'connections';
const views: { id: View; label: string; title: string; description: string; icon: string }[] = [
  { id: 'results', label: 'Résultats', title: 'La vue d’ensemble.', description: 'Les résultats de ton activité, avec leurs sources et leurs limites.', icon: 'chart' },
  { id: 'journey', label: 'Parcours', title: 'Du contenu au client.', description: 'Observe chaque étape, puis descends dans le détail.', icon: 'route' },
  { id: 'sales', label: 'Commercial', title: 'Le suivi commercial.', description: 'Les rendez-vous, leur origine et la situation de chaque personne.', icon: 'people' },
  { id: 'links', label: 'Liens', title: 'Un lien. Un emplacement.', description: 'Crée les liens à partager et retrouve chaque version.', icon: 'link' },
  { id: 'connections', label: 'Connexions', title: 'D’où viennent les chiffres ?', description: 'Les accès, les dernières lectures et ce qui reste à raccorder.', icon: 'plug' },
];
const placements: Record<LinkPlacement, { label: string; instruction: string }> = {
  instagram_bio: { label: 'Bio Instagram', instruction: 'Colle ce lien dans le champ « Lien » de ta bio Instagram. Il identifie la bio, pas la publication vue avant le clic.' },
  youtube_description: { label: 'Description YouTube', instruction: 'Colle ce lien dans la description de la vidéo. Utilise un lien distinct pour chaque vidéo à suivre.' },
  meta_ad: { label: 'Publicité Meta', instruction: 'Colle ce lien dans l’URL de destination de la publicité. Les paramètres dynamiques Meta sont conservés pour identifier campagne, ensemble et publicité.' },
  email: { label: 'Email / newsletter', instruction: 'Colle ce lien sur le bouton ou le texte de ton email. Il identifie cet emplacement et cette campagne.' },
  other: { label: 'Autre emplacement', instruction: 'Colle ce lien dans l’emplacement que tu as nommé. Garde un lien par emplacement à suivre.' },
};
const sourceName = (value: string) => ({ paid: 'Payé', organic: 'Organique', unknown: 'Inconnu' }[value] ?? value);
const attendance: Record<Prospect['appointmentStatus'], string> = { planned: 'Prévu', attended: 'Réalisé', no_show: 'Absent', cancelled: 'Annulé', rescheduled: 'Reporté', unknown: 'Non renseigné' };

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    chart: <><path d="M4 19V5M4 19h16M8 15v-4M12 15V7M16 15v-6" /></>,
    route: <><circle cx="6" cy="6" r="2" /><circle cx="18" cy="18" r="2" /><path d="M8 6h8a4 4 0 0 1 0 8H8a4 4 0 0 0 0 8M18 14v2" /></>,
    people: <><circle cx="9" cy="8" r="3" /><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v2" /></>,
    link: <><path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(0 0) scale(.95)" /></>,
    plug: <><path d="M9 3v4M15 3v4M7 7h10v3a5 5 0 0 1-10 0V7M12 15v6" /></>,
    arrow: <><path d="M5 12h14m-5-5 5 5-5 5" /></>,
    copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5M19 11a7 7 0 0 0-12-5L4 9M5 13a7 7 0 0 0 12 5l3-3" /></>,
    search: <><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></>,
    logout: <><path d="M9 4H4v16h5M11 12h10m-4-4 4 4-4 4" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4M17 3v4M3 10h18M7 14h3M14 14h3" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.info}</svg>;
}

function useRemote<T>(path: string | null, revision: number, keepPrevious = false) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const previousPath = useRef<string | null>(null);
  useEffect(() => {
    if (!path) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true); setError('');
    if (previousPath.current !== path && !keepPrevious) setData(null);
    previousPath.current = path;
    request<T>(path, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setData(result); }).catch((error: unknown) => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'La lecture a été interrompue. Réessaie.');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, revision, keepPrevious]);
  return { data, loading, error, setData };
}

function Empty({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="blg-empty"><span className="blg-empty-symbol"><Icon name="info" size={24} /></span><h3>{title}</h3><p>{children}</p>{action}</div>;
}

function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    const node = dialog.current;
    if (!opener.current) opener.current = document.activeElement as HTMLElement | null;
    node?.showModal();
    return () => { node?.close(); if (opener.current?.isConnected) opener.current.focus(); };
  }, []);
  return <dialog ref={dialog} className="blg-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === dialog.current) onClose(); }}><div className="blg-dialog-inner"><header><h2 id={titleId}>{title}</h2><button className="blg-icon-button" onClick={onClose} aria-label="Fermer le détail"><Icon name="close" /></button></header>{children}</div></dialog>;
}

function MetricCard({ metric, compare, onOpen }: { metric: Metric; compare: boolean; onOpen: (metric: Metric) => void }) {
  const delta = variation(metric);
  return <button className={`blg-metric ${metric.value === null ? 'blg-metric-missing' : ''}`} onClick={() => onOpen(metric)} aria-label={`${metric.label} : ${formatNumber(metric.value, metric.unit)}. Voir les sources et le détail.`}>
    <span className="blg-metric-label">{metric.label}<Icon name="arrow" size={16} /></span>
    <strong>{formatNumber(metric.value, metric.unit)}</strong>
    {compare && <span className={`blg-delta blg-delta-${delta.direction}`}>{delta.text}</span>}
    <span className="blg-metric-source">{metric.value === null ? metric.unavailableReason ?? 'Source à raccorder' : metric.source}</span>
    <span className="blg-metric-coverage">{metric.coverage}</span>
  </button>;
}

function MetricDetail({ metric, onClose, mode }: { metric: Metric; onClose: () => void; mode: DataMode }) {
  return <Dialog title={metric.label} onClose={onClose}>
    {mode === 'demo' && <p className="blg-demo-inline">Données synthétiques de démonstration</p>}
    <div className="blg-detail-value">{formatNumber(metric.value, metric.unit)}</div>
    <p className="blg-detail-definition">{metric.definition}</p>
    <dl className="blg-facts"><div><dt>Source</dt><dd>{metric.source}</dd></div><div><dt>Couverture</dt><dd>{metric.coverage}</dd></div><div><dt>Dernière lecture</dt><dd>{formatDate(metric.updatedAt, true)}</dd></div>{metric.numerator !== undefined && <div><dt>Volume observé</dt><dd>{formatNumber(metric.numerator)} / {formatNumber(metric.denominator)}</dd></div>}<div><dt>Période précédente</dt><dd>{formatNumber(metric.previous, metric.unit)}</dd></div></dl>
    {metric.unavailableReason && <p className="blg-note"><Icon name="info" />{metric.unavailableReason}</p>}
  </Dialog>;
}

function PaginationControls({ pagination, count, busy, onPage, name }: { pagination: Pagination; count: number; busy: boolean; onPage: (page: number) => void; name: string }) {
  const first = count > 0 ? pagination.page * pagination.pageSize + 1 : 0;
  const last = count > 0 ? Math.min(pagination.page * pagination.pageSize + count, pagination.total) : 0;
  return <nav className="blg-pagination" aria-label={name}><span role="status" aria-live="polite">{count > 0 ? `Lignes ${formatNumber(first)}–${formatNumber(last)} sur ${formatNumber(pagination.total)}` : `Aucune ligne sur cette page · ${formatNumber(pagination.total)} au total`}</span><div><button className="blg-button" type="button" disabled={busy || pagination.page <= 0} onClick={() => onPage(pagination.page - 1)}>Précédent</button><button className="blg-button" type="button" disabled={busy || (pagination.page + 1) * pagination.pageSize >= pagination.total} onClick={() => onPage(pagination.page + 1)}>Suivant</button></div></nav>;
}

function DetailsTable({ data, initialPagination, filters }: { data: DashboardResponse['details']; initialPagination?: Pagination; filters: DashboardFilters }) {
  const [rows, setRows] = useState(data);
  const [pagination, setPagination] = useState(initialPagination);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const query = new URLSearchParams({ from: filters.from, to: filters.to, source: filters.source, tunnel: filters.tunnel, campaign: filters.campaign }).toString();
  useEffect(() => {
    pending.current?.abort(); setRows(data); setPagination(initialPagination); setError(''); setBusy(false);
    return () => pending.current?.abort();
  }, [data, initialPagination, query]);
  async function loadPage(page: number) {
    if (!pagination || page < 0 || page * pagination.pageSize >= pagination.total) return;
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller; setBusy(true); setError('');
    try { const result = await request<DetailsResponse>(`/api/details?${query}&page=${page}`, { signal: controller.signal }); if (!controller.signal.aborted) { setRows(result.details); setPagination(result.pagination); } }
    catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Cette page n’a pas pu être lue. Réessaie avec les commandes de pagination.'); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <section className="blg-panel" aria-busy={busy}><div className="blg-panel-heading"><div><span className="blg-eyebrow">NIVEAU 03 · DÉTAIL</span><h2>Les points d’entrée</h2></div><span className="blg-muted">{formatNumber(pagination?.total ?? rows.length)} relevé{(pagination?.total ?? rows.length) !== 1 ? 's' : ''}</span></div>{error && <p className="blg-inline-error" role="alert">{error} Les lignes de la dernière lecture restent affichées.</p>}{busy && <p className="blg-panel-intro" role="status">Lecture de la page demandée…</p>}{!rows.length ? <Empty title="Aucun détail disponible">Les liens, campagnes et créatives apparaîtront quand leurs identifiants seront reliés aux événements observés.</Empty> : <div className="blg-table-scroll"><table><thead><tr><th>Campagne / lien / créative</th><th>Leads</th><th>RDV réalisés</th><th>Clients</th><th>Dépenses</th><th>Couverture</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}><td><strong>{row.label}</strong><small>{sourceName(row.source)}</small></td><td>{formatNumber(row.leads)}</td><td>{formatNumber(row.appointments)}</td><td>{formatNumber(row.clients)}</td><td>{formatNumber(row.spend, 'eur')}</td><td className="blg-cell-note">{row.coverage}</td></tr>)}</tbody></table></div>}{pagination && <PaginationControls pagination={pagination} count={rows.length} busy={busy} onPage={loadPage} name="Pagination des points d’entrée" />}</section>;
}

function Journey({ data, compare, onMetric, filters,journey,setJourney,posthog,retryPosthog }: { data: DashboardResponse; filters: DashboardFilters; compare: boolean; onMetric: (metric: Metric) => void;journey:string;setJourney:(value:string)=>void;posthog:PostHogClientState;retryPosthog:()=>void }) {
  const journeys=filters.tunnel==='all'?data.journeys:data.journeys.filter(item=>item.id===filters.tunnel||(filters.tunnel==='quiz'&&item.id==='questions'));
  const selected = journeys.find(item => item.id === journey) ?? journeys[0];
  return <><div className="blg-section-heading"><span className="blg-eyebrow">NIVEAU 02 · LES TROIS PILIERS</span><span className="blg-muted">Volumes et taux observés</span></div><div className="blg-pillars">{data.pillars.map((pillar, index) => <section className="blg-panel blg-pillar" key={pillar.id}><div className="blg-pillar-title"><span className="blg-number">0{index + 1}</span><h2>{pillar.title}</h2></div><p>{pillar.description}</p><div className="blg-pillar-metrics">{pillar.metrics.map(metric => <MetricCard key={metric.id} metric={metric} compare={compare} onOpen={onMetric} />)}</div></section>)}</div>
    <section className="blg-panel"><div className="blg-panel-heading"><div><span className="blg-eyebrow">ÉTAPES OBSERVÉES</span><h2>À l’intérieur des tunnels</h2></div><div className="blg-switch" aria-label="Choisir le tunnel">{journeys.map(item => <button key={item.id} aria-pressed={selected?.id === item.id} onClick={() => setJourney(item.id)}>{item.title}</button>)}</div></div>{selected ? <><ReportStatus reports={posthog} retry={retryPosthog} /><p className="blg-panel-intro">{selected.description}</p><div className="blg-journey">{selected.steps.map((step, index) => <div className="blg-journey-step" key={step.id}><div className="blg-step-number">{String(index + 1).padStart(2, '0')}</div><div><h3>{step.label}</h3><small>{step.source}</small></div><strong>{formatNumber(step.value)}</strong><span>{step.denominator != null ? `${formatNumber(step.value)} / ${formatNumber(step.denominator)} · ${step.denominator > 0 && step.value !== null ? formatNumber(step.value / step.denominator * 100, 'percent') : 'Taux indisponible'}` : 'Volume observé'}</span><p>{step.coverage}</p></div>)}</div></> : <Empty title="Le parcours attend ses événements">Les étapes seront visibles après réception de mesures datées et dédoublonnées.</Empty>}</section><DetailsTable data={data.details} initialPagination={data.detailsPagination} filters={filters} /></>;
}

function Sales({ data, query, onQuery, busy }: { data: ProspectsResponse; query: ProspectsQuery; onQuery: (query: ProspectsQuery) => void; busy: boolean }) {
  const [search, setSearch] = useState(query.search); const [stage, setStage] = useState(query.stage); const [selected, setSelected] = useState<Prospect | null>(null);
  const stages = data.stages ?? [...new Set(data.prospects.map(prospect => prospect.stage))].sort((a, b) => a.localeCompare(b, 'fr'));
  const shown = data.pagination ? data.prospects : data.prospects.filter(prospect => (!query.stage || prospect.stage === query.stage) && `${prospect.name} ${prospect.stage} ${prospect.source ?? ''}`.toLocaleLowerCase('fr').includes(query.search.toLocaleLowerCase('fr')));
  const total = data.pagination?.total ?? shown.length;
  return <><p className="blg-note"><Icon name="lock" />Lecture seule depuis Notion. Cette liste présente le miroir commercial disponible ; les filtres de période du tableau de bord ne filtrent pas les prospects.</p>{data.notice && <p className="blg-note">{data.notice}</p>}<section className="blg-panel"><div className="blg-panel-heading"><div><span className="blg-eyebrow">PROSPECTS & SUIVI</span><h2>{formatNumber(total)} prospect{total !== 1 ? 's' : ''}</h2></div><form className="blg-sales-filters" onSubmit={event => { event.preventDefault(); onQuery({ search: search.trim(), stage, page: 0 }); }}><label className="blg-search"><span className="blg-sr-only">Rechercher un prospect</span><Icon name="search" size={17} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Rechercher un prospect" maxLength={100} /></label><label><span className="blg-sr-only">Statut commercial</span><select aria-label="Statut commercial" value={stage} onChange={event => setStage(event.target.value)}><option value="">Tous les statuts</option>{stages.map(value => <option key={value}>{value}</option>)}</select></label><button className="blg-button" type="submit" disabled={busy}>Rechercher</button></form></div>
    {!shown.length ? <Empty title={query.search || query.stage ? 'Aucun résultat pour cette recherche' : 'Aucun prospect dans le miroir'}>{query.search || query.stage ? 'Modifie la recherche ou le statut pour retrouver un prospect.' : 'La connexion Notion et la dernière synchronisation sont détaillées dans Connexions.'}</Empty> : <div className="blg-table-scroll"><table className="blg-sales-table"><thead><tr><th>Prospect</th><th>Responsable</th><th>Rendez-vous</th><th>État</th><th>Relance</th><th>Résultat</th></tr></thead><tbody>{shown.map(prospect => <tr key={prospect.id}><td><button className="blg-table-link" onClick={() => setSelected(prospect)}>{prospect.name}<Icon name="arrow" size={14} /></button><small>{prospect.source ? sourceName(prospect.source) : 'Source inconnue'} · {prospect.tunnel ?? 'Tunnel inconnu'}</small></td><td>{prospect.owner ?? 'Non renseigné'}</td><td>{formatDate(prospect.appointmentAt, true)}<small>{attendance[prospect.appointmentStatus]}</small></td><td>{prospect.stage}</td><td>{formatDate(prospect.followUpAt)}</td><td>{prospect.outcome ?? 'Non renseigné'}</td></tr>)}</tbody></table></div>}
    {data.pagination && <PaginationControls pagination={data.pagination} count={shown.length} busy={busy} onPage={page => onQuery({ ...query, page })} name="Pagination commerciale" />}<div className="blg-panel-footer"><span>{data.coverage}</span><span>Dernière lecture : {formatDate(data.updatedAt, true)}</span></div></section>{selected && <Dialog title={selected.name} onClose={() => setSelected(null)}>{data.mode === 'demo' && <p className="blg-demo-inline">Prospect fictif de démonstration</p>}<dl className="blg-facts"><div><dt>Responsable</dt><dd>{selected.owner ?? 'Non renseigné'}</dd></div><div><dt>Étape commerciale</dt><dd>{selected.stage}</dd></div><div><dt>Rendez-vous</dt><dd>{formatDate(selected.appointmentAt, true)} · {attendance[selected.appointmentStatus]}</dd></div><div><dt>Prochaine relance</dt><dd>{formatDate(selected.followUpAt, true)}</dd></div><div><dt>Résultat</dt><dd>{selected.outcome ?? 'Non renseigné'}</dd></div><div><dt>Source / tunnel</dt><dd>{selected.source ? sourceName(selected.source) : 'Inconnue'} / {selected.tunnel ?? 'Inconnu'}</dd></div><div><dt>Mis à jour</dt><dd>{formatDate(selected.updatedAt, true)}</dd></div></dl><p className="blg-note">La saisie et les corrections se font dans Notion.</p></Dialog>}</>;
}

function Links({ data, onUpdate, announce, refresh }: { data: LinksResponse; onUpdate: (value: LinksResponse) => void; announce: (message: string) => void; refresh: () => void }) {
  const blank: LinkInput = { placement: 'instagram_bio', destination: 'quiz', campaign: '', label: '' };
  const [input, setInput] = useState<LinkInput>(blank); const [editing, setEditing] = useState<TrackedLink | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [archive, setArchive] = useState(false); const [copied, setCopied] = useState('');
  const creationId = useRef<string | null>(null);
  const form = useRef<HTMLFormElement>(null); const urlInput = useRef<HTMLInputElement>(null);
  const shown = data.links.filter(link => link.archived === archive);
  useEffect(() => {
    if (creationId.current && data.links.some(link => link.id === creationId.current)) { creationId.current = null; setInput(blank); setError(''); announce('Le lien est bien enregistré et présent dans le registre.'); }
    setEditing(current => current ? data.links.find(link => link.id === current.id) ?? current : null);
  }, [data.links]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    const body: LinkInput | LinkMutation = editing ? { action: 'revise', id: editing.id, expectedVersion: editing.current.version, input } : input;
    if (!editing && !creationId.current) creationId.current = crypto.randomUUID();
    try {
      const result = await request<LinkWriteResult>('/api/links', { method: editing ? 'PATCH' : 'POST', headers: editing ? {} : { 'X-BLG-Link-Id': creationId.current! }, body: JSON.stringify(body) });
      creationId.current = null;
      if (result.links) onUpdate(result.links);
      setInput(blank); setEditing(null);
      if (!result.links) setError(result.notice ?? 'Enregistrement confirmé. Actualise le registre pour retrouver le lien.');
      announce(result.notice ?? (editing ? 'Nouvelle version enregistrée. Les anciennes URLs sont conservées.' : 'Lien créé et enregistré.'));
    }
    catch (error) { setError((error instanceof Error ? error.message : 'La réponse d’enregistrement est indisponible.') + ' Actualise le registre pour vérifier le résultat. Ta saisie est conservée.'); }
    finally { setBusy(false); }
  }
  async function changeArchive(link: TrackedLink) {
    setBusy(true); setError('');
    try {
      const command: LinkMutation = { action: link.archived ? 'restore' : 'archive', id: link.id, expectedVersion: link.current.version };
      const result = await request<LinkWriteResult>('/api/links', { method: 'PATCH', body: JSON.stringify(command) });
      if (result.links) onUpdate(result.links);
      else setError(result.notice ?? 'Modification enregistrée. Actualise le registre.');
      announce(result.notice ?? (link.archived ? 'Lien restauré.' : 'Lien archivé. Ses URLs sont conservées.'));
    }
    catch (error) { setError(error instanceof Error ? error.message : 'La modification n’a pas abouti.'); }
    finally { setBusy(false); }
  }
  async function copy(url: string) {
    try { await navigator.clipboard.writeText(url); announce('Lien copié.'); }
    catch { setCopied(url); announce('Sélectionne et copie le lien affiché.'); setTimeout(() => { urlInput.current?.focus(); urlInput.current?.select(); }, 0); }
  }
  return <><p className="blg-note"><Icon name="info" />Chaque nouvelle version garde une URL propre. Les liens déjà diffusés restent inchangés.</p>{(!data.persistent || data.notice) && <p className="blg-note">{data.notice ?? 'Le registre est en démonstration ; les liens ne sont pas enregistrés dans la base de production.'}</p>}<div className="blg-links-layout"><section className="blg-panel blg-link-builder"><div className="blg-panel-heading"><div><span className="blg-eyebrow">GÉNÉRATEUR</span><h2>{editing ? `Nouvelle version · v${editing.current.version + 1}` : 'Créer un lien'}</h2></div><Icon name="link" /></div><form ref={form} onSubmit={submit} className="blg-link-form"><label>Où vas-tu le partager ?<select aria-label="Où vas-tu le partager ?" value={input.placement} onChange={event => setInput({ ...input, placement: event.target.value as LinkPlacement })}>{Object.entries(placements).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select></label><label>Vers quelle page ?<select aria-label="Vers quelle page ?" value={input.destination} onChange={event => setInput({ ...input, destination: event.target.value as LinkInput['destination'] })}><option value="quiz">Quiz</option><option value="masterclass">Masterclass</option></select></label><label>Campagne<input value={input.campaign} onChange={event => setInput({ ...input, campaign: event.target.value })} placeholder="Ex. rentrée-septembre" required maxLength={100} /></label><label>Nom pour le retrouver<input value={input.label} onChange={event => setInput({ ...input, label: event.target.value })} placeholder="Ex. Bio Instagram · septembre" required maxLength={120} /></label><p className="blg-field-help">Un nom simple suffit. Les paramètres de suivi sont ajoutés automatiquement.</p><button className="blg-button blg-primary" disabled={busy}><Icon name={editing ? 'refresh' : 'plus'} size={18} />{busy ? 'Enregistrement…' : editing ? 'Enregistrer cette version' : 'Créer le lien'}</button>{editing && <button type="button" className="blg-button" disabled={busy} onClick={() => { setEditing(null); setInput(blank); setError(''); }}>Annuler la nouvelle version</button>}<div className="blg-placement-help"><span className="blg-eyebrow">OÙ COLLER LE LIEN</span><p>{placements[input.placement].instruction}</p></div></form></section><section className="blg-panel blg-link-register"><div className="blg-panel-heading"><div><span className="blg-eyebrow">REGISTRE {data.mode === 'demo' ? 'DE DÉMONSTRATION' : ''}</span><h2>Retrouver les liens</h2></div><div className="blg-switch"><button aria-pressed={!archive} onClick={() => setArchive(false)}>Actifs</button><button aria-pressed={archive} onClick={() => setArchive(true)}>Archivés</button></div></div>{error && <div className="blg-inline-error" role="alert"><p>{error}</p><button className="blg-text-button" onClick={refresh}>Actualiser le registre</button></div>}{!shown.length ? <Empty title={archive ? 'Aucun lien archivé' : 'Ton prochain lien commence ici'}>{archive ? 'Les liens archivés pourront être restaurés depuis cette vue.' : 'Choisis son emplacement, sa destination et sa campagne, puis crée le lien.'}</Empty> : <div className="blg-link-list">{shown.map(link => <article className="blg-link-record" key={link.id}><div className="blg-link-record-heading"><div><h3>{link.current.label}</h3><p>{placements[link.current.placement]?.label ?? link.current.placement} <span>·</span> {link.current.destination === 'quiz' ? 'Quiz' : 'Masterclass'}</p></div><span className="blg-version">v{link.current.version}</span></div><p className="blg-link-campaign">Campagne : {link.current.campaign}</p><div className="blg-url-row"><code>{link.current.url}</code><button className="blg-button" onClick={() => copy(link.current.url)} aria-label={`Copier le lien ${link.current.label}`}><Icon name="copy" size={16} />Copier</button></div><p className="blg-field-help">{placements[link.current.placement]?.instruction}</p><div className="blg-link-actions"><span>{formatDate(link.current.createdAt)}</span><button className="blg-text-button" disabled={busy || link.archived} onClick={() => { setEditing(link); setInput({ placement: link.current.placement, destination: link.current.destination, campaign: link.current.campaign, label: link.current.label }); setError(''); form.current?.scrollIntoView({ behavior: 'auto', block: 'center' }); form.current?.querySelector('select')?.focus(); }}>Nouvelle version</button><button className="blg-text-button" disabled={busy} onClick={() => changeArchive(link)}>{link.archived ? 'Restaurer' : 'Archiver'}</button></div><details className="blg-version-history"><summary>Historique · {link.revisions.length} version{link.revisions.length !== 1 ? 's' : ''}</summary>{link.revisions.map(revision => <div className="blg-old-version" key={revision.id}><div><strong>v{revision.version}</strong> · {formatDate(revision.createdAt)} · {revision.label}</div><code>{revision.url}</code><button className="blg-text-button" onClick={() => copy(revision.url)}>Copier cette version</button></div>)}</details></article>)}</div>}</section></div>{copied && <Dialog title="Copier le lien" onClose={() => setCopied('')}><label className="blg-manual-copy">Lien à copier<input ref={urlInput} value={copied} readOnly onFocus={event => event.target.select()} /></label><p className="blg-field-help">Utilise la commande Copier de ton appareil.</p></Dialog>}</>;
}

function Connections({ data, refresh, announce }: { data: ConnectionsResponse; refresh: () => void; announce: (message: string) => void }) {
  const [busy, setBusy] = useState(''); const [error, setError] = useState('');
  const status: Record<Connection['status'], string> = { connected: 'Accès disponible', partial: 'Partiellement raccordé', missing: 'À raccorder', error: 'Lecture interrompue', demo: 'Démonstration' };
  async function sync(connection: Connection) {
    setBusy(connection.id); setError('');
    try { const result=connection.id==='notion'?await refreshNotionToCompletion(()=>request(`/api/sync/notion`,{method:'POST',body:'{}',timeoutMs:75_000}),read=>announce(`Notion : ${read} fiches lues, lecture en cours…`)):await request<{status:string}>(`/api/sync/${connection.id}`, { method: 'POST', body: '{}' }); announce(result.status==='partial'?`Lecture ${connection.name} en cours ou partielle. Les données déjà publiées restent disponibles.`:`Lecture ${connection.name} terminée. Consulte la couverture actualisée.`); refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : 'La lecture n’a pas abouti.'); }
    finally { setBusy(''); }
  }
  return <><p className="blg-note"><Icon name="lock" />Les sources sont consultées en lecture seule. Un accès disponible ne signifie pas que l’alimentation automatique est installée.</p>{error && <p className="blg-inline-error" role="alert">{error}</p>}<div className="blg-connections">{data.connections.map((connection, index) => <section className="blg-panel blg-connection" key={connection.id}><div className="blg-connection-heading"><span className="blg-number">{String(index + 1).padStart(2, '0')}</span><div><h2>{connection.name}</h2><span className="blg-connection-status">{connection.status === 'connected' ? '✓ ' : connection.status === 'error' ? '! ' : '— '}{status[connection.status]}</span></div></div><p>{connection.summary}</p><dl><div><dt>Dernière synchronisation</dt><dd>{formatDate(connection.lastSyncAt, true)}</dd></div><div><dt>Couverture</dt><dd>{connection.coverage}</dd></div></dl>{connection.limits.length > 0 && <div className="blg-connection-limits"><span className="blg-eyebrow">LIMITES ACTUELLES</span><ul>{connection.limits.map(limit => <li key={limit}>{limit}</li>)}</ul></div>}{connection.canSync && ['meta', 'notion'].includes(connection.id) && <button className="blg-button" disabled={!!busy} onClick={() => sync(connection)}><Icon name="refresh" size={16} />{busy === connection.id ? 'Lecture en cours…' : 'Lire les données disponibles'}</button>}</section>)}</div><p className="blg-footnote">Aucune donnée source n’est modifiée depuis ce cockpit. L’installation des pages et le déploiement sont suivis séparément.</p></>;
}

export default function Cockpit({ mode, user }: { mode: DataMode; user: string }) {
  const [view, setView] = useState<View>('results'); const [filters, setFilters] = useState<DashboardFilters>(() => defaultFilters()); const [draftFilters, setDraftFilters] = useState<DashboardFilters>(filters); const [filterError, setFilterError] = useState(''); const [revision, setRevision] = useState(0); const [notice, setNotice] = useState(''); const [metric, setMetric] = useState<Metric | null>(null); const [logoutPending, setLogoutPending] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [journey,setJourney]=useState('quiz');
  const [salesQuery, setSalesQuery] = useState<CommercialQuery>(() => { const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); return { from: day, to: day, view: 'appointments', page: 0, pageSize: 50, search: '', origin: 'all', status: 'all', attendance: 'all', owner: 'all', nextAction: 'all', followUp: 'all' }; });
  const active = views.find(item => item.id === view)!; const title = useRef<HTMLHeadingElement>(null);
  const dashboard = useRemote<DashboardResponse>(view === 'results' || view === 'journey' ? `/api/dashboard?${filtersQuery(filters)}` : null, revision);
  const reports = usePostHogReports(filters, mode==='live' && ['results','journey'].includes(view) && !!dashboard.data && !dashboard.loading && dashboard.data.period.from===filters.from && dashboard.data.period.to===filters.to, revision, dashboard.setData,filters.tunnel==='masterclass'||(view==='journey'&&filters.tunnel==='all'&&journey==='masterclass')?'masterclass':'quiz');
  const links = useRemote<LinksResponse>(view === 'links' ? '/api/links' : null, revision);
  const sales = useRemote<CommercialDashboard>(view === 'sales' ? `/api/commercial?${serializeCommercialQuery(salesQuery)}` : null, revision, true);
  const connections = useRemote<ConnectionsResponse>(view === 'connections' ? '/api/connections' : null, revision);
  const current = view === 'results' || view === 'journey' ? dashboard : view === 'links' ? links : view === 'sales' ? sales : connections;
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  async function refreshSources() {
    if(view==='sales'){
      if(mode==='demo'){refresh();return;}
      setSyncing(true);
      try {
        const invoke=()=>request<import('../lib/refresh-plan').RefreshResult>('/api/sync/notion',{method:'POST',body:'{}',timeoutMs:75_000});
        const result=await refreshNotionToCompletion(invoke,read=>setNotice(`Notion : ${read} fiches lues, lecture en cours…`));
        const label:Record<string,string>={complete:'Lecture Notion terminée.',empty:'Aucune fiche retournée par Notion.',partial:'Lecture Notion partielle ou en cours.',failed:'Lecture Notion interrompue.'};
        setNotice((label[result.status]??'Lecture Notion interrompue.')+(result.coverage?.reason?` ${result.coverage.reason}`:'')); refresh();
      } catch(error) { setNotice(error instanceof Error ? error.message : 'Lecture Notion interrompue. Les données déjà importées restent disponibles.'); }
      finally {setSyncing(false);} return;
    }
    if(mode==='demo'||!['results','journey'].includes(view)){refresh();return;}
    setSyncing(true);
    try {
      const invoke=(path:string)=>request<import('../lib/refresh-plan').RefreshResult>(path,{method:'POST',body:'{}',timeoutMs:75_000});
      const query=filtersQuery(filters);
      const jobs:{source:string;work:Promise<{status:string;coverage?:{reason?:string}}> }[]=[
        {source:'wix',work:invoke(`/api/sync/wix?${query}`)},
        {source:'notion',work:refreshNotionToCompletion(()=>invoke('/api/sync/notion'),read=>setNotice(`Notion : ${read} fiches lues, lecture en cours…`))},
        {source:'commerce',work:refreshNotionToCompletion(()=>invoke('/api/sync/commerce'),read=>setNotice(`Ventes : ${read} éléments lus, rapprochement en cours…`))},
        {source:'receipts',work:invoke(`/api/sync/receipts?${query}`)},
        {source:'meta',work:(async()=>{for(const period of metaRefreshPeriods(filters.from,filters.to)){const result=await invoke(`/api/sync/meta?${filtersQuery({...filters,...period})}`);if(result.status!=='complete')return result;}return {status:'complete'};})()},
      ];
      const quizSupported=!filters.campaign||/^meta:\d+$/.test(filters.campaign);
      if(filters.tunnel!=='masterclass'&&quizSupported)jobs.push({source:'quiz',work:invoke(`/api/sync/analytics?${query}&type=quiz`)});
      if(filters.tunnel!=='quiz'&&filters.source==='all'&&!filters.campaign)jobs.push({source:'masterclass',work:invoke(`/api/sync/analytics?${query}&type=masterclass`)});
      const tasks=await Promise.allSettled(jobs.map(job=>job.work));
      const sources=tasks.map((r,i)=>({source:jobs[i].source,status:r.status==='rejected'?'failed':r.value.status,detail:r.status==='rejected'&&['notion','commerce'].includes(jobs[i].source)?'Clique à nouveau sur Actualiser pour reprendre la lecture.':r.status==='fulfilled'&&r.value.status==='partial'?r.value.coverage?.reason:undefined}));
      const labels:Record<string,string>={complete:'actualisé',partial:'lecture partielle ou en cours',empty:'aucune mesure retournée',failed:'échec'};
      const names:Record<string,string>={wix:'Wix',quiz:'Quiz',masterclass:'Masterclass',notion:'Notion',receipts:'Paiements reçus',commerce:'Ventes payées',meta:'Meta'};
      setNotice(sources.map((s:{source:string;status:string;detail?:string})=>`${names[s.source]??s.source} : ${labels[s.status]??'échec'}${s.detail?` — ${s.detail}`:''}`).join(' · '));
      refresh();
    } catch {setNotice('Actualisation interrompue. Les données déjà enregistrées restent disponibles.');}
    finally {setSyncing(false);}
  }
  function navigate(id: View) { setView(id); setNotice(''); setTimeout(() => title.current?.focus(), 0); }
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 7000); return () => clearTimeout(timer); }, [notice]);
  function applyFilters(event: FormEvent) { event.preventDefault(); const error = validateDateRange(draftFilters.from, draftFilters.to); setFilterError(error ?? ''); if (!error) setFilters(draftFilters); }
  async function logout() {
    setLogoutPending(true);
    try { const response = await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); if (!response.ok) throw new Error(); window.location.assign('/login'); }
    catch { setNotice('La déconnexion n’a pas abouti. Réessaie.'); setLogoutPending(false); }
  }
  return <div className="blg-app" data-view={view} data-light="subtle" data-motion="off"><a className="blg-skip" href="#blg-main">Aller au contenu</a><aside className="blg-sidebar"><a className="blg-brand" href="/" aria-label="Cockpit BLG, accueil"><span className="blg-brand-monogram">b.</span><span>BLG<span className="blg-brand-caption">LE COCKPIT</span></span></a><span className="blg-sidebar-label">PILOTER</span><nav aria-label="Navigation principale">{views.map(item => <button key={item.id} aria-current={view === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}><span className="blg-nav-icon"><Icon name={item.icon} /></span><span>{item.label}</span>{view === item.id && <span className="blg-nav-dot" />}</button>)}</nav><div className="blg-sidebar-bottom"><div className="blg-sidebar-note"><Icon name="lock" size={16} /><span>Espace privé<br /><strong>{view === 'results' ? 'Accès au cockpit' : mode === 'demo' ? 'Mode démonstration' : 'Lecture des sources'}</strong></span></div><div className="blg-user"><span className="blg-avatar">{(user === 'private' ? 'A' : user?.slice(0, 1) || 'B').toUpperCase()}</span><span title={user === 'private' ? 'Accès privé' : user}>{user === 'private' ? 'Accès privé' : user}<small>Accès au cockpit</small></span><button onClick={logout} disabled={logoutPending} aria-label="Se déconnecter"><Icon name="logout" size={18} /></button></div></div></aside><div className="blg-workspace"><header className="blg-topbar"><span>Cockpit <span>/</span> {active.label}</span><div><span className="blg-private-label"><Icon name="lock" size={13} /> Privé</span>{view === 'results' ? (mode === 'demo' ? <DemoIndicator /> : null) : <span className="blg-mode-label">{mode === 'demo' ? 'Données de démonstration' : 'Données connectées · couverture variable'}</span>}<button className="blg-mobile-logout" onClick={logout} disabled={logoutPending} aria-label="Se déconnecter du cockpit"><Icon name="logout" size={16} /></button></div></header><main id="blg-main" className="blg-main"><div className="blg-intro"><div>{view !== 'results' && <span className="blg-eyebrow">BLG STUDIO · {active.label.toLocaleUpperCase('fr')}</span>}<h1 ref={title} tabIndex={-1}>{view === 'results' ? 'Résultats' : active.title}</h1>{view !== 'results' && <p>{active.description}</p>}</div><button className="blg-button" onClick={refreshSources} disabled={current.loading || syncing}><Icon name="refresh" size={16} />{syncing ? 'Synchronisation…' : current.loading ? 'Lecture…' : 'Actualiser'}</button></div>{mode === 'demo' && view !== 'results' && <div className="blg-demo-banner"><span className="blg-demo-symbol">D</span><div><strong>Espace de démonstration</strong><p>Tous les chiffres, prospects et connexions de cet espace sont fictifs. Ils servent à essayer le cockpit.</p></div></div>}
      {view === 'results' && <ResultsFilters draft={draftFilters} applied={filters} onChange={setDraftFilters} onApply={applyFilters} campaigns={dashboard.data?.campaigns ?? []} busy={current.loading} error={filterError} />}
      {view === 'journey' && <form className="blg-filters" onSubmit={applyFilters}><label>Du<input type="date" value={draftFilters.from} onChange={event => setDraftFilters({ ...draftFilters, from: event.target.value })} required /></label><label>Au<input type="date" value={draftFilters.to} onChange={event => setDraftFilters({ ...draftFilters, to: event.target.value })} required /></label><label>Source<select aria-label="Source" value={draftFilters.source} onChange={event => setDraftFilters({ ...draftFilters, source: event.target.value as DashboardFilters['source'] })}><option value="all">Toutes</option><option value="paid">Payé</option><option value="organic">Organique</option><option value="unknown">Inconnu</option></select></label><label>Tunnel<select aria-label="Tunnel" value={draftFilters.tunnel} onChange={event => setDraftFilters({ ...draftFilters, tunnel: event.target.value as DashboardFilters['tunnel'] })}><option value="all">Tous</option><option value="quiz">Quiz</option><option value="masterclass">Masterclass</option></select></label><label>Périmètre<select aria-label="Campagne, publicité ou créative" value={draftFilters.campaign} onChange={event => setDraftFilters({ ...draftFilters, campaign: event.target.value })}><option value="">Toutes</option>{dashboard.data?.campaigns.map(campaign => <option key={campaign.id} value={campaign.id}>{campaign.label}</option>)}</select></label><button className="blg-button blg-primary" disabled={current.loading}>Appliquer</button><label className="blg-compare"><input type="checkbox" checked={draftFilters.compare} onChange={event => setDraftFilters({ ...draftFilters, compare: event.target.checked })} />Comparer à la période précédente</label><span className="blg-filter-timezone">Dates incluses · Europe/Paris</span>{filterError && <p className="blg-filter-error" role="alert">{filterError}</p>}</form>}
      {dashboard.data && view === 'journey' && <><div className="blg-period-summary"><span><Icon name="calendar" size={15} />{formatDate(dashboard.data.period.from)} — {formatDate(dashboard.data.period.to)}</span><span>Lecture : {formatDate(dashboard.data.generatedAt, true)}</span></div>{dashboard.data.notices.map((message, index) => <p className="blg-note" key={index}><Icon name="info" size={17} />{message}</p>)}</>}
      <div className="blg-content" aria-busy={current.loading}>{current.loading && !current.data ? <div className="blg-loading" role="status"><span className="blg-loading-mark" /><p>Lecture des données disponibles…</p></div> : current.error && !current.data ? <Empty title="La lecture est interrompue" action={<button className="blg-button" onClick={refresh}>Réessayer</button>}>{current.error}</Empty> : <>{current.loading && <p className="blg-note" role="status">Actualisation en cours. Les données de la dernière lecture restent affichées.</p>}{current.error && <p className="blg-inline-error" role="alert">{current.error} Les données de la dernière lecture restent affichées.</p>}{view === 'results' && dashboard.data && <ResultsPage data={dashboard.data} filters={filters} posthog={reports.state} retryPosthog={reports.retry} />}{view === 'journey' && dashboard.data && <Journey data={dashboard.data} compare={filters.compare} onMetric={setMetric} filters={filters} journey={journey} setJourney={setJourney} posthog={reports.state} retryPosthog={reports.retry} />}{view === 'sales' && sales.data && <CommercialPage data={sales.data} loading={sales.loading} onQueryChange={next => setSalesQuery(current => ({ ...current, ...next }))} onRetry={refresh} />}{view === 'links' && links.data && <Links data={links.data} onUpdate={links.setData} announce={setNotice} refresh={refresh} />}{view === 'connections' && connections.data && <Connections data={connections.data} refresh={refresh} announce={setNotice} />}</>}</div><footer className="blg-footer"><span>BLG · Un point de vue sur les faits.</span><span>{view === 'results' ? 'Espace privé' : mode === 'demo' ? 'Démonstration · données synthétiques' : 'Sources en lecture seule'} <span>·</span> Europe/Paris</span></footer></main></div><div className={`blg-toast ${notice ? 'is-visible' : ''}`} role="status" aria-live="polite">{notice}</div>{metric && <MetricDetail metric={metric} mode={mode} onClose={() => setMetric(null)} />}</div>;
}
