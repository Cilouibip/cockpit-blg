import type { DataMode } from './ui-contract';

export type CommercialAttendance = 'present' | 'absent' | 'planned' | 'cancelled' | 'rescheduled' | 'unknown';
export type CommercialView = 'appointments' | 'prospects';
export type CommercialHistoryEntry = { id: string; at: string | null; label: string; value: string | null };
export type CommercialAppointment = { id: string; scheduledAt: string; attendance: CommercialAttendance; sourceStatus: string | null };

/** Current values remain facts on the sheet. Only recorded entries belong in history. */
export type CommercialRecord = {
  id: string; prospectId: string | null; name: string; owner: string | null; origin: string; tunnel: string | null;
  commercialStatus: string; closingOutcome: string | null; closingAt: string | null; nextActionAt: string | null;
  appointment: CommercialAppointment | null; history: CommercialHistoryEntry[];
};
export type CommercialSummary = { appointments: number | null; present: number | null; distinctProspects: number | null };
export type CommercialPagination = { page: number; pageSize: number; total: number };
export type CommercialFilterOptions = { origins: string[]; statuses: string[]; owners: string[] };
export type CommercialQuery = {
  from: string | null; to: string | null; view: CommercialView; page: number; pageSize: number;
  search: string; origin: string; status: string; attendance: CommercialAttendance | 'all'; owner: string; nextAction: 'all' | 'recorded';
};
export type CommercialDashboard = {
  mode: DataMode; day: string; period: { from: string | null; to: string | null; timezone: string };
  view: CommercialView; query: CommercialQuery; generatedAt: string; updatedAt: string | null;
  records: CommercialRecord[]; summary: CommercialSummary; pagination: CommercialPagination; filters: CommercialFilterOptions;
  coverage: string; notice?: string;
};
export type CommercialPageProps = { data: CommercialDashboard; loading?: boolean; onQueryChange: (query: Partial<CommercialQuery>) => void; onRetry?: () => void };
