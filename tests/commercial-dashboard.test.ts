import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCommercialDashboard, buildCommercialDay, defaultCommercialQuery, filterCommercialDashboard, invalidateCommercialSnapshot, loadCommercialDashboard, loadCommercialDay, parisAppointmentDay } from '../src/lib/commercial-dashboard';
import { serializeCommercialQuery } from '../src/lib/commercial-query';
import type { Database, Row } from '../src/lib/db';
import { formatAppointment } from '../src/components/CommercialPage';

const prospect = (overrides: Row = {}): Row => ({ id: 'p-1', display_name: 'Ada', source_status: 'RDV fait', outcome: null, owner_label: 'Mehdi', ...overrides });
const appointment = (overrides: Row = {}): Row => ({ id: 'a-1', prospect_id: 'p-1', scheduled_at: '2026-09-09T08:30:00.000Z', status: 'scheduled', source_status: 'Prévu', ...overrides });
const dashboard = (overrides: Partial<Parameters<typeof buildCommercialDay>[0]> = {}) => buildCommercialDay({ mode: 'demo', day: '2026-09-09', prospects: [prospect()], appointments: [appointment()], commercialHistory: [], ...overrides });

test('uses the Paris calendar day around midnight', () => {
  assert.equal(parisAppointmentDay(appointment({ scheduled_at: '2026-09-08T21:59:00.000Z' })), '2026-09-08');
  assert.equal(parisAppointmentDay(appointment({ scheduled_at: '2026-09-08T22:00:00.000Z' })), '2026-09-09');
});

test('a date-only scheduled day never gains an invented hour in the interface', () => {
  assert.match(formatAppointment('2026-09-09'), /Horaire non renseigné/);
  assert.doesNotMatch(formatAppointment('2026-09-09'), /02:00/);
});

test('deduplicates appointments before daily counters, beyond a 50-row page', () => {
  const appointments = Array.from({ length: 53 }, (_, index) => appointment({ id: `a-${index}`, prospect_id: `p-${index}`, scheduled_at: '2026-09-09T09:00:00.000Z' }));
  const prospects = appointments.map((row, index) => prospect({ id: `p-${index}`, display_name: `Personne ${index}`, business: { scheduledDay: '2026-09-09', attendance: 'scheduled', channels: [], tunnels: [] } }));
  const result = dashboard({ prospects, appointments: [...appointments, appointments[0]], businessSnapshotPublished: true });
  assert.equal(result.summary.appointments, 53);
  assert.equal(result.records.length, 50);
  assert.equal(result.pagination.total, 53);
});

test('attendance is distinct from a commercial outcome', () => {
  const result = dashboard({ prospects: [prospect({ outcome: 'Vendu', business: { scheduledDay: '2026-09-09', attendance: 'no_show', channels: [], tunnels: [] } })], appointments: [appointment({ status: 'no_show' })], businessSnapshotPublished: true });
  assert.equal(result.summary.present, 0);
  assert.equal(result.records[0].appointment?.attendance, 'absent');
  assert.equal(result.records[0].closingOutcome, 'Vendu');
});

test('does not reinvent an old client as a fresh closing', () => {
  const result = dashboard({ prospects: [prospect({ source_status: 'Ancien client', business: { scheduledDay: '2026-09-09', attendance: 'show_up', channels: [], tunnels: [], closedDay: null } })], appointments: [], businessSnapshotPublished: true });
  assert.equal(result.records[0].commercialStatus, 'Ancien client');
  assert.equal(result.records[0].closingOutcome, null);
});

test('uses the recorded Notion channel, entry point and attendance when the published business snapshot has them', () => {
  const result = dashboard({ prospects: [prospect({ business: { scheduledDay: '2026-09-09', attendance: 'show_up', channels: ['Pub'], tunnels: ['Quiz'], closedDay: '2026-09-08' } })], appointments: [], businessSnapshotPublished: true });
  assert.equal(result.summary.appointments, 1);
  assert.equal(result.summary.present, 1);
  assert.equal(result.records[0].origin, 'Pub');
  assert.equal(result.records[0].tunnel, 'Quiz');
  assert.equal(result.records[0].closingAt, '2026-09-08');
});

test('does not turn missing appointment coverage into a zero', () => {
  const result = dashboard({ appointments: [] });
  assert.equal(result.summary.appointments, null);
  assert.equal(result.summary.present, null);
  assert.match(result.coverage, /ne sont pas encore disponibles/);
});

test('a dated fallback list stays readable but does not authorize daily totals', () => {
  const result = dashboard({ appointments: [appointment()] });
  assert.equal(result.records.length, 1);
  assert.equal(result.summary.appointments, null);
  assert.match(result.coverage, /totaux restent indisponibles/);
});

