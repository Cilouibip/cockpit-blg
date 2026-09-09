import type { DataMode } from './ui-contract';

/**
 * Read model for the daily commercial view. It deliberately keeps a recorded
 * outcome separate from attendance: a sale outcome never makes somebody
 * present at an appointment.
 */
export type CommercialAttendance = 'present' | 'absent' | 'planned' | 'cancelled' | 'rescheduled' | 'unknown';

export type CommercialHistoryEntry = {
  id: string;
  at: string | null;
  label: string;
  value: string | null;
};

export type CommercialAppointment = {
  id: string;
  scheduledAt: string;
  attendance: CommercialAttendance;
  sourceStatus: string | null;
};

export type CommercialRecord = {
  id: string;
  prospectId: string | null;
  name: string;
  owner: string | null;
  origin: string;
  tunnel: string | null;
  commercialStatus: string;
  closingOutcome: string | null;
  nextActionAt: string | null;
  appointment: CommercialAppointment;
  history: CommercialHistoryEntry[];
};

export type CommercialSummary = {
  appointments: number | null;
  present: number | null;
  distinctProspects: number | null;
};

export type CommercialDashboard = {
  mode: DataMode;
  day: string;
  generatedAt: string;
  updatedAt: string | null;
  records: CommercialRecord[];
  summary: CommercialSummary;
  coverage: string;
  notice?: string;
};

export type CommercialPageProps = {
  data: CommercialDashboard;
  loading?: boolean;
  onDateChange: (day: string) => void;
  onRetry?: () => void;
};
