'use client';

import { useId, useMemo, useState, type ReactNode } from 'react';
import type { VisualJourneyMetric, VisualJourneyRate, VisualJourneyReport, VisualJourneyStage, VisualJourneyStageId } from '../lib/visual-journey-contract';
import { formatDate, formatNumber } from './ui-format';

const order: VisualJourneyStageId[] = ['page', 'form', 'signup', 'watch', 'call'];
const stageLabels: Record<VisualJourneyStageId, string> = { page: 'Visitent la page', form: 'Ouvrent le formulaire', signup: 'S’inscrivent', watch: 'Démarrent la vidéo', call: 'Réservent un rendez-vous' };
const sectionLabels: Record<string, string> = { hero: 'Le haut de la page', questions: 'Les trois questions', 'proof-section': 'Les témoignages', coach: 'La présentation de Jérôme', 'last-call': 'Le bas de la page' };
const placementLabels: Record<string, string> = { video_thumbnail: 'Sur la vidéo', hero: 'En haut', 'proof-section': 'Sous les témoignages', 'last-call': 'En bas' };
const sectionOrder = ['hero', 'questions', 'proof-section', 'coach', 'last-call'];
const placementOrder = ['hero', 'video_thumbnail', 'proof-section', 'last-call'];

function readableLabel(id: string, label: string, known: Record<string, string>): string {
  const key = id.trim().toLocaleLowerCase('fr');
  if (known[key]) return known[key];
  const text = (label || id).replaceAll('_', ' ').replaceAll('-', ' ').replace(/\s+/g, ' ').trim();
  return text ? text[0].toLocaleUpperCase('fr') + text.slice(1) : 'Emplacement non renseigné';
}

function inPageOrder<T extends { id: string }>(items: T[], knownOrder: string[]): T[] {
  return items.map((item, originalIndex) => ({ item, originalIndex, position: knownOrder.indexOf(item.id.trim().toLocaleLowerCase('fr')) })).sort((a, b) => (a.position < 0 ? knownOrder.length : a.position) - (b.position < 0 ? knownOrder.length : b.position) || a.originalIndex - b.originalIndex).map(row => row.item);
}

