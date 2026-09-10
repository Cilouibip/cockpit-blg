'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { CommercialAttendance, CommercialFollowUp, CommercialPageProps, CommercialQuery, CommercialRecord } from '../lib/commercial-contract';

const PARIS = 'Europe/Paris';
const dateTime = new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const dayOnly = new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, day: 'numeric', month: 'short', year: 'numeric' });
const attendanceCopy: Record<CommercialAttendance, string> = { present: 'Présent', absent: 'Absent', planned: 'Prévu', cancelled: 'Annulé', rescheduled: 'Reporté', unknown: 'À confirmer' };
const followUpCopy: Record<CommercialFollowUp, string> = { all: 'Toutes', overdue: 'En retard', today: 'Aujourd’hui', upcoming: 'À venir' };
const formatDate = (value: string | null, withTime = true) => { if (!value) return 'Non renseignée'; const date = new Date(value); if (Number.isNaN(date.getTime())) return value; return /^\d{4}-\d{2}-\d{2}$/.test(value) ? dayOnly.format(date) : (withTime ? dateTime : dayOnly).format(date); };
export const formatAppointment = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${formatDate(value, false)} · Horaire non renseigné` : formatDate(value);
const formatSummary = (value: number | null) => value === null ? '—' : String(value);
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: PARIS, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addDays = (day: string, amount: number) => { const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + amount); return date.toISOString().slice(0, 10); };

function CommercialDialog({ record, onClose }: { record: CommercialRecord; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null), titleId = useId();
  useEffect(() => { const opener = document.activeElement as HTMLElement | null, dialog = ref.current; dialog?.showModal(); return () => { dialog?.close(); if (opener?.isConnected) opener.focus(); }; }, []);
  const appointment = record.appointment;
  return <dialog ref={ref} className="a-r-dialog commercial-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === ref.current) onClose(); }}>
    <header className="a-r-dialog-head"><div><span className="commercial-eyebrow">FICHE COMMERCIALE</span><h2 id={titleId}>{record.name}</h2></div><button className="a-button a-secondary commercial-close" onClick={onClose}>Fermer</button></header>
    <div className="a-r-dialog-body commercial-dialog-body"><dl className="commercial-facts">
      <div><dt>Statut commercial actuel</dt><dd>{record.commercialStatus}</dd></div><div><dt>Rendez-vous de la période</dt><dd>{appointment ? `${formatAppointment(appointment.scheduledAt)} · ${attendanceCopy[appointment.attendance]}` : 'Aucun rendez-vous dans cette période'}</dd></div>
      <div><dt>Origine</dt><dd>{record.origin}</dd></div><div><dt>Point d’entrée</dt><dd>{record.tunnel ?? 'Non renseigné'}</dd></div><div><dt>Responsable</dt><dd>{record.owner ?? 'Non renseigné'}</dd></div>
      <div><dt>Closing enregistré</dt><dd>{record.closingAt ? `Daté du ${formatDate(record.closingAt, false)}` : record.closingOutcome ?? 'Non renseigné'}</dd></div><div><dt>Prochaine action enregistrée</dt><dd>{formatDate(record.nextActionAt)}</dd></div>
    </dl><section className="commercial-history" aria-label="Historique enregistré"><div className="commercial-section-heading"><span className="commercial-eyebrow">HISTORIQUE ENREGISTRÉ</span><h3>Ce qui s’est passé</h3></div>
      {record.history.length ? <ol>{record.history.map(item => <li key={item.id}><time dateTime={item.at ?? undefined}>{formatDate(item.at)}</time><div><strong>{item.label}</strong>{item.value && <span>{item.value}</span>}</div></li>)}</ol> : <div className="a-r-notice"><span className="a-r-notice-icon" aria-hidden="true">i</span><div className="a-r-notice-copy"><strong>Aucun historique enregistré</strong><p>La fiche ne transforme pas son statut actuel en événement passé.</p></div></div>}
    </section></div></dialog>;
}

type SelectOption = { value: string; label: string };

/** Exact A.18.1 select structure: trigger, menu and options stay in the kit. */
function CommercialSelect({ value, options, onChange, labelledBy }: { value: string; options: SelectOption[]; onChange: (value: string) => void; labelledBy: string }) {
  const ref = useRef<HTMLDivElement>(null), menuId = useId();
  const [open, setOpen] = useState(false);
  const selected = options.find(option => option.value === value) ?? options[0];
  useEffect(() => { if (open) ref.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.focus(); }, [open]);
  useEffect(() => {
    const close = (event: PointerEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  const move = (event: KeyboardEvent<HTMLElement>, offset: number) => {
    event.preventDefault();
    if (!open) { setOpen(true); return; }
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    const currentIndex = items.indexOf(event.currentTarget);
    const index = currentIndex >= 0 ? currentIndex : Math.max(0, items.findIndex(item => item.getAttribute('aria-selected') === 'true'));
    items[(index + offset + items.length) % items.length]?.focus();
  };
  const choose = (next: string) => { onChange(next); setOpen(false); ref.current?.querySelector<HTMLButtonElement>('.a-f-select-trigger')?.focus(); };
  return <div ref={ref} className="a-f-select-wrap" data-open={open}>
    <button className="a-f-select-trigger" type="button" aria-labelledby={labelledBy} aria-haspopup="listbox" aria-controls={menuId} aria-expanded={open} onClick={() => setOpen(current => !current)} onKeyDown={event => {
      if (event.key === 'ArrowDown') move(event, 1);
      if (event.key === 'ArrowUp') move(event, -1);
      if (event.key === 'Escape') setOpen(false);
    }}><span className="a-f-select-value">{selected?.label ?? 'Choisir'}</span><span className="a-f-select-chevron" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m7 10 5 5 5-5" /></svg></span></button>
    {open && <ul id={menuId} className="a-f-select-menu" role="listbox" aria-labelledby={labelledBy}>{options.map(option => <li key={option.value} className="a-f-select-option" role="option" aria-selected={option.value === value} tabIndex={-1} onClick={() => choose(option.value)} onKeyDown={event => {
      if (event.key === 'ArrowDown') move(event, 1);
      else if (event.key === 'ArrowUp') move(event, -1);
      else if (event.key === 'Escape') { event.preventDefault(); setOpen(false); ref.current?.querySelector<HTMLButtonElement>('.a-f-select-trigger')?.focus(); }
      else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(option.value); }
    }}><span>{option.label}</span><span className="a-f-select-check" aria-hidden="true">✓</span></li>)}</ul>}
  </div>;
}

function SelectField({ label, value, options, onChange }: { label: string; value: string; options: SelectOption[]; onChange: (value: string) => void }) {
  const labelId = useId();
  return <div className="a-field a-f-field" data-emphasis="quiet"><label id={labelId}>{label}</label><div className="a-field-shell"><CommercialSelect value={value} options={options} onChange={onChange} labelledBy={labelId} /></div></div>;
}

function DatePresets({ draft, onChange }: { draft: CommercialQuery; onChange: (next: Partial<CommercialQuery>) => void }) {
  const current = today();
  const inferred = draft.from === current && draft.to === current ? 'today' : draft.from === addDays(current, -6) && draft.to === current ? 'week' : draft.from === current.slice(0, 8) + '01' && draft.to === current ? 'month' : !draft.from && !draft.to ? 'all' : 'custom';
  const [preset, setPreset] = useState(inferred);
  const fromId = useId(), toId = useId();
  useEffect(() => setPreset(inferred), [inferred]);
  const choose = (value: string) => { setPreset(value); if (value === 'today') onChange({ from: current, to: current }); else if (value === 'week') onChange({ from: addDays(current, -6), to: current }); else if (value === 'month') onChange({ from: current.slice(0, 8) + '01', to: current }); else if (value === 'all') onChange({ from: null, to: null }); };
  return <><SelectField label="Période" value={preset} onChange={choose} options={[{ value: 'today', label: 'Aujourd’hui' }, { value: 'week', label: '7 derniers jours' }, { value: 'month', label: 'Ce mois' }, { value: 'custom', label: 'Période personnalisée' }, { value: 'all', label: 'Tout l’historique utile' }]} />
  <div className="a-field a-f-field" data-emphasis="quiet"><label htmlFor={fromId}>Du</label><div className="a-field-shell"><input id={fromId} type="date" value={draft.from ?? ''} onInput={event => { setPreset('custom'); onChange({ from: event.currentTarget.value || null }); }} /></div></div><div className="a-field a-f-field" data-emphasis="quiet"><label htmlFor={toId}>Au</label><div className="a-field-shell"><input id={toId} type="date" value={draft.to ?? ''} onInput={event => { setPreset('custom'); onChange({ to: event.currentTarget.value || null }); }} /></div></div></>;
}

export default function CommercialPage({ data, loading = false, onQueryChange, onRetry }: CommercialPageProps) {
  const [draft, setDraft] = useState(data.query), [selected, setSelected] = useState<CommercialRecord | null>(null), [periodError, setPeriodError] = useState('');
  useEffect(() => { setDraft(data.query); setSelected(null); }, [data.query]);
  const change = (next: Partial<CommercialQuery>) => { setDraft(current => ({ ...current, ...next })); setPeriodError(''); };
  const apply = () => { if ((draft.from === null) !== (draft.to === null) || (draft.from && draft.to && draft.from > draft.to)) { setPeriodError('Choisis une date de début et de fin cohérentes avant d’appliquer.'); return; } onQueryChange({ ...draft, page: 0 }); };
  const reset = () => { const base = data.query; setDraft({ ...base, search: '', origin: 'all', status: 'all', attendance: 'all', owner: 'all', nextAction: 'all', followUp: 'all' }); onQueryChange({ search: '', origin: 'all', status: 'all', attendance: 'all', owner: 'all', nextAction: 'all', followUp: 'all', page: 0 }); };
  const title = data.view === 'appointments' ? 'Rendez-vous' : data.view === 'followups' ? 'Relances prévues' : 'Tous les prospects';
  const empty = data.view === 'appointments' ? 'Aucun rendez-vous pour cette période' : data.view === 'followups' ? 'Aucune relance datée pour ces filtres' : 'Aucun prospect pour ces filtres';
  const attendanceOptions = [{ value: 'all', label: 'Toutes' }, ...(Object.keys(attendanceCopy) as CommercialAttendance[]).map(value => ({ value, label: attendanceCopy[value] }))];
  return <section className="commercial-page" aria-label="Suivi commercial">
    <fieldset className="commercial-controls" disabled={loading}><div className="commercial-toolbar"><div className="a-n-tabbar commercial-tabs" role="tablist" aria-label="Vue commerciale"><button className="a-n-tab" aria-selected={data.view === 'appointments'} role="tab" onClick={() => onQueryChange({ view: 'appointments', nextAction: 'all', followUp: 'all', page: 0 })}>Rendez-vous</button><button className="a-n-tab" aria-selected={data.view === 'followups'} role="tab" onClick={() => onQueryChange({ view: 'followups', nextAction: 'recorded', followUp: 'all', attendance: 'all', page: 0 })}>Relances prévues</button><button className="a-n-tab" aria-selected={data.view === 'prospects'} role="tab" onClick={() => onQueryChange({ view: 'prospects', nextAction: 'all', followUp: 'all', page: 0 })}>Tous les prospects</button></div>{data.view === 'appointments' ? <DatePresets draft={draft} onChange={change} /> : <p className="commercial-register-note">{data.view === 'followups' ? 'Cette vue reprend uniquement les prochaines actions avec une date enregistrée.' : 'Le registre garde toute la liste. Les dates de rendez-vous restent prêtes si tu reviens à cette vue.'}</p>}<button className="a-button a-primary" type="button" onClick={apply} disabled={loading} aria-busy={loading}>Appliquer</button></div>
    {periodError && <p className="commercial-inline-error" role="alert">{periodError}</p>}
    {data.view === 'followups' && <div className="a-n-tabbar commercial-due-tabs" role="tablist" aria-label="Échéance des relances">{(Object.keys(followUpCopy) as CommercialFollowUp[]).map(value => <button key={value} className="a-n-tab" role="tab" aria-selected={draft.followUp === value} onClick={() => { change({ followUp: value, page: 0 }); onQueryChange({ followUp: value, page: 0 }); }}>{followUpCopy[value]} <span className="commercial-due-count">{value === 'all' ? data.summary.followUps ? data.summary.followUps.overdue + data.summary.followUps.today + data.summary.followUps.upcoming : '—' : data.summary.followUps?.[value] ?? '—'}</span></button>)}</div>}
    <div className="commercial-filters"><div className="a-field a-f-field commercial-search" data-emphasis="quiet"><label htmlFor="commercial-search">Recherche</label><div className="a-field-shell"><input id="commercial-search" value={draft.search} onChange={event => change({ search: event.target.value })} placeholder="Nom, origine, statut ou responsable" maxLength={100} /></div></div><SelectField label="Origine" value={draft.origin} onChange={origin => change({ origin })} options={[{ value: 'all', label: 'Toutes' }, ...data.filters.origins.map(value => ({ value, label: value }))]} /><SelectField label="Statut" value={draft.status} onChange={status => change({ status })} options={[{ value: 'all', label: 'Tous' }, ...data.filters.statuses.map(value => ({ value, label: value }))]} />{data.view !== 'followups' && <SelectField label="Présence" value={draft.attendance} onChange={attendance => change({ attendance: attendance as CommercialQuery['attendance'] })} options={attendanceOptions} />}<SelectField label="Responsable" value={draft.owner} onChange={owner => change({ owner })} options={[{ value: 'all', label: 'Tous' }, ...data.filters.owners.map(value => ({ value, label: value }))]} />{data.view === 'prospects' && <SelectField label="Prochaine action" value={draft.nextAction} onChange={nextAction => change({ nextAction: nextAction as CommercialQuery['nextAction'] })} options={[{ value: 'all', label: 'Toutes' }, { value: 'recorded', label: 'Date enregistrée' }, { value: 'missing', label: 'Sans date' }]} />}<button className="a-button a-secondary commercial-reset" type="button" onClick={reset}>Réinitialiser</button></div>
    </fieldset>
    {data.updatedAt && <p className="commercial-freshness">Dernière lecture importée : {formatDate(data.updatedAt)}.</p>}{data.notice && <p className="commercial-inline-error">{data.notice}{onRetry && <button className="a-button a-n-quiet" onClick={onRetry}>Réessayer</button>}</p>}
    {data.view === 'appointments' && <section className="a-d-stage commercial-summary"><div className="a-d-cards"><article className="a-d-card"><span>Rendez-vous</span><strong className="a-d-value">{formatSummary(data.summary.appointments)}</strong><p>Dans la période sélectionnée</p></article><article className="a-d-card"><span>Présents</span><strong className="a-d-value">{formatSummary(data.summary.present)}</strong><p>Présences enregistrées</p></article><article className="a-d-card"><span>Personnes</span><strong className="a-d-value">{formatSummary(data.summary.distinctProspects)}</strong><p>Personnes distinctes</p></article></div></section>}{data.view === 'followups' && <section className="a-d-stage commercial-summary"><div className="a-d-cards"><article className="a-d-card"><span>En retard</span><strong className="a-d-value">{formatSummary(data.summary.followUps?.overdue ?? null)}</strong><p>Dates enregistrées avant aujourd’hui</p></article><article className="a-d-card"><span>Aujourd’hui</span><strong className="a-d-value">{formatSummary(data.summary.followUps?.today ?? null)}</strong><p>Dates enregistrées aujourd’hui</p></article><article className="a-d-card"><span>À venir</span><strong className="a-d-value">{formatSummary(data.summary.followUps?.upcoming ?? null)}</strong><p>Dates enregistrées après aujourd’hui</p></article></div></section>}
    <section className="a-d-stage commercial-table-section"><div className="commercial-table-heading"><div><span className="commercial-eyebrow">{data.view === 'appointments' ? 'PÉRIODE RENDEZ-VOUS' : 'REGISTRE COURANT'}</span><h2>{title}</h2></div><span>{data.pagination.total} résultat{data.pagination.total !== 1 ? 's' : ''} · page {data.pagination.page + 1}</span></div>
      {data.records.length ? <div className="a-t-table-wrap commercial-table-scroll" tabIndex={0} role="region" aria-label={title}><table className="a-t-table commercial-table">{data.view === 'followups' ? <><thead><tr><th>Personne</th><th>Prochaine action</th><th>Origine</th><th>Statut actuel</th><th>Responsable</th></tr></thead><tbody>{data.records.map(record => <tr className="a-t-row" key={record.id}><td><button className="a-t-name commercial-person" onClick={() => setSelected(record)}>{record.name}<span aria-hidden="true"> ›</span></button></td><td><strong>{formatDate(record.nextActionAt, false)}</strong></td><td>{record.origin}</td><td><span className="a-t-badge">{record.commercialStatus}</span></td><td>{record.owner ?? 'Non renseigné'}</td></tr>)}</tbody></> : <><thead><tr><th>Personne</th><th>Rendez-vous</th><th>Présence</th><th>Origine</th><th>Statut actuel</th><th>Action enregistrée</th></tr></thead><tbody>{data.records.map(record => <tr className="a-t-row" key={record.id}><td><button className="a-t-name commercial-person" onClick={() => setSelected(record)}>{record.name}<span aria-hidden="true"> ›</span></button>{record.owner && <small className="a-t-context">{record.owner}</small>}</td><td>{record.appointment ? formatAppointment(record.appointment.scheduledAt) : '—'}</td><td>{record.appointment ? <span className="a-t-badge">{attendanceCopy[record.appointment.attendance]}</span> : '—'}</td><td>{record.origin}</td><td><span className="a-t-badge">{record.commercialStatus}</span>{record.closingAt && <small className="a-t-context">Closing daté le {formatDate(record.closingAt, false)}</small>}</td><td>{formatDate(record.nextActionAt, false)}</td></tr>)}</tbody></>}</table></div> : <div className="a-r-surface commercial-empty"><span className="a-r-state-symbol" aria-hidden="true">—</span><h3>{empty}</h3><p>{data.view === 'appointments' ? 'Choisis une période plus large ou ouvre le registre complet.' : data.view === 'followups' ? 'Aucune prochaine action avec une date enregistrée ne correspond à cette vue.' : 'Réinitialise les filtres pour parcourir le registre.'}</p>{data.view === 'appointments' && <div className="commercial-empty-actions"><button className="a-button a-secondary" type="button" onClick={() => onQueryChange({ view: 'prospects', page: 0 })}>Voir tous les prospects</button><button className="a-button a-secondary" type="button" onClick={() => onQueryChange({ from: null, to: null, page: 0 })}>Élargir la période</button></div>}</div>}
      {data.pagination.total > data.pagination.pageSize && <nav className="commercial-pagination" aria-label="Pagination commerciale"><button className="a-button a-secondary" disabled={loading || data.pagination.page === 0} onClick={() => onQueryChange({ page: data.pagination.page - 1 })}>Précédent</button><span>{data.pagination.page * data.pagination.pageSize + 1}–{Math.min((data.pagination.page + 1) * data.pagination.pageSize, data.pagination.total)} sur {data.pagination.total}</span><button className="a-button a-secondary" disabled={loading || (data.pagination.page + 1) * data.pagination.pageSize >= data.pagination.total} onClick={() => onQueryChange({ page: data.pagination.page + 1 })}>Suivant</button></nav>}
      <footer className="commercial-coverage">{data.coverage}</footer></section>{selected && <CommercialDialog record={selected} onClose={() => setSelected(null)} />}
  </section>;
}
