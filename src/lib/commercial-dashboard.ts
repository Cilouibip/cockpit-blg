import { allRows, type Database, type Row } from './db';
import type { DataMode } from './ui-contract';
import type { CommercialAppointment, CommercialAttendance, CommercialDashboard, CommercialHistoryEntry, CommercialRecord } from './commercial-contract';

const PARIS = 'Europe/Paris';
const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: PARIS, year: 'numeric', month: '2-digit', day: '2-digit' });
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const id = (value: unknown): string | null => text(value);
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(text).filter((item): item is string => item !== null) : [];

type BusinessSnapshot = { scheduledDay: string | null; attendance: CommercialAttendance; channels: string[]; tunnels: string[]; closedDay: string | null };
function businessSnapshot(row: Row): BusinessSnapshot {
  const business = object(row.business);
  const scheduledDay = text(business.scheduledDay);
  const rawAttendance = text(business.attendance);
  const attendanceValue: CommercialAttendance = rawAttendance === 'show_up' ? 'present'
    : rawAttendance === 'no_show' ? 'absent'
      : rawAttendance === 'cancelled' ? 'cancelled'
        : rawAttendance === 'scheduled' ? 'planned' : 'unknown';
  return { scheduledDay: scheduledDay && datePattern.test(scheduledDay) ? scheduledDay : null, attendance: attendanceValue, channels: strings(business.channels), tunnels: strings(business.tunnels), closedDay: text(business.closedDay) };
}

/** A scheduled timestamp is interpreted in Paris. A stored local scheduled_day is the fallback. */
export function parisAppointmentDay(row: Row): string | null {
  const timestamp = text(row.scheduled_at);
  if (timestamp) {
    const date = new Date(timestamp);
    if (!Number.isNaN(date.getTime())) return dayFormatter.format(date);
  }
  const localDay = text(row.scheduled_day);
  return localDay && datePattern.test(localDay) ? localDay : null;
}

function attendance(status: unknown): CommercialAttendance {
  switch (text(status)) {
    case 'attended': return 'present';
    case 'no_show': return 'absent';
    case 'scheduled': return 'planned';
    case 'cancelled': return 'cancelled';
    case 'rescheduled': return 'rescheduled';
    default: return 'unknown';
  }
}

function historyLabel(key: string): string {
  return ({
    snapshot_initial: 'État initial enregistré',
    source_status: 'Statut commercial',
    owner_label: 'Responsable',
    current_appointment_at: 'Rendez-vous',
    next_follow_up_at: 'Prochaine action',
    archived: 'Archivage',
    scheduled_at: 'Rendez-vous',
    status: 'Statut du rendez-vous',
  } as Record<string, string>)[key] ?? 'Mise à jour enregistrée';
}

function valueOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function appointmentHistory(row: Row): CommercialHistoryEntry {
  return {
    id: `appointment:${String(row.id)}`,
    at: text(row.scheduled_at) ?? text(row.scheduled_day),
    label: 'Rendez-vous daté',
    value: null,
  };
}

function recordedHistory(row: Row): CommercialHistoryEntry {
  return {
    id: `history:${String(row.id)}`,
    at: text(row.source_effective_at) ?? text(row.observed_at),
    label: historyLabel(text(row.field_key) ?? ''),
    value: valueOf(row.after_value),
  };
}

function historyTime(entry: CommercialHistoryEntry): number {
  if (!entry.at) return 0;
  const value = new Date(entry.at).getTime();
  return Number.isNaN(value) ? 0 : value;
}