function Icon({ name }: { name: VisualJourneyStageId | 'arrow' | 'play' | 'person' }) {
  const paths: Record<string, ReactNode> = {
    page: <><path d="m5 3 14 7-6 2-3 7z" /><path d="m13 12 4 4" /></>,
    form: <><path d="M8 6H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3M16 6h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-3M10 4v16M14 8v8" /></>,
    signup: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m4 7 8 6 8-6M16 16l2 2 4-4" /></>,
    watch: <path d="m9 7 8 5-8 5z" />,
    call: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4M16 3v4M4 9h16m-11 5 2 2 4-4" /></>,
    arrow: <><path d="M5 12h14m-5-5 5 5-5 5" /></>,
    play: <path d="m9 7 8 5-8 5z" />,
    person: <><circle cx="12" cy="8" r="3" /><path d="M7 19a5 5 0 0 1 10 0" /></>,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function metricText(metric: VisualJourneyMetric): string {
  return metric.available ? formatNumber(metric.count) : '—';
}

function rateText(rate: VisualJourneyRate | null): string {
  return rate?.available && rate.rate != null ? formatNumber(rate.rate * 100, 'percent') : '—';
}

function rateDescription(rate: VisualJourneyRate | null): string {
  if (!rate?.available || rate.numerator == null || rate.denominator == null) return rate?.reason || 'Taux indisponible';
  return `${formatNumber(rate.numerator)} sur ${formatNumber(rate.denominator)} : ${rateText(rate)}`;
}

function secondsText(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
}

function thresholdLabel(seconds: number, duration: number | null): string {
  if (duration != null && seconds === duration) return 'Toute la vidéo';
  if (seconds < 60) return `${seconds} s`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return secondsText(seconds);
}

function SmallPoint({ metric, label }: { metric: VisualJourneyMetric; label: string }) {
  return <div className="journey-small-point"><strong title={metric.reason ?? undefined}>{metricText(metric)}</strong><span>{label}</span></div>;
}

function SmallEdge({ rate }: { rate: VisualJourneyRate }) {
  return <div className="journey-small-edge" aria-label={rateDescription(rate)} title={rateDescription(rate)}><Icon name="arrow" /><b>{rateText(rate)}</b></div>;
}

export function PageDetail({ report }: { report: VisualJourneyReport }) {
  const total = report.page.visitors.available ? report.page.visitors.count : null;
  const percent = (metric: VisualJourneyMetric) => metric.available && metric.count != null && total != null && total > 0 ? metric.count / total * 100 : null;
  return <>
    <h2>Que voient-ils sur la page ?</h2>
    <p className="journey-sub">Sur les {metricText(report.page.visitors)} visiteurs arrivés.</p>
    <div className="journey-page-detail">
      <div className="journey-mini-page" aria-hidden="true">
        <div className="journey-mini-browser"><em /><em /><em /><span>Votre page</span></div>
        <div className="journey-mini-block"><div className="journey-mini-brand">BLG STUDIO</div><div className="journey-mini-heading">La masterclass</div><div className="journey-mini-film"><Icon name="play" /></div><span className="journey-mini-cta">Découvrir la masterclass</span></div>
        <div className="journey-mini-block"><div className="journey-avatars"><span><Icon name="person" /></span><span><Icon name="person" /></span><span><Icon name="person" /></span></div><div className="journey-mini-quote">Les témoignages</div></div>
        <div className="journey-mini-block"><div className="journey-mini-quote">Le bas de la page</div><span className="journey-mini-cta">Découvrir la masterclass</span></div>
      </div>
      <div>
        <div className="journey-bars">{inPageOrder(report.page.sections, sectionOrder).map(section => { const value = percent(section.visitors); return <div key={section.id}><div className="journey-bar-caption"><span>{readableLabel(section.id, section.label, sectionLabels)}</span><b>{metricText(section.visitors)}{value != null && <span> · {formatNumber(value, 'percent')}</span>}</b></div><div className="journey-track"><span style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }} /></div></div>; })}</div>
        <h3>Où cliquent-ils pour s’inscrire ?</h3>
        <div className="journey-clicks">{report.page.ctaPlacements.length ? inPageOrder(report.page.ctaPlacements, placementOrder).map(placement => <span key={placement.id}><strong>{metricText(placement.visitors)}</strong> {readableLabel(placement.id, placement.label, placementLabels)} · {percent(placement.visitors) == null ? '—' : formatNumber(percent(placement.visitors), 'percent')} des visiteurs</span>) : <span><strong>{metricText(report.page.cta)}</strong> sur les boutons · {percent(report.page.cta) == null ? '—' : formatNumber(percent(report.page.cta), 'percent')} des visiteurs</span>}</div>
      </div>
    </div>
  </>;
}

export function FormDetail({ report }: { report: VisualJourneyReport }) {
  const { form } = report;
  return <>
    <h2>Du formulaire à l’inscription</h2>
    <p className="journey-sub">{metricText(form.registered)} personnes inscrites au total. {metricText(form.opened)} formulaires ouverts.</p>
    <div className="journey-small-route"><SmallPoint metric={form.opened} label="ouvrent le formulaire" /><SmallEdge rate={form.rates.startedFromOpened} /><SmallPoint metric={form.started} label="commencent à le remplir" /><SmallEdge rate={form.rates.registeredFromStarted} /><SmallPoint metric={form.registered} label="sont inscrites" /></div>
  </>;
}

function Freshness({ report }: { report: VisualJourneyReport }) {
  const labels = { posthog: 'Page et vidéo', wix: 'Inscriptions', appointments: 'Rendez-vous' } as const;
  const status = { available: '', stale: ' · à actualiser', running: ' · lecture en cours', unfinished: ' · lecture non terminée', failed: ' · lecture interrompue', missing: ' · indisponible' } as const;
  return <div className="journey-source-freshness" aria-label="Fraîcheur des chiffres">{(Object.keys(labels) as Array<keyof typeof labels>).map(source => { const item = report.freshness[source]; return <span key={source}>{labels[source]} : <strong>{formatDate(item.coveredThrough ?? item.observedAt, true)}</strong>{status[item.status]}</span>; })}</div>;
}

