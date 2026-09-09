'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CommercialAttendance, CommercialPageProps, CommercialRecord } from '../lib/commercial-contract';
import { filterCommercialDashboard } from '../lib/commercial-filter';

const PARIS = 'Europe/Paris';
const longDate = new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, weekday: 'long', day: 'numeric', month: 'long' });
const dateTime = new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const dayOnly = new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, day: 'numeric', month: 'short', year: 'numeric' });

const attendanceCopy: Record<CommercialAttendance, string> = {
  present: 'Présent', absent: 'Absent', planned: 'Prévu', cancelled: 'Annulé', rescheduled: 'Reporté', unknown: 'À confirmer',
};
const formatDate = (value: string | null, withTime = true) => {
  if (!value) return 'Non renseignée';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return dayOnly.format(date);
  return (withTime ? dateTime : dayOnly).format(date);
};
export const formatAppointment = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)
  ? `${formatDate(value, false)} · Horaire non renseigné`
  : formatDate(value);
const formatSummary = (value: number | null) => value === null ? '—' : String(value);

function CommercialDialog({ record, onClose }: { record: CommercialRecord; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null); const titleId = useId();
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.showModal();
    return () => { dialog?.close(); if (opener?.isConnected) opener.focus(); };
  }, []);
  return <dialog ref={ref} className="a-r-dialog commercial-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === ref.current) onClose(); }}>
    <header className="a-r-dialog-head"><div><span className="commercial-eyebrow">FICHE COMMERCIALE</span><h2 id={titleId}>{record.name}</h2></div><button className="a-button a-secondary commercial-close" onClick={onClose} aria-label="Fermer la fiche">Fermer</button></header>
    <div className="a-r-dialog-body commercial-dialog-body">
      <dl className="commercial-facts">
        <div><dt>Rendez-vous</dt><dd>{formatAppointment(record.appointment.scheduledAt)} · {attendanceCopy[record.appointment.attendance]}</dd></div>
        <div><dt>Origine</dt><dd>{record.origin}</dd></div>
        <div><dt>Point d’entrée</dt><dd>{record.tunnel ?? 'Non renseigné'}</dd></div>
        <div><dt>Responsable</dt><dd>{record.owner ?? 'Non renseigné'}</dd></div>
        <div><dt>Statut commercial</dt><dd>{record.commercialStatus}</dd></div>
        <div><dt>Issue de closing</dt><dd>{record.closingOutcome ?? 'Non renseignée'}</dd></div>
        <div><dt>Prochaine action</dt><dd>{formatDate(record.nextActionAt)}</dd></div>
      </dl>
      <section className="commercial-history" aria-label="Historique enregistré"><div className="commercial-section-heading"><span className="commercial-eyebrow">HISTORIQUE ENREGISTRÉ</span><h3>Ce qui s’est passé</h3></div>
        {record.history.length ? <ol>{record.history.map(item => <li key={item.id}><time dateTime={item.at ?? undefined}>{formatDate(item.at)}</time><div><strong>{item.label}</strong>{item.value && <span>{item.value}</span>}</div></li>)}</ol> : <div className="a-r-notice"><span className="a-r-notice-icon" aria-hidden="true">i</span><div className="a-r-notice-copy"><strong>Aucun historique enregistré</strong><p>Cette fiche ne reconstitue pas d’événements à partir de sa dernière mise à jour.</p></div></div>}
      </section>
    </div>
  </dialog>;
}

