import { allRows, type Database, type Row } from './db';
import type { DataMode } from './ui-contract';
import type { CommercialAppointment, CommercialAttendance, CommercialDashboard, CommercialFollowUp, CommercialHistoryEntry, CommercialQuery, CommercialRecord } from './commercial-contract';

const PARIS = 'Europe/Paris';
const DAY = new Intl.DateTimeFormat('en-CA', { timeZone: PARIS, year: 'numeric', month: '2-digit', day: '2-digit' });
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const strings = (value: unknown) => Array.isArray(value) ? value.map(text).filter((value): value is string => value !== null) : [];
const identifier = (value: unknown) => text(value);

type Business = { scheduledDay: string | null; attendance: CommercialAttendance; channels: string[]; tunnels: string[]; closedDay: string | null };
type Snapshot = { prospects: Row[]; appointments: Row[]; commercialHistory: Row[]; businessSnapshotPublished: boolean; updatedAt: string | null };

function business(row: Row): Business {
  const value = object(row.business), scheduledDay = text(value.scheduledDay), rawAttendance = text(value.attendance);
  const attendance: CommercialAttendance = rawAttendance === 'show_up' ? 'present' : rawAttendance === 'no_show' ? 'absent' : rawAttendance === 'cancelled' ? 'cancelled' : rawAttendance === 'scheduled' ? 'planned' : 'unknown';
  return { scheduledDay: scheduledDay && DATE.test(scheduledDay) ? scheduledDay : null, attendance, channels: strings(value.channels), tunnels: strings(value.tunnels), closedDay: text(value.closedDay) };
}

/** Timestamp dates are read in Paris. A source date without an hour remains a date. */
export function parisAppointmentDay(row: Row): string | null {
  const timestamp = text(row.scheduled_at);
  if (timestamp) { const value = new Date(timestamp); if (!Number.isNaN(value.getTime())) return DAY.format(value); }
  const localDay = text(row.scheduled_day);
  return localDay && DATE.test(localDay) ? localDay : null;
}

/** A recorded next-action date keeps its Paris calendar day; malformed values are not due dates. */
export function parisNextActionDay(value: string | null): string | null {
  if (!value) return null;
  if (DATE.test(value)) return value;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : DAY.format(timestamp);
}

function sourceAttendance(status: unknown): CommercialAttendance {
  switch (text(status)) { case 'attended': return 'present'; case 'no_show': return 'absent'; case 'scheduled': return 'planned'; case 'cancelled': return 'cancelled'; case 'rescheduled': return 'rescheduled'; default: return 'unknown'; }
}
function historyLabel(key: string): string { return ({ snapshot_initial: 'État initial enregistré', source_status: 'Statut commercial', owner_label: 'Responsable', current_appointment_at: 'Rendez-vous', next_follow_up_at: 'Prochaine action', archived: 'Archivage', scheduled_at: 'Rendez-vous', status: 'Statut du rendez-vous' } as Record<string, string>)[key] ?? 'Mise à jour enregistrée'; }
function historyTime(entry: CommercialHistoryEntry): number { const value = entry.at ? new Date(entry.at).getTime() : 0; return Number.isNaN(value) ? 0 : value; }
function inPeriod(day: string | null, query: CommercialQuery) { return day !== null && (query.from === null || day >= query.from) && (query.to === null || day <= query.to); }
function recordedHistory(row: Row): CommercialHistoryEntry { const after = row.after_value; return { id: `history:${String(row.id)}`, at: text(row.source_effective_at) ?? text(row.observed_at), label: historyLabel(text(row.field_key) ?? ''), value: typeof after === 'string' || typeof after === 'number' || typeof after === 'boolean' ? String(after) : null }; }
function appointmentHistory(row: Row): CommercialHistoryEntry { return { id: `appointment:${String(row.id)}`, at: text(row.scheduled_at) ?? text(row.scheduled_day), label: 'Rendez-vous daté', value: null }; }