export function VideoDetail({ report }: { report: VisualJourneyReport }) {
  const id = useId();
  const duration = report.video.durationAvailability.available ? report.video.durationSeconds : null;
  const thresholds = useMemo(() => {
    const rows = [...report.video.thresholds];
    if (duration != null && !rows.some(row => row.seconds === duration)) rows.push({ seconds: duration, visitors: report.video.finished.count, fromStarted: { available: report.video.finished.available && report.video.started.available && report.video.started.count != null && report.video.started.count > 0, reason: report.video.finished.reason, numerator: report.video.finished.count, denominator: report.video.started.count, rate: report.video.finished.count != null && report.video.started.count ? report.video.finished.count / report.video.started.count : null } });
    return rows.filter(row => row.seconds >= 0).sort((a, b) => a.seconds - b.seconds);
  }, [duration, report.video]);
  const [selectedSeconds, setSelectedSeconds] = useState(() => thresholds.find(row => row.seconds === 60)?.seconds ?? thresholds[0]?.seconds ?? 0);
  const selectedIndex = Math.max(0, thresholds.findIndex(row => row.seconds === selectedSeconds));
  const selected = thresholds[selectedIndex] ?? null;
  const rate = selected?.fromStarted ?? null;
  const people = selected?.visitors ?? null;
  const thresholdCopy = selected && duration != null && selected.seconds === duration ? 'toute la vidéo' : selected ? `au moins ${selected.seconds < 60 ? `${selected.seconds} secondes` : `${Math.floor(selected.seconds / 60)} min${selected.seconds % 60 ? ` ${selected.seconds % 60} s` : ''}`}` : 'ce temps de vidéo';
  return <>
    <h2>Combien de temps regardent-ils ?</h2>
    <p className="journey-sub">{metricText(report.video.started)} personnes ont démarré la vidéo{duration == null ? '' : ` de ${Math.floor(duration / 60)} min ${duration % 60}`}.</p>
    <div className="journey-video-detail">
      <div className="journey-viewer" aria-hidden="true"><div className="journey-play"><Icon name="play" /></div><strong>La masterclass</strong><small>{duration == null ? 'Durée indisponible' : `${Math.floor(duration / 60)} min ${duration % 60}`}</small></div>
      <div><div className="journey-big-reading" title={rate?.reason ?? undefined}>{rateText(rate)}<span>{people == null ? '—' : formatNumber(people)} personnes sur {rate?.denominator == null ? '—' : formatNumber(rate.denominator)}</span></div><p className="journey-reading-sentence">ont regardé {thresholdCopy}.</p></div>
    </div>
    {thresholds.length > 0 && <><div className="journey-video-time"><label htmlFor={id}><span>Temps de vidéo regardé</span><strong>{selected ? secondsText(selected.seconds) : '—'}</strong></label><input id={id} type="range" min="0" max={Math.max(0, thresholds.length - 1)} value={selectedIndex} step="1" onChange={event => setSelectedSeconds(thresholds[Number(event.target.value)]?.seconds ?? selectedSeconds)} aria-valuetext={selected ? thresholdLabel(selected.seconds, duration) : 'Indisponible'} /><div className="journey-time-ends"><span>Début</span><span>{duration == null ? 'Fin' : `${secondsText(duration)} · Fin`}</span></div></div><div className="journey-marks a-state-picker">{thresholds.map(row => <button type="button" key={row.seconds} aria-pressed={row.seconds === selected?.seconds} onClick={() => setSelectedSeconds(row.seconds)}>{thresholdLabel(row.seconds, duration)}</button>)}</div></>}
  </>;
}

export function BookingDetail({ report }: { report: VisualJourneyReport }) {
  const { booking } = report;
  return <>
    <h2>Du clic au rendez-vous</h2>
    <p className="journey-sub">{metricText(booking.booked)} {booking.booked.count === 1 ? 'personne a réservé' : 'personnes ont réservé'} un rendez-vous.</p>
    <div className="journey-small-route"><SmallPoint metric={booking.clicked} label="cliquent pour réserver" /><SmallEdge rate={booking.rates.calendarFromClicked} /><SmallPoint metric={booking.calendar} label="ouvrent le calendrier" /><SmallEdge rate={booking.rates.bookedFromCalendar} /><SmallPoint metric={booking.booked} label="réservent un rendez-vous" /></div>
    {!!booking.people?.length && <div className="journey-bookings"><h3>Qui a réservé ?</h3><ul className="booking-people-list">{booking.people.map((person, index) => <li key={person.appointments[0]?.id ?? index}><div className="booking-person-icon"><Icon name="person" /></div><div className="booking-person-info"><strong>{person.name}</strong><span>{person.originLabel}</span>{person.appointments.map(appointment => <div className="booking-person-slot" key={appointment.id}><b>Rendez-vous {appointment.scheduledAt ? `le ${formatDate(appointment.scheduledAt, appointment.scheduledAt.length > 10)}` : 'à une date non renseignée'}</b><span>{appointment.bookedAt ? `Réservé le ${formatDate(appointment.bookedAt, appointment.bookedAt.length > 10)}` : 'Date de réservation non renseignée'} · {({ scheduled: 'Prévu', attended: 'Réalisé', no_show: 'Absent' } as Record<string,string>)[appointment.status] ?? 'Réservation enregistrée'}</span></div>)}</div></li>)}</ul></div>}
  </>;
}