export function buildCommercialDay(input: {
  mode: DataMode;
  day: string;
  prospects: Row[];
  appointments: Row[];
  commercialHistory: Row[];
  businessSnapshotPublished?: boolean;
}): CommercialDashboard {
  if (!datePattern.test(input.day)) throw new Error('La journée commerciale doit être une date ISO.');
  const prospects = new Map(input.prospects.map(row => [String(row.id), row]));
  const appointmentById = new Map(input.appointments.map(row => [String(row.id), row]));
  const current = [...appointmentById.values()].filter(row => parisAppointmentDay(row) === input.day);
  const historiesByProspect = new Map<string, CommercialHistoryEntry[]>();
  const historiesByAppointment = new Map<string, CommercialHistoryEntry[]>();
  for (const row of input.commercialHistory) {
    const entry = recordedHistory(row);
    const prospectId = id(row.prospect_id), appointmentId = id(row.appointment_id);
    if (prospectId) historiesByProspect.set(prospectId, [...(historiesByProspect.get(prospectId) ?? []), entry]);
    if (appointmentId) historiesByAppointment.set(appointmentId, [...(historiesByAppointment.get(appointmentId) ?? []), entry]);
  }
  const appointmentsByProspect = new Map<string, Row[]>();
  for (const row of appointmentById.values()) {
    const prospectId = id(row.prospect_id);
    if (prospectId) appointmentsByProspect.set(prospectId, [...(appointmentsByProspect.get(prospectId) ?? []), row]);
  }
  const businessRecords = input.prospects.flatMap(prospect => {
    const business = businessSnapshot(prospect);
    if (business.scheduledDay !== input.day) return [];
    const prospectId = String(prospect.id);
    const matchingAppointment = (appointmentsByProspect.get(prospectId) ?? []).find(row => parisAppointmentDay(row) === input.day);
    const appointment: CommercialAppointment = matchingAppointment ? {
      id: String(matchingAppointment.id), scheduledAt: text(matchingAppointment.scheduled_at) ?? text(matchingAppointment.scheduled_day) ?? input.day,
      attendance: business.attendance === 'unknown' ? attendance(matchingAppointment.status) : business.attendance,
      sourceStatus: text(matchingAppointment.source_status),
    } : { id: `business:${prospectId}`, scheduledAt: business.scheduledDay, attendance: business.attendance, sourceStatus: text(prospect.source_status) };
    const history = [
      ...(appointmentsByProspect.get(prospectId) ?? []).map(appointmentHistory),
      ...(historiesByProspect.get(prospectId) ?? []),
      ...(matchingAppointment ? historiesByAppointment.get(String(matchingAppointment.id)) ?? [] : []),
      ...(business.closedDay ? [{ id: `closing:${prospectId}`, at: business.closedDay, label: 'Closing daté dans la fiche', value: null }] : []),
    ].sort((left, right) => historyTime(right) - historyTime(left) || left.id.localeCompare(right.id));
    const closed = business.closedDay ? `Closé le ${business.closedDay}` : null;
    return [{
      id: `business:${prospectId}`,
      prospectId,
      name: text(prospect.display_name) ?? 'Prospect non rattaché',
      owner: text(prospect.owner_label),
      origin: business.channels.join(' · ') || 'Inconnue',
      tunnel: business.tunnels.join(' · ') || null,
      commercialStatus: text(prospect.source_status) ?? 'Non renseigné',
      closingOutcome: closed ?? text(prospect.outcome),
      nextActionAt: text(prospect.next_follow_up_at),
      appointment,
      history,
    }];
  });
  const businessProspectIds = new Set(businessRecords.map(record => record.prospectId).filter((value): value is string => value !== null));
  const appointmentRecords: CommercialRecord[] = current.filter(row => !businessProspectIds.has(id(row.prospect_id) ?? '')).map(row => {
    const prospectId = id(row.prospect_id), prospect = prospectId ? prospects.get(prospectId) : undefined;
    const appointment: CommercialAppointment = {
      id: String(row.id),
      scheduledAt: text(row.scheduled_at) ?? text(row.scheduled_day) ?? input.day,
      attendance: attendance(row.status),
      sourceStatus: text(row.source_status),
    };
    const history = [
      ...((prospectId ? appointmentsByProspect.get(prospectId) : []) ?? []).map(appointmentHistory),
      ...((prospectId ? historiesByProspect.get(prospectId) : []) ?? []),
      ...(historiesByAppointment.get(appointment.id) ?? []),
    ].sort((left, right) => historyTime(right) - historyTime(left) || left.id.localeCompare(right.id));
    return {
      id: appointment.id,
      prospectId,
      name: text(prospect?.display_name) ?? 'Prospect non rattaché',
      owner: text(prospect?.owner_label),
      // The commercial mirror has no acquisition-origin or tunnel field. Never use the connector name as an origin.
      origin: 'Inconnue',
      tunnel: null,
      commercialStatus: text(prospect?.source_status) ?? 'Non renseigné',
      closingOutcome: text(prospect?.outcome),
      nextActionAt: text(prospect?.next_follow_up_at),
      appointment,
      history,
    };
  });
  const records = [...businessRecords, ...appointmentRecords].sort((left, right) => left.appointment.scheduledAt.localeCompare(right.appointment.scheduledAt) || left.name.localeCompare(right.name, 'fr'));
  // The fallback mirrors dated slots but has no publication-level completeness proof.
  // It can populate a readable list, never authorize a total or a zero KPI.
  const collectionCovered = input.businessSnapshotPublished === true;
  const distinctProspects = new Set(records.map(record => record.prospectId).filter((value): value is string => value !== null));
  const updated = [...input.prospects, ...input.appointments, ...input.commercialHistory]
    .map(row => text(row.observed_at) ?? text(row.source_updated_at))
    .filter((value): value is string => value !== null)
    .sort().at(-1) ?? null;
  return {
    mode: input.mode,
    day: input.day,
    generatedAt: new Date().toISOString(),
    updatedAt: updated,
    records,
    summary: {
      appointments: collectionCovered ? records.length : null,
      present: collectionCovered ? records.filter(record => record.appointment.attendance === 'present').length : null,
      distinctProspects: collectionCovered ? distinctProspects.size : null,
    },
    coverage: input.businessSnapshotPublished
      ? 'Journée et présences lues dans la publication Notion complète. L’origine et le point d’entrée sont ceux enregistrés dans la fiche.'
      : input.appointments.length
      ? 'Rendez-vous datés visibles dans le miroir commercial, mais couverture complète non établie : aucun total n’est affiché.'
      : 'La collection de rendez-vous n’est pas encore couverte par ce miroir : aucun total n’est affiché.',
    notice: collectionCovered ? undefined : input.appointments.length
      ? 'La liste disponible peut être partielle : les compteurs restent indisponibles tant que la publication complète n’est pas établie.'
      : 'Les rendez-vous ne sont pas encore disponibles pour cette journée.',
  };
}