test('a storage error remains an error, never a zero-filled day', async () => {
  const unavailable = { select: async () => { throw new Error('base indisponible'); } } as unknown as Database;
  await assert.rejects(() => loadCommercialDay(unavailable, 'live', '2026-09-09'), /base indisponible/);
});

test('uses only recorded history and dated appointments, never a current update timestamp', () => {
  const result = dashboard({ prospects: [prospect({ source_updated_at: '2026-09-09T12:00:00Z' })], appointments: [appointment()], commercialHistory: [{ id: 'h-1', prospect_id: 'p-1', field_key: 'source_status', after_value: 'Relancé', source_effective_at: '2026-09-09T10:00:00Z' }] });
  assert.deepEqual(result.records[0].history.map(entry => entry.label), ['Statut commercial', 'Rendez-vous daté']);
});

test('an origin filter changes the displayed counters and lines together', () => {
  const data = dashboard({ prospects: [prospect({ business: { scheduledDay: '2026-09-09', attendance: 'scheduled', channels: ['Inconnue'], tunnels: [] } })], appointments: [], businessSnapshotPublished: true });
  const filtered = filterCommercialDashboard(data, 'Publicité');
  assert.equal(filtered.records.length, 0);
  assert.equal(filtered.summary.appointments, 0);
  assert.equal(filtered.summary.present, 0);
});


test('un rendez-vous passé ne reçoit pas rétrospectivement le statut commercial courant', () => {
  const result = buildCommercialDay({mode:'live',day:'2026-09-01',businessSnapshotPublished:true,prospects:[{id:'p',display_name:'Synthétique',source_status:'Closé',business:{scheduledDay:'2026-09-01',attendance:'show_up',closedDay:'2026-09-02'}}],appointments:[{id:'a',prospect_id:'p',scheduled_at:'2026-09-01T09:00:00Z',status:'attended',source_status:'Closé'}],commercialHistory:[]});
  const history = result.records[0].history;
  assert.equal(history.find(row => row.id==='appointment:a')?.value,null);
  assert.equal(history.find(row => row.id==='closing:p')?.at,'2026-09-02');
});

test('range counters are calculated before the 50-line page and retain multiple appointments for one person', () => {
  const appointments = Array.from({ length: 52 }, (_, index) => appointment({ id: `a-${index}`, prospect_id: 'p-1', scheduled_at: `2026-09-${String(index % 2 + 1).padStart(2, '0')}T09:00:00Z`, status: 'attended' }));
  const query = { ...defaultCommercialQuery('2026-09-01'), to: '2026-09-02' };
  const result = buildCommercialDashboard({ mode: 'live', query, prospects: [prospect()], appointments, commercialHistory: [], businessSnapshotPublished: true });
  assert.equal(result.summary.appointments, 52);
  assert.equal(result.summary.distinctProspects, 1);
  assert.equal(result.pagination.total, 52);
  assert.equal(result.records.length, 50);
});

test('prospect register excludes archived records but keeps people without any appointment and ignores the appointment period', () => {
  const query = { ...defaultCommercialQuery('2026-09-09'), view: 'prospects' as const, search: 'Sans RDV' };
  const result = buildCommercialDashboard({ mode: 'live', query, prospects: [prospect({ id: 'none', display_name: 'Sans RDV' }), prospect({ id: 'old', display_name: 'Archivé', archived: true })], appointments: [], commercialHistory: [], businessSnapshotPublished: true });
  assert.equal(result.pagination.total, 1);
  assert.equal(result.records[0].name, 'Sans RDV');
  assert.equal(result.records[0].appointment, null);
});

test('all-history serialization carries an explicit scope instead of falling back to today', () => {
  const query = { ...defaultCommercialQuery('2026-09-09'), from: null, to: null };
  const params = new URLSearchParams(serializeCommercialQuery(query));
  assert.equal(params.get('scope'), 'all');
  assert.equal(params.has('from'), false);
  assert.equal(params.has('to'), false);
});

test('all active filters constrain period counters before pagination', () => {
  const prospects = Array.from({ length: 55 }, (_, index) => prospect({ id: `p-${index}`, display_name: index === 51 ? 'Cible recherchée' : `Personne ${index}`, source_status: index === 51 ? 'À relancer' : 'RDV fait', owner_label: index === 51 ? 'Sophie' : 'Mehdi', business: { scheduledDay: '2026-09-09', attendance: 'show_up', channels: [index === 51 ? 'Inconnue' : 'Publicité'], tunnels: [] } }));
  const appointments = prospects.map((row, index) => appointment({ id: `a-${index}`, prospect_id: row.id, status: 'scheduled' }));
  const query = { ...defaultCommercialQuery('2026-09-09'), origin: 'Inconnue', status: 'À relancer', owner: 'Sophie', attendance: 'present' as const, search: 'Cible recherchée' };
  const result = buildCommercialDashboard({ mode: 'live', query, prospects, appointments, commercialHistory: [], businessSnapshotPublished: true });
  assert.equal(result.pagination.total, 1);
  assert.equal(result.summary.appointments, 1);
  assert.equal(result.summary.present, 1);
  assert.deepEqual(result.filters.origins, ['Inconnue', 'Publicité']);
});