function durationText(milliseconds: number): string {
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
}

/** Technical wait of the live PostHog read: durations only. */
function visitsTiming(report: VisualJourneyReport): string | null {
  const timing = report.timing?.posthog;
  if (timing?.outcome !== 'complete' || !timing.queries) return null;
  if (timing.queries.identity.cached && timing.queries.overview.cached) return 'visites servies par le cache PostHog';
  return timing.elapsedMs == null ? null : `visites lues en ${durationText(timing.elapsedMs)}`;
}

export function VisualJourneyView({ report }: { report: VisualJourneyReport }) {
  const stages = order.map((id, index): VisualJourneyStage => report.stages.find(stage => stage.id === id) ?? { id, label: stageLabels[id], count: null, availability: { available: false, reason: 'Mesure indisponible dans cette lecture.' }, fromPrevious: index === 0 ? null : { available: false, reason: 'Taux indisponible dans cette lecture.', numerator: null, denominator: null, rate: null } });
  const [selected, setSelected] = useState<VisualJourneyStageId>('page');
  const selectedStage = stages.some(stage => stage.id === selected) ? selected : 'page';
  const nestedReasons = [
    report.page.visitors, report.page.cta, ...report.page.sections.map(section => section.visitors), ...report.page.ctaPlacements.map(placement => placement.visitors),
    report.form.opened, report.form.started, report.form.registered, report.form.rates.startedFromOpened, report.form.rates.registeredFromStarted,
    report.video.durationAvailability, report.video.started, report.video.finished, ...report.video.thresholds.map(row => row.fromStarted),
    report.booking.clicked, report.booking.calendar, report.booking.booked, report.booking.rates.calendarFromClicked, report.booking.rates.bookedFromCalendar,
  ].map(item => item.reason).filter((value): value is string => Boolean(value));
  const timingText = visitsTiming(report);
  const reasons = [...new Set([...report.limits, ...report.stages.flatMap(stage => [stage.availability.reason, stage.fromPrevious?.reason]).filter((value): value is string => Boolean(value)), ...nestedReasons])];
  return <div className="visual-journey">
    <ol className="journey-route a-d-stage" aria-label="Du visiteur au rendez-vous">{stages.map((stage, index) => <li className="journey-route-fragment" key={stage.id}>{index > 0 && <div className="journey-edge" aria-label={rateDescription(stage.fromPrevious)} title={rateDescription(stage.fromPrevious)}><Icon name="arrow" /><b>{rateText(stage.fromPrevious)}</b><span className="blg-sr-only">{rateDescription(stage.fromPrevious)}</span></div>}<button type="button" className="journey-stop" data-step={stage.id} aria-pressed={selectedStage === stage.id} onClick={() => setSelected(stage.id)} aria-label={`${stage.label} : ${stage.availability.available ? formatNumber(stage.count) : 'indisponible'}. Voir le détail.`}><span className={`journey-node a-h-marker${selectedStage === stage.id ? ' a-luminous-marker' : ''}`}><Icon name={stage.id} /></span><strong title={stage.availability.reason ?? undefined}>{stage.availability.available ? formatNumber(stage.count) : '—'}</strong><span className="journey-stop-label">{stage.label}</span></button></li>)}</ol>
    <section className="journey-detail a-d-stage" aria-live="polite" aria-atomic="false">{selectedStage === 'page' ? <PageDetail report={report} /> : selectedStage === 'form' || selectedStage === 'signup' ? <FormDetail report={report} /> : selectedStage === 'watch' ? <VideoDetail report={report} /> : <BookingDetail report={report} />}<Freshness report={report} /></section>
    <div className="journey-meta"><span>Dernière lecture : {formatDate(report.generatedAt, true)}{timingText && ` · ${timingText}`}</span>{reasons.length > 0 && <details><summary>À savoir sur ces chiffres</summary>{reasons.map(reason => <p key={reason}>{reason}</p>)}</details>}</div>
  </div>;
}