/**
 * Bounded, read-only query of the three normalized commercial collections.
 * The result intentionally does not fall back to a paginated prospect list.
 */
const dailyCache = new WeakMap<Database, Map<string, { expiresAt: number; value: CommercialDashboard }>>();
const CACHE_MS = 15_000;

export async function loadCommercialDay(db: Database, mode: DataMode, day: string): Promise<CommercialDashboard> {
  const key = `${mode}:${day}`, cache = dailyCache.get(db) ?? new Map<string, { expiresAt: number; value: CommercialDashboard }>();
  dailyCache.set(db, cache);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const [prospects, appointments, commercialHistory, publications] = await Promise.all([
    allRows(db, 'prospects', 50_000),
    allRows(db, 'appointments', 50_000),
    allRows(db, 'commercial_history', 50_000),
    db.select('sync_runs', { eq: { source: 'notion', stream_key: 'prospects_business' }, order: 'finished_at', descending: true, limit: 20 }),
  ]);
  const businessSnapshotPublished = publications.some(row => ['complete', 'empty'].includes(String(row.status)) && row.pagination_complete === true && Number(row.rows_rejected) === 0);
  const value = buildCommercialDay({ mode, day, prospects, appointments, commercialHistory, businessSnapshotPublished });
  const lastPublished = publications.find(row => ['complete', 'empty'].includes(String(row.status)) && row.pagination_complete === true && Number(row.rows_rejected) === 0);
  value.updatedAt = text(lastPublished?.finished_at) ?? value.updatedAt;
  if (cache.size >= 32) cache.delete(cache.keys().next().value as string);
  cache.set(key, { expiresAt: Date.now() + CACHE_MS, value });
  return value;
}

export { filterCommercialDashboard } from './commercial-filter';