test('business slots remain distinct on another day and supply the recorded attendance on their matching day', () => {
  const dated = prospect({ business: { scheduledDay: '2026-09-10', attendance: 'show_up', channels: [], tunnels: [] } });
  const otherDay = appointment({ scheduled_at: '2026-09-09T08:00:00Z', status: 'scheduled' });
  const range = { ...defaultCommercialQuery('2026-09-09'), to: '2026-09-10' };
  const result = buildCommercialDashboard({ mode: 'live', query: range, prospects: [dated], appointments: [otherDay], commercialHistory: [], businessSnapshotPublished: true });
  assert.equal(result.summary.appointments, 2);
  const matching = buildCommercialDashboard({ mode: 'live', query: { ...defaultCommercialQuery('2026-09-10') }, prospects: [dated], appointments: [appointment({ scheduled_at: '2026-09-10T08:00:00Z', status: 'scheduled' })], commercialHistory: [], businessSnapshotPublished: true });
  assert.equal(matching.summary.appointments, 1);
  assert.equal(matching.records[0].appointment?.attendance, 'present');
});

test('an archived prospect is absent from the current register but still identifies a historical appointment', () => {
  const archived = prospect({ id: 'archived', display_name: 'Historique conservé', archived: true });
  const historical = buildCommercialDashboard({ mode: 'live', query: defaultCommercialQuery('2026-09-09'), prospects: [archived], appointments: [appointment({ prospect_id: 'archived' })], commercialHistory: [], businessSnapshotPublished: true });
  assert.equal(historical.records[0].name, 'Historique conservé');
  const register = buildCommercialDashboard({ mode: 'live', query: { ...defaultCommercialQuery('2026-09-09'), view: 'prospects' }, prospects: [archived], appointments: [], commercialHistory: [], businessSnapshotPublished: true });
  assert.equal(register.pagination.total, 0);
  assert.equal(register.period.from, null);
});

test('commercial snapshot is reread after an explicit invalidation', async () => {
  let version = 1;
  const db = { async select(table: string) { if (table === 'sync_runs') return [{ status: 'complete', pagination_complete: true, rows_rejected: 0, finished_at: '2026-09-09T10:00:00Z' }]; if (table === 'prospects') return [prospect({ display_name: `Version ${version}` })]; return []; } } as unknown as Database;
  const first = await loadCommercialDashboard(db, 'live', { ...defaultCommercialQuery('2026-09-09'), view: 'prospects' });
  version = 2;
  const cached = await loadCommercialDashboard(db, 'live', { ...defaultCommercialQuery('2026-09-09'), view: 'prospects' });
  invalidateCommercialSnapshot(db);
  const fresh = await loadCommercialDashboard(db, 'live', { ...defaultCommercialQuery('2026-09-09'), view: 'prospects' });
  assert.equal(first.records[0].name, 'Version 1');
  assert.equal(cached.records[0].name, 'Version 1');
  assert.equal(fresh.records[0].name, 'Version 2');
});


test('prospect register preserves a recorded business slot without an appointment row', () => {
  const result = buildCommercialDashboard({ mode: 'live', query: { ...defaultCommercialQuery('2026-09-09'), view: 'prospects' }, prospects: [prospect({ business: { scheduledDay: '2026-09-01', attendance: 'show_up' } })], appointments: [], commercialHistory: [], businessSnapshotPublished: true });
  assert.equal(result.records[0].appointment?.scheduledAt, '2026-09-01');
  assert.equal(result.records[0].appointment?.attendance, 'present');
});

test('prospect filters preserve the requested appointment dates while the register is unbounded', () => {
  const query = { ...defaultCommercialQuery('2026-09-01'), to: '2026-09-08', view: 'prospects' as const, search: 'Ada' };
  const result = buildCommercialDashboard({ mode: 'live', query, prospects: [prospect()], appointments: [], commercialHistory: [], businessSnapshotPublished: true });
  assert.equal(result.period.from, null);
  assert.equal(result.query.from, '2026-09-01');
  assert.equal(result.query.to, '2026-09-08');
  assert.equal(result.records.length, 1);
});

test('a history entry linked to both the person and appointment appears once', () => {
  const result = dashboard({ commercialHistory: [{ id: 'h-1', prospect_id: 'p-1', appointment_id: 'a-1', field_key: 'source_status', after_value: 'RDV fait', observed_at: '2026-09-09T09:00:00Z' }] });
  assert.equal(result.records[0].history.filter(row => row.id === 'history:h-1').length, 1);
});