function appointment(row: Row, fallback: string, prospect?: Row): CommercialAppointment {
  const currentBusiness = prospect ? business(prospect) : null, day = parisAppointmentDay(row);
  const recordedAttendance = currentBusiness?.scheduledDay === day && currentBusiness.attendance !== 'unknown' ? currentBusiness.attendance : sourceAttendance(row.status);
  return { id: String(row.id), scheduledAt: text(row.scheduled_at) ?? text(row.scheduled_day) ?? fallback, attendance: recordedAttendance, sourceStatus: text(row.source_status) };
}
function record(prospect: Row | undefined, prospectId: string | null, slot: CommercialAppointment | null, history: CommercialHistoryEntry[], fallbackName = 'Prospect non rattaché'): CommercialRecord {
  const currentBusiness = prospect ? business(prospect) : null;
  return { id: slot?.id ?? `prospect:${prospectId ?? fallbackName}`, prospectId, name: text(prospect?.display_name) ?? fallbackName, owner: text(prospect?.owner_label), origin: currentBusiness?.channels.join(' · ') || 'Inconnue', tunnel: currentBusiness?.tunnels.join(' · ') || null, commercialStatus: text(prospect?.source_status) ?? 'Non renseigné', closingOutcome: text(prospect?.outcome), closingAt: currentBusiness?.closedDay ?? null, nextActionAt: text(prospect?.next_follow_up_at), appointment: slot, history: [...new Map(history.map(entry => [entry.id, entry])).values()].sort((a, b) => historyTime(b) - historyTime(a) || a.id.localeCompare(b.id)) };
}
function followUpMatches(day: string | null, scope: CommercialFollowUp, todayDay: string) {
  if (scope === 'all') return true;
  if (!day) return false;
  if (scope === 'overdue') return day < todayDay;
  if (scope === 'today') return day === todayDay;
  return day > todayDay;
}
function matches(record: CommercialRecord, query: CommercialQuery, todayDay: string) {
  const searchable = `${record.name} ${record.origin} ${record.commercialStatus} ${record.owner ?? ''}`.toLocaleLowerCase('fr');
  const nextActionDay = parisNextActionDay(record.nextActionAt);
  return (!query.search || searchable.includes(query.search.toLocaleLowerCase('fr'))) && (query.origin === 'all' || record.origin === query.origin) && (query.status === 'all' || record.commercialStatus === query.status) && (query.owner === 'all' || record.owner === query.owner) && (query.attendance === 'all' || record.appointment?.attendance === query.attendance) && (query.nextAction === 'all' || (query.nextAction === 'recorded' ? nextActionDay !== null : nextActionDay === null)) && followUpMatches(nextActionDay, query.followUp, todayDay);
}
function filterOptions(records: CommercialRecord[]) {
  const unique = (values: (string | null)[]) => [...new Set(values.filter((value): value is string => value !== null && value !== ''))].sort((a, b) => a.localeCompare(b, 'fr'));
  return { origins: unique(records.map(record => record.origin)), statuses: unique(records.map(record => record.commercialStatus)), owners: unique(records.map(record => record.owner)) };
}
function effectiveQuery(query: CommercialQuery): CommercialQuery { return query.view === 'appointments' ? query : { ...query, from: null, to: null }; }
export function defaultCommercialQuery(day: string): CommercialQuery { return { from: day, to: day, view: 'appointments', page: 0, pageSize: 50, search: '', origin: 'all', status: 'all', attendance: 'all', owner: 'all', nextAction: 'all', followUp: 'all' }; }

