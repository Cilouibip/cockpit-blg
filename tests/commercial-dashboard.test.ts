import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCommercialDay, filterCommercialDashboard, loadCommercialDay, parisAppointmentDay } from '../src/lib/commercial-dashboard';
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
  assert.equal(result.records.length, 53);
});

test('attendance is distinct from a commercial outcome', () => {
  const result = dashboard({ prospects: [prospect({ outcome: 'Vendu', business: { scheduledDay: '2026-09-09', attendance: 'no_show', channels: [], tunnels: [] } })], appointments: [appointment({ status: 'no_show' })], businessSnapshotPublished: true });
  assert.equal(result.summary.present, 0);
  assert.equal(result.records[0].appointment.attendance, 'absent');
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
  assert.equal(result.records[0].closingOutcome, 'Closé le 2026-09-08');
});

test('does not turn missing appointment coverage into a zero', () => {
  const result = dashboard({ appointments: [] });
  assert.equal(result.summary.appointments, null);
  assert.equal(result.summary.present, null);
  assert.match(result.coverage, /n’est pas encore couverte/);
});

test('a dated fallback list stays readable but does not authorize daily totals', () => {
  const result = dashboard({ appointments: [appointment()] });
  assert.equal(result.records.length, 1);
  assert.equal(result.summary.appointments, null);
  assert.match(result.coverage, /couverture complète non établie/);
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
