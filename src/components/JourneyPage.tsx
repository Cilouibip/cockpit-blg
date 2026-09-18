'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { DashboardFilters, DataMode } from '../lib/ui-contract';
import type { JourneyMetric, JourneyReport, JourneyTunnel, JourneyVideoReport } from '../lib/journey-contract';
import type { VisualJourneyReport } from '../lib/visual-journey-contract';
import { request } from '../lib/cockpit-request';
import {loadVisualJourney} from '../lib/visual-journey-client';
import { formatDate, formatNumber } from './ui-format';
import { VisualJourneyView } from './VisualJourneyView';

const count = (value: number | null | undefined) => value == null ? 'Non disponible' : formatNumber(value);
const percent = (value: number | null | undefined) => value == null ? 'Non disponible' : formatNumber(value * 100, 'percent');
export function videoTime(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'Non disponible';
  const seconds = Math.max(0, Math.round(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
function versionLabel(version: string): string {
  if (version === 'unversioned') return 'Version non renseignée';
  const match = version.match(/(\d{4}-\d{2}-\d{2})(?:\.(\d+))?$/);
  return match ? `${formatDate(match[1])}${match[2] ? ` · révision ${match[2]}` : ''}` : version;
}
function Missing({ reason }: { reason?: string | null }) {
  return <div className="journey-empty"><strong>Mesure non disponible</strong><p>{reason || 'Les mesures nécessaires à ce détail ne sont pas encore disponibles.'}</p></div>;
}
function MetricValue({ metric }: { metric: JourneyMetric }) {
  return <span title={metric.reason ?? undefined}>{metric.available ? count(metric.value) : 'Non disponible'}</span>;
}

export function VideoPositions({ position }: { position: JourneyVideoReport['lastObservedPosition'] }) {
  const id = useId(); const [selected, setSelected] = useState<number | null>(null);
  if (!position.availability.available || !position.buckets.length) return <Missing reason={position.availability.reason} />;
  const bins = position.buckets;
  const highest = Math.max(1, ...bins.map(row => row.sessions));
  const width = 720, left = 42, right = 22, top = 20, bottom = 175;
  const firstPosition = Math.min(...bins.map(bin => bin.fromSeconds));
  const lastPosition = Math.max(...bins.map(bin => bin.fromSeconds));
  const x = (i: number) => lastPosition === firstPosition ? (left + width - right) / 2 : left + (bins[i].fromSeconds - firstPosition) / (lastPosition - firstPosition) * (width - left - right);
  const y = (n: number) => bottom - n / highest * (bottom - top);
  const points = bins.map((bin, i) => `${x(i)},${y(bin.sessions)}`).join(' ');
  const label = (i: number) => `${videoTime(bins[i].fromSeconds)}${bins[i].toSeconds == null ? ' et après' : ` à ${videoTime(bins[i].toSeconds)}`} : ${count(bins[i].sessions)} visite${bins[i].sessions === 1 ? '' : 's'}`;
  const active = selected !== null && selected < bins.length ? selected : null;
  return <>
    <div className="journey-chart" role="group" aria-labelledby={`${id}-title`}>
      <svg viewBox={`0 0 ${width} 213`} role="img" aria-labelledby={`${id}-title ${id}-description`}>
        <title id={`${id}-title`}>Dernière position observée dans la vidéo</title>
        <desc id={`${id}-description`}>Nombre de visites par dernière position reçue. Les pauses et lectures en cours sont incluses. Le détail est disponible dans le tableau sous la courbe.</desc>
        {[...new Set([0, Math.ceil(highest / 2), highest])].map(value => <g key={value}><line className="journey-chart-grid" x1={left} x2={width - right} y1={y(value)} y2={y(value)} /><text x={left - 9} y={y(value) + 4} textAnchor="end">{formatNumber(value)}</text></g>)}
        <polyline className="journey-chart-line" points={points} fill="none" />
        {bins.map((bin, i) => <g key={bin.fromSeconds}>
          <circle className={`journey-chart-point ${active === i ? 'is-active' : ''}`} cx={x(i)} cy={y(bin.sessions)} r={active === i ? 6 : 4} tabIndex={0} aria-label={label(i)} onFocus={() => setSelected(i)} onMouseEnter={() => setSelected(i)} onClick={() => setSelected(i)}><title>{label(i)}</title></circle>
          {(i === 0 || i === bins.length - 1 || i % Math.max(1, Math.ceil(bins.length / 6)) === 0) && <text x={x(i)} y={199} textAnchor="middle">{videoTime(bin.fromSeconds)}</text>}
        </g>)}
      </svg>
      <p className="journey-chart-reading" aria-live="polite">{active === null ? 'Survole un point ou sélectionne-le au clavier pour voir le détail.' : label(active)}</p>
    </div>
    <details className="journey-detail"><summary>Voir les valeurs de la courbe</summary><div className="blg-table-scroll"><table><thead><tr><th>Dernière position</th><th>Visites</th></tr></thead><tbody>{bins.map((bin, i) => <tr key={i}><td>{videoTime(bin.fromSeconds)}{bin.toSeconds == null ? ' et après' : ` – ${videoTime(bin.toSeconds)}`}</td><td>{count(bin.sessions)}</td></tr>)}</tbody></table></div></details>
  </>;
}

export function JourneyReportView({ report }: { report: JourneyReport }) {
  const { video } = report;
  const maxStep = Math.max(1, ...report.steps.map(step => step.count ?? 0));
  return <>
    <section className="blg-panel journey-panel" aria-labelledby="journey-steps-title">
      <div className="blg-panel-heading"><div><span className="blg-eyebrow">DU PREMIER PASSAGE AU RENDEZ-VOUS</span><h2 id="journey-steps-title">{report.scope.tunnel === 'masterclass' ? 'Le parcours de la masterclass' : 'Le parcours du quiz'}</h2></div></div>
      <p className="journey-intro">Les volumes comptent des visites suivies. Une même personne peut revenir plusieurs fois. Les taux relient deux étapes dans la même visite, dans l’ordre.</p>
      <p className="journey-intro">Les rendez-vous enregistrés se consultent aussi dans Commercial. Une réservation depuis un email peut y figurer sans être mesurée dans ce parcours. Les événements Meta ne sont pas ajoutés à ces rendez-vous.</p>
      <ol className="journey-steps">{report.steps.map((step, index) => <li key={step.id}>
        <span className="blg-number">{String(index + 1).padStart(2, '0')}</span>
        <div className="journey-step-copy"><h3>{step.label}</h3><div className="journey-step-track" aria-hidden="true"><span style={{ width: `${Math.min(100, (step.count ?? 0) / maxStep * 100)}%` }} /></div>{!step.availability.available && <p>{step.availability.reason}</p>}</div>
        <strong className={step.count == null ? 'journey-unavailable' : ''}>{step.availability.available ? count(step.count) : 'Non disponible'}</strong>
        <div className="journey-step-rate">{step.fromPrevious ? <><strong>{step.fromPrevious.availability.available ? percent(step.fromPrevious.rate) : 'Non disponible'}</strong><small>{step.fromPrevious.availability.available ? `${count(step.fromPrevious.pairedSessions)} sur ${count(step.fromPrevious.eligibleSessions)} visites de l’étape précédente` : step.fromPrevious.availability.reason}</small></> : <small>Point de départ</small>}</div>
      </li>)}</ol>
    </section>

    {report.scope.tunnel === 'masterclass' && <section className="blg-panel journey-panel" aria-labelledby="journey-video-title">
      <div className="blg-panel-heading"><div><span className="blg-eyebrow">LA VIDÉO</span><h2 id="journey-video-title">Jusqu’où les visiteurs regardent</h2></div><span className="blg-muted">{video.durationSeconds.available ? `Durée : ${videoTime(video.durationSeconds.value)}` : 'Durée non disponible'}</span></div>
      <div className="journey-video-summary"><div><span>Lectures démarrées</span><strong><MetricValue metric={video.startedSessions} /></strong></div><div><span>Rendez-vous après le démarrage</span><strong><MetricValue metric={video.bookedAfterStart} /></strong><small>Même visite suivie</small></div><div><span>Temps lu au premier plan · médiane</span><strong title={video.foregroundPlayedSeconds.reason ?? undefined}>{video.foregroundPlayedSeconds.available ? videoTime(video.foregroundPlayedSeconds.p50Seconds) : 'Non disponible'}</strong><small>Relectures comprises</small></div></div>
      {!video.availability.available && <Missing reason={video.availability.reason} />}
      {video.availability.available && <><h3 className="journey-subtitle">Progression dans le lecteur</h3><div className="journey-milestones">{[25, 50, 75, 100].map(level => { const milestone = video.milestones.find(item => item.percent === level); return <div key={level}><span>{level === 100 ? 'Fin atteinte' : `${level} %`}</span><strong>{milestone ? count(milestone.sessions) : 'Non disponible'}</strong><small>visites mesurées</small></div>; })}</div><p className="journey-intro">La progression et le temps lu sont deux mesures distinctes. Un déplacement dans le lecteur ne prouve pas que le passage a été regardé.</p></>}
      <h3 className="journey-subtitle">Dernière position observée</h3>
      <p className="journey-intro">Repère les endroits où les lectures s’arrêtent. Les pauses et les lectures encore en cours sont incluses ; ce n’est pas un comptage d’abandons définitifs.</p>
      <VideoPositions position={video.lastObservedPosition} />
      <details className="journey-detail"><summary>Comprendre les durées mesurées</summary><p>Le temps au premier plan compte les secondes jouées avec l’onglet visible, relectures comprises. La durée de contenu parcouru compte chaque passage une fois, mais peut inclure un onglet masqué. Aucune de ces mesures ne prouve l’attention du spectateur.</p><dl><div><dt>Contenu parcouru · médiane</dt><dd>{video.uniqueContentSeconds.available ? videoTime(video.uniqueContentSeconds.p50Seconds) : 'Non disponible'}</dd></div><div><dt>Temps au premier plan · médiane</dt><dd>{video.foregroundPlayedSeconds.available ? videoTime(video.foregroundPlayedSeconds.p50Seconds) : 'Non disponible'}</dd></div></dl></details>
    </section>}

    {report.scope.tunnel === 'quiz' && <section className="blg-panel journey-panel"><div className="blg-panel-heading"><div><span className="blg-eyebrow">QUESTION PAR QUESTION</span><h2>Où le quiz s’interrompt</h2></div></div><p className="journey-intro">« Sans réponse observée » relie une question affichée à sa réponse dans la même visite. Si l’affichage n’est pas mesuré, ce nombre reste indisponible.</p>{report.questions.length ? <div className="blg-table-scroll"><table className="journey-questions"><thead><tr><th>Question</th><th>Atteinte</th><th>Répondue</th><th>Sans réponse observée</th></tr></thead><tbody>{report.questions.map(question => <tr key={question.number}><th scope="row">Question {question.number}</th><td><MetricValue metric={question.reached} /></td><td><MetricValue metric={question.answered} /></td><td><MetricValue metric={question.abandoned} /></td></tr>)}</tbody></table></div> : <Missing reason="Aucune mesure par question disponible sur cette période." />}</section>}

    {report.scope.tunnel === 'masterclass' && <section className="blg-panel journey-panel"><div className="blg-panel-heading"><div><span className="blg-eyebrow">SUR LA PAGE</span><h2>Les sections affichées</h2></div></div><p className="journey-intro">Une section affichée a été atteinte à l’écran. Cela ne signifie pas que son texte a été lu.</p>{report.sections.length ? <ul className="journey-sections">{report.sections.map(section => <li key={section.id}><span>{section.label}</span><strong>{count(section.sessions)} <small>visites</small></strong></li>)}</ul> : <Missing reason="Aucune section mesurée sur la période et la version sélectionnées." />}</section>}

    <details className="blg-panel journey-coverage"><summary>Sources, fraîcheur et couverture</summary><dl><div><dt>Dernière lecture des mesures</dt><dd>{formatDate(report.observedAt, true)}</dd></div><div><dt>Dernier événement reçu</dt><dd>{formatDate(report.coverage.lastObservedAt, true)}</dd></div><div><dt>Visites suivies dans ce périmètre</dt><dd>{count(report.coverage.includedSessions)}</dd></div><div><dt>Événements sans visite identifiable</dt><dd>{count(report.coverage.eventsMissingSessionIdentity)}</dd></div><div><dt>Événements d’essais identifiés</dt><dd>{count(report.coverage.identifiableTestEvents)} · {report.scope.includeTests ? 'inclus' : 'exclus'}</dd></div></dl><p>{report.coverage.reason}</p>{report.notices.map(notice => <p key={notice}>{notice}</p>)}</details>
  </>;
}

export default function JourneyPage({ filters, revision, mode, onOptionsChange, onTunnelChange }: { filters: DashboardFilters; revision: number; mode: DataMode; onOptionsChange?: (ads: VisualJourneyReport['availableAds']) => void; onTunnelChange?: (tunnel: JourneyTunnel) => void }) {
  const [selected, setSelected] = useState<JourneyTunnel>('masterclass');
  const [includeTests, setIncludeTests] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; report: JourneyReport } | null>(null);
  const [visualLoaded, setVisualLoaded] = useState<{ key: string; report: VisualJourneyReport } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const optionsCallback = useRef(onOptionsChange);
  optionsCallback.current = onOptionsChange;
  const tunnel = filters.tunnel === 'all' ? selected : filters.tunnel;
  const query = new URLSearchParams({ from: filters.from, to: filters.to, tunnel, source: filters.source, campaign: filters.campaign, includeTests: String(includeTests) }).toString();
  const report = loaded?.key === query && ['complete', 'empty'].includes(loaded.report.status) ? loaded.report : null;
  const visualReport = visualLoaded?.key === query && ['complete', 'partial', 'empty', 'not_configured'].includes(visualLoaded.report.status) ? visualLoaded.report : null;
  const error = failure?.key === query ? failure.message : null;
  const busy = pending === query;
  useEffect(() => { onTunnelChange?.(tunnel); }, [onTunnelChange, tunnel]);
  useEffect(() => {
    if (mode === 'demo') return;
    const controller = new AbortController(); setPending(query); setFailure(null);
    const endpoint = tunnel === 'masterclass' ? '/api/journey-visual' : '/api/journey';
    const operation=tunnel==='masterclass'
      ? loadVisualJourney({url:`${endpoint}?${query}`,signal:controller.signal,transport:(url,signal)=>request<VisualJourneyReport>(url,{signal,timeoutMs:65_000}),onReport:result=>{
          if(controller.signal.aborted)return;
          if(['complete','partial','empty','not_configured'].includes(result.status)){setVisualLoaded({key:query,report:result});optionsCallback.current?.(result.availableAds);}
          else throw new Error(result.safeError||'Les données de parcours n’ont pas pu être chargées.');
        }})
      : request<JourneyReport>(`${endpoint}?${query}`,{signal:controller.signal,timeoutMs:65_000}).then(result=>{
          if(controller.signal.aborted)return;
          if(result.status==='complete'||result.status==='empty')setLoaded({key:query,report:result});
          else throw new Error('Les données du quiz n’ont pas pu être chargées.');
        });
    operation.catch(reason=>{if(!controller.signal.aborted)setFailure({key:query,message:reason instanceof Error?reason.message:'Les mesures n’ont pas pu être lues.'});})
      .finally(()=>{if(!controller.signal.aborted)setPending(null);});
    return () => controller.abort();
  }, [query, revision, attempt, mode, tunnel]);
  return <div className="journey-page" aria-busy={busy}>
    <div className="journey-toolbar"><div className="blg-switch" aria-label="Choisir le parcours">{(['masterclass', 'quiz'] as const).filter(value => filters.tunnel === 'all' || filters.tunnel === value).map(value => <button type="button" key={value} aria-pressed={tunnel === value} onClick={() => setSelected(value)}>{value === 'masterclass' ? 'Masterclass' : 'Quiz'}</button>)}</div><label className="blg-traffic-toggle"><input type="checkbox" checked={includeTests} onChange={event => setIncludeTests(event.target.checked)} />Inclure les essais</label></div>
    {mode === 'demo' ? <Missing reason="Le détail des parcours se lit dans l’espace connecté. Aucun chiffre de démonstration n’est présenté comme une mesure réelle." /> : <>
      {busy && <p className="journey-message" role="status">{visualReport?.loading ? 'Les visites et la vidéo se chargent…' : 'Lecture du parcours…'}</p>}
      {error && <p className="blg-inline-error" role="alert">{error} <button className="blg-text-button" onClick={() => setAttempt(value => value + 1)}>Réessayer</button></p>}
      {tunnel === 'masterclass' && visualReport && <VisualJourneyView report={visualReport} />}
      {tunnel === 'quiz' && report && <><p className="journey-freshness">Dernière lecture : {formatDate(report.observedAt, true)}</p><JourneyReportView report={report} /></>}
    </>}
  </div>;
}