export function buildCommercialDashboard(input: { mode: DataMode; query: CommercialQuery; prospects: Row[]; appointments: Row[]; commercialHistory: Row[]; businessSnapshotPublished?: boolean; updatedAt?: string | null }): CommercialDashboard {
  const query = effectiveQuery(input.query);
  if ((query.from && !DATE.test(query.from)) || (query.to && !DATE.test(query.to)) || (query.from && query.to && query.from > query.to)) throw new Error('La période commerciale est invalide.');
  const allProspects = new Map(input.prospects.map(row => [String(row.id), row]));
  const activeProspects = new Map(input.prospects.filter(row => row.archived !== true).map(row => [String(row.id), row]));
  const appointmentsByProspect = new Map<string, Row[]>();
  const uniqueAppointments = new Map(input.appointments.map(row => [String(row.id), row]));
  for (const row of uniqueAppointments.values()) { const prospectId = identifier(row.prospect_id); if (prospectId) appointmentsByProspect.set(prospectId, [...(appointmentsByProspect.get(prospectId) ?? []), row]); }
  const prospectHistory = new Map<string, CommercialHistoryEntry[]>(), appointmentHistoryMap = new Map<string, CommercialHistoryEntry[]>();
  for (const row of input.commercialHistory) { const entry = recordedHistory(row), prospectId = identifier(row.prospect_id), appointmentId = identifier(row.appointment_id); if (prospectId) prospectHistory.set(prospectId, [...(prospectHistory.get(prospectId) ?? []), entry]); if (appointmentId) appointmentHistoryMap.set(appointmentId, [...(appointmentHistoryMap.get(appointmentId) ?? []), entry]); }
  const historyFor = (prospectId: string | null, appointmentId: string | null) => {
    const prospect = prospectId ? allProspects.get(prospectId) : undefined, closingAt = prospect ? business(prospect).closedDay : null;
    return [...(prospectId ? (appointmentsByProspect.get(prospectId) ?? []).map(appointmentHistory) : []), ...(prospectId ? prospectHistory.get(prospectId) ?? [] : []), ...(appointmentId ? appointmentHistoryMap.get(appointmentId) ?? [] : []), ...(closingAt ? [{ id: `closing:${prospectId}`, at: closingAt, label: 'Closing daté dans la fiche', value: null }] : [])];
  };
  const datedRows = [...uniqueAppointments.values()].filter(row => inPeriod(parisAppointmentDay(row), query));
  const businessSlots = [...allProspects.values()].flatMap(prospect => {
    const currentBusiness = business(prospect), prospectId = String(prospect.id);
    const hasSameDaySlot = (appointmentsByProspect.get(prospectId) ?? []).some(row => parisAppointmentDay(row) === currentBusiness.scheduledDay);
    return inPeriod(currentBusiness.scheduledDay, query) && !hasSameDaySlot ? [{ prospect, prospectId, currentBusiness }] : [];
  });
  const appointmentRecords = [
    ...datedRows.map(row => { const prospectId = identifier(row.prospect_id), prospect = prospectId ? allProspects.get(prospectId) : undefined, slot = appointment(row, query.from ?? '', prospect); return record(prospect, prospectId, slot, historyFor(prospectId, slot.id)); }),
    ...businessSlots.map(({ prospect, prospectId, currentBusiness }) => record(prospect, prospectId, { id: `business:${prospectId}`, scheduledAt: currentBusiness.scheduledDay!, attendance: currentBusiness.attendance, sourceStatus: text(prospect.source_status) }, historyFor(prospectId, null))),
  ].sort((a, b) => (a.appointment?.scheduledAt ?? '').localeCompare(b.appointment?.scheduledAt ?? '') || a.id.localeCompare(b.id));
  const prospectRecords = [...activeProspects.values()].map(prospect => {
    const prospectId = String(prospect.id), related = (appointmentsByProspect.get(prospectId) ?? []).sort((a, b) => (text(b.scheduled_at) ?? text(b.scheduled_day) ?? '').localeCompare(text(a.scheduled_at) ?? text(a.scheduled_day) ?? ''));
    const latest = related[0], currentBusiness = business(prospect);
    const latestDay = latest ? parisAppointmentDay(latest) : null;
    const useBusiness = currentBusiness.scheduledDay && (!latestDay || currentBusiness.scheduledDay > latestDay);
    const slot: CommercialAppointment | null = useBusiness
      ? { id: `business:${prospectId}`, scheduledAt: currentBusiness.scheduledDay!, attendance: currentBusiness.attendance, sourceStatus: text(prospect.source_status) }
      : latest ? appointment(latest, '', prospect) : null;
    return record(prospect, prospectId, slot, historyFor(prospectId, latest ? String(latest.id) : null));
  }).sort((a, b) => a.name.localeCompare(b.name, 'fr') || a.id.localeCompare(b.id));
  const todayDay = DAY.format(new Date());
  const followUpRecords = prospectRecords.filter(record => parisNextActionDay(record.nextActionAt) !== null).sort((left, right) => (parisNextActionDay(left.nextActionAt) ?? '').localeCompare(parisNextActionDay(right.nextActionAt) ?? '') || left.name.localeCompare(right.name, 'fr') || left.id.localeCompare(right.id));
  const allForView = query.view === 'appointments' ? appointmentRecords : query.view === 'followups' ? followUpRecords : prospectRecords;
  const filteredRecords = allForView.filter(candidate => matches(candidate, query, todayDay));
  const filteredAppointments = appointmentRecords.filter(candidate => matches(candidate, query, todayDay));
  const followUpScope = { ...query, view: 'followups' as const, nextAction: 'recorded' as const, followUp: 'all' as const };
  const filteredFollowUps = followUpRecords.filter(candidate => matches(candidate, followUpScope, todayDay));
  const pageSize = Math.min(50, Math.max(1, query.pageSize)), total = filteredRecords.length, page = Math.min(Math.max(0, query.page), Math.max(0, Math.ceil(total / pageSize) - 1)), start = page * pageSize;
  const currentProspects = new Set(filteredAppointments.map(row => row.prospectId).filter((value): value is string => value !== null));
  const updatedAt = input.updatedAt ?? [...input.prospects, ...input.appointments, ...input.commercialHistory].map(row => text(row.observed_at) ?? text(row.source_updated_at)).filter((value): value is string => value !== null).sort().at(-1) ?? null;
  const covered = input.businessSnapshotPublished === true;
  const followUps = { overdue: filteredFollowUps.filter(record => (parisNextActionDay(record.nextActionAt) ?? '') < todayDay).length, today: filteredFollowUps.filter(record => parisNextActionDay(record.nextActionAt) === todayDay).length, upcoming: filteredFollowUps.filter(record => (parisNextActionDay(record.nextActionAt) ?? '') > todayDay).length, undated: prospectRecords.filter(record => parisNextActionDay(record.nextActionAt) === null).length };
  const coverage = query.view === 'followups' && followUpRecords.length === 0 ? 'Aucune prochaine action datée n’est enregistrée dans le suivi commercial.' : covered ? 'Données Notion importées : les rendez-vous et présences enregistrés sont affichés.' : input.appointments.length ? 'Des rendez-vous datés sont disponibles, mais les totaux restent indisponibles.' : 'Les rendez-vous ne sont pas encore disponibles dans cette lecture.';
  return { mode: input.mode, day: query.from ?? DAY.format(new Date()), period: { from: query.from, to: query.to, timezone: PARIS }, view: query.view, query: { ...input.query, page, pageSize }, generatedAt: new Date().toISOString(), updatedAt, records: filteredRecords.slice(start, start + pageSize), pagination: { page, pageSize, total }, filters: filterOptions(allForView), summary: { appointments: covered ? filteredAppointments.length : null, present: covered ? filteredAppointments.filter(row => row.appointment?.attendance === 'present').length : null, distinctProspects: covered ? currentProspects.size : null, followUps }, coverage, notice: covered ? undefined : 'La liste peut être partielle. Les compteurs restent indisponibles tant que la lecture complète n’est pas établie.' };
}