export default function CommercialPage({ data, loading = false, onDateChange, onRetry }: CommercialPageProps) {
  const [origin, setOrigin] = useState('all'); const [selected, setSelected] = useState<CommercialRecord | null>(null);
  useEffect(() => { setOrigin('all'); setSelected(null); }, [data.day]);
  const filtered = useMemo(() => filterCommercialDashboard(data, origin), [data, origin]);
  const origins = useMemo(() => [...new Set(data.records.map(record => record.origin))].sort((left, right) => left.localeCompare(right, 'fr')), [data.records]);
  function moveDay(offset: number) { const day = new Date(`${data.day}T12:00:00Z`); day.setUTCDate(day.getUTCDate() + offset); onDateChange(day.toISOString().slice(0,10)); }
  const isDemo = data.mode === 'demo';
  return <section className="commercial-page" aria-label="Suivi commercial de la journée">
    <div className="commercial-toolbar"><button type="button" className="a-button a-secondary" onClick={() => moveDay(-1)} aria-label="Journée précédente">‹</button><label className="a-f-field" data-emphasis="quiet"><span>Journée</span><span className="a-field-shell"><input type="date" value={data.day} onInput={event => { if (event.currentTarget.validity.valid && event.currentTarget.value) onDateChange(event.currentTarget.value); }} aria-label="Journée commerciale" /></span></label><button type="button" className="a-button a-secondary" onClick={() => moveDay(1)} aria-label="Journée suivante">›</button><span className="commercial-day">{longDate.format(new Date(`${data.day}T12:00:00Z`))}</span><label className="a-f-field commercial-origin-filter" data-emphasis="quiet"><span>Origine</span><span className="a-field-shell"><select value={origin} onChange={event => setOrigin(event.target.value)} aria-label="Filtrer par origine"><option value="all">Toutes les origines</option>{origins.map(value => <option key={value} value={value}>{value}</option>)}</select></span></label></div>
    {!isDemo && data.updatedAt && <p className="commercial-freshness">D’après les données importées le {formatDate(data.updatedAt)}. Les changements intervenus depuis peuvent manquer.</p>}
    {isDemo && <div className="a-r-notice commercial-demo"><span className="a-r-notice-icon" aria-hidden="true">D</span><div className="a-r-notice-copy"><strong>Données de démonstration</strong><p>Les rendez-vous et fiches de cette vue sont fictifs.</p></div></div>}
    {data.notice && <div className="a-r-notice"><span className="a-r-notice-icon" aria-hidden="true">i</span><div className="a-r-notice-copy"><strong>Couverture à compléter</strong><p>{data.notice}</p></div>{onRetry && <button className="a-button a-secondary" onClick={onRetry}>Réessayer</button>}</div>}
    <section className="a-d-stage commercial-summary" aria-label="Chiffres de la journée"><div className="a-d-cards">
      <article className="a-d-card"><h3>Rendez-vous</h3><div className="a-d-value">{formatSummary(filtered.summary.appointments)}</div><p>{filtered.summary.appointments === null ? 'Collection non couverte' : 'Rendez-vous datés ce jour'}</p></article>
      <article className="a-d-card"><h3>Présences</h3><div className="a-d-value">{formatSummary(filtered.summary.present)}</div><p>{filtered.summary.present === null ? 'Collection non couverte' : 'Statut « présent » enregistré'}</p></article>
      <article className="a-d-card"><h3>Personnes avec rendez-vous</h3><div className="a-d-value">{formatSummary(filtered.summary.distinctProspects)}</div><p>{filtered.summary.distinctProspects === null ? 'Collection non couverte' : 'Prospects distincts du jour'}</p></article>
    </div></section>
    <section className="a-d-stage commercial-table-section"><div className="commercial-table-heading"><div><span className="commercial-eyebrow">RENDEZ-VOUS DU JOUR</span><h2>{filtered.records.length} rendez-vous affiché{filtered.records.length !== 1 ? 's' : ''}</h2></div><span>{loading ? 'Actualisation…' : `Dernier import : ${formatDate(data.updatedAt)}`}</span></div>
      {filtered.records.length ? <div className="commercial-table-scroll" tabIndex={0} role="region" aria-label="Liste des rendez-vous"><table className="a-t-table commercial-table"><thead><tr><th>Personne</th><th>Horaire</th><th>Présence</th><th>Origine</th><th>Statut</th><th>Closing</th></tr></thead><tbody>{filtered.records.map(record => <tr key={record.id}><td><button className="a-button a-n-quiet commercial-person" onClick={() => setSelected(record)}>{record.name}<span aria-hidden="true">›</span></button>{record.owner && <small>{record.owner}</small>}</td><td>{formatAppointment(record.appointment.scheduledAt)}</td><td>{attendanceCopy[record.appointment.attendance]}</td><td>{record.origin}</td><td>{record.commercialStatus}</td><td>{record.closingOutcome ?? 'Non renseignée'}</td></tr>)}</tbody></table></div> : <div className="commercial-empty"><span className="commercial-empty-symbol" aria-hidden="true">—</span><h3>{data.summary.appointments === null ? 'Rendez-vous indisponibles' : origin === 'all' ? 'Aucun rendez-vous pour cette journée' : 'Aucun rendez-vous pour cette origine'}</h3><p>{data.summary.appointments === null ? 'La couverture de cette journée n’est pas encore établie.' : 'Les compteurs et la liste utilisent le même filtre.'}</p></div>}
      <footer className="commercial-coverage">{data.coverage}</footer>
    </section>
    {selected && <CommercialDialog record={selected} onClose={() => setSelected(null)} />}
  </section>;
}
