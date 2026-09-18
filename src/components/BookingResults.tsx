'use client';

import { useEffect, useState } from 'react';
import type { DashboardFilters } from '../lib/ui-contract';
import type { BookingResultsReport } from '../lib/booking-results';
import { filtersQuery, formatDate, formatNumber } from './ui-format';

type View = 'reserved' | 'attended';
const outcomeLabels = { scheduled: 'Prévu', attended: 'Réalisé', no_show: 'Absent', cancelled: 'Annulé', rescheduled: 'Reporté', unknown: 'Réservation enregistrée' };
const date = (at: string | null, day: string | null) => at ? formatDate(at, true) : day ? formatDate(day) : 'date non renseignée';
const money = (minor: number | null) => formatNumber(minor === null ? null : minor / 100, 'eur');

export function BookingResultsDetail({ report, initialView = 'reserved' }: { report: BookingResultsReport; initialView?: View }) {
  const [view, setView] = useState<View>(initialView);
  const [limit, setLimit] = useState(20);
  const rows = report.rows.filter(row => view === 'reserved' ? row.reservedInPeriod : row.scheduledInPeriod && row.outcome === 'attended');
  const costs = report.cost.byAds.filter(row => row.eligibleAttributedBookings > 0);
  return <div className="booking-results">
    <p className="results-drawer-period">Du {formatDate(report.period.from)} au {formatDate(report.period.to)}</p>
    <div className="a-t-views booking-views" aria-label="Rendez-vous affichés">{(['reserved', 'attended'] as const).map(key => <button type="button" className="a-t-view" key={key} aria-pressed={view === key} onClick={() => { setView(key); setLimit(20); }}>{key === 'reserved' ? 'Réservés' : 'Réalisés'} <strong>{formatNumber(key === 'reserved' ? report.summary.booked : report.summary.attended)}</strong></button>)}</div>
    <p className="booking-period-help">{view === 'reserved' ? 'Réservations prises sur cette période, même si le rendez-vous a lieu plus tard.' : 'Rendez-vous qui ont eu lieu sur cette période.'}</p>
    {view === 'reserved' && <div className="booking-cost"><span>Coût publicitaire moyen par réservation</span><strong>{money(report.cost.averagePerBookingMinor)}</strong>{report.cost.averagePerBookingMinor !== null ? <small>{money(report.cost.spendMinor)} dépensés · {formatNumber(report.cost.eligibleAttributedBookings)} réservations attribuées aux publicités</small> : <small>{report.cost.reason ?? 'Pas encore calculable pour cette sélection.'}</small>}{costs.length > 0 && <details><summary>Par publicité</summary><ul>{costs.map(cost => <li key={cost.attributionKey}><span>{cost.label}</span><b>{money(cost.averagePerBookingMinor)}</b></li>)}</ul></details>}</div>}
    {!report.coverage.available && <p className="results-state">Mise à jour des rendez-vous en attente. Les réservations déjà connues restent affichées.</p>}
    {rows.length ? <><ul className="booking-results-list">{rows.slice(0,limit).map(row => <li key={row.id}><div className="booking-results-person"><strong>{row.displayName}</strong><span>{outcomeLabels[row.outcome]}</span></div><p>{row.source === 'unknown' ? 'Origine non renseignée' : row.source === 'organic' ? 'Hors publicité' : row.attributionLabel}</p><div className="booking-results-dates"><span>Réservé le <b>{date(row.bookingAt,row.bookingDay)}</b></span><span>Rendez-vous le <b>{date(row.scheduledAt,row.scheduledDay)}</b></span></div></li>)}</ul>{rows.length > limit && <button type="button" className="a-button a-secondary" onClick={() => setLimit(limit + 20)}>Voir les suivants ({rows.length - limit})</button>}</> : <p>{report.coverage.available ? 'Aucun rendez-vous dans cette sélection.' : 'La liste des rendez-vous n’est pas encore disponible.'}</p>}
    {report.coverage.observedAt && <p className="results-source">Mis à jour le {formatDate(report.coverage.observedAt, true)}</p>}
  </div>;
}

export default function BookingResults({ filters, initialView }: { filters: DashboardFilters; initialView?: View }) {
  const query = filtersQuery(filters);
  const [loaded, setLoaded] = useState<{ query: string; report: BookingResultsReport } | null>(null);
  const [failure, setFailure] = useState<{ query: string; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setFailure(null);
    fetch(`/api/booking-results?${query}&includeTests=false`, { signal: controller.signal, credentials: 'same-origin', cache: 'no-store' })
      .then(async response => { if (!response.ok) throw new Error('Les rendez-vous n’ont pas pu être chargés.'); return response.json() as Promise<BookingResultsReport>; })
      .then(report => { if (!controller.signal.aborted) setLoaded({ query, report }); })
      .catch(error => { if (!controller.signal.aborted) setFailure({ query, message: error.message }); });
    return () => controller.abort();
  }, [query, attempt]);
  if (failure?.query === query) return <div role="alert"><p>{failure.message}</p><button type="button" className="a-button a-secondary" onClick={() => { setLoaded(null); setAttempt(attempt + 1); }}>Réessayer</button></div>;
  if (loaded?.query !== query) return <p role="status">Chargement des rendez-vous…</p>;
  return <BookingResultsDetail key={query} report={loaded.report} initialView={initialView} />;
}
