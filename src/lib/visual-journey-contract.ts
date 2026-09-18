import type { SourceFilter } from './ui-contract';

export type VisualJourneyStageId = 'page' | 'form' | 'signup' | 'watch' | 'call';
export type VisualJourneySource = 'posthog' | 'wix' | 'appointments';

export interface VisualJourneyAvailability {
  available: boolean;
  reason: string | null;
}

export interface VisualJourneyMetric extends VisualJourneyAvailability {
  count: number | null;
}

/** Le numérateur et le dénominateur décrivent toujours la même cohorte appariée. */
export interface VisualJourneyRate extends VisualJourneyAvailability {
  numerator: number | null;
  denominator: number | null;
  rate: number | null;
}

export interface VisualJourneyStage {
  id: VisualJourneyStageId;
  label: string;
  count: number | null;
  availability: VisualJourneyAvailability;
  fromPrevious: VisualJourneyRate | null;
}

export interface VisualJourneyReport {
  status: 'complete' | 'partial' | 'empty' | 'not_configured' | 'failed';
  generatedAt: string;
  loading?: { resume: string; retryAfterMs: number };
  period: { from: string; to: string; timezone: 'Europe/Paris' };
  /** `campaign` conserve le paramètre de coque ; `meta-ad:<id>` désigne une publicité par sa première origine A. */
  filters: { source: SourceFilter; campaign: string; includeTests: boolean };
  availableAds: { id: string; label: string }[];
  stages: VisualJourneyStage[];
  page: {
    visitors: VisualJourneyMetric;
    sections: { id: string; label: string; visitors: VisualJourneyMetric }[];
    cta: VisualJourneyMetric;
    ctaPlacements: { id: string; label: string; visitors: VisualJourneyMetric }[];
  };
  form: {
    opened: VisualJourneyMetric;
    started: VisualJourneyMetric;
    registered: VisualJourneyMetric;
    rates: { startedFromOpened: VisualJourneyRate; registeredFromStarted: VisualJourneyRate };
  };
  video: {
    durationSeconds: number | null;
    durationAvailability: VisualJourneyAvailability;
    started: VisualJourneyMetric;
    thresholds: { seconds: number; visitors: number | null; fromStarted: VisualJourneyRate }[];
    finished: VisualJourneyMetric;
  };
  booking: {
    clicked: VisualJourneyMetric;
    calendar: VisualJourneyMetric;
    booked: VisualJourneyMetric;
    rates: { calendarFromClicked: VisualJourneyRate; bookedFromCalendar: VisualJourneyRate };
  };
  freshness: Record<VisualJourneySource, {
    observedAt: string | null;
    coveredThrough: string | null;
    status: 'available' | 'stale' | 'running' | 'failed' | 'missing';
    reason: string | null;
  }>;
  coverage: {
    browserVisitors: number | null;
    browserSessions: number | null;
    registrations: number | null;
    registrationsWithVisitor: number | null;
    registrationsWithSession: number | null;
    registrationsWithoutBrowserIdentity: number | null;
    appointments: number | null;
    appointmentsLinkedToPerson: number | null;
    testsIncluded: boolean;
  };
  limits: string[];
  safeError?: string;
}