export function buildCommercialDay(input: Omit<Parameters<typeof buildCommercialDashboard>[0], 'query'> & { day: string }) { return buildCommercialDashboard({ ...input, query: defaultCommercialQuery(input.day) }); }

const snapshotCache = new WeakMap<Database, { expiresAt: number; value: Snapshot }>();
const CACHE_MS = 15_000;
export function invalidateCommercialSnapshot(db: Database) { snapshotCache.delete(db); }
async function snapshot(db: Database): Promise<Snapshot> {
  const cached = snapshotCache.get(db); if (cached && cached.expiresAt > Date.now()) return cached.value;
  const [prospects, appointments, commercialHistory, publications] = await Promise.all([allRows(db, 'prospects', 50_000), allRows(db, 'appointments', 50_000), allRows(db, 'commercial_history', 50_000), db.select('sync_runs', { eq: { source: 'notion', stream_key: 'prospects_business' }, order: 'finished_at', descending: true, limit: 20 })]);
  const lastPublished = publications.find(row => ['complete', 'empty'].includes(String(row.status)) && row.pagination_complete === true && Number(row.rows_rejected) === 0);
  const value = { prospects, appointments, commercialHistory, businessSnapshotPublished: !!lastPublished, updatedAt: text(lastPublished?.finished_at) ?? null };
  snapshotCache.set(db, { expiresAt: Date.now() + CACHE_MS, value }); return value;
}
export async function loadCommercialDashboard(db: Database, mode: DataMode, query: CommercialQuery) { return buildCommercialDashboard({ mode, query, ...(await snapshot(db)) }); }
export async function loadCommercialDay(db: Database, mode: DataMode, day: string) { return loadCommercialDashboard(db, mode, defaultCommercialQuery(day)); }
export { filterCommercialDashboard } from './commercial-filter';
