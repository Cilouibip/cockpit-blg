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

export type VisualJourneyQueryOutcome = 'complete' | 'pending' | 'failed';

/** Mesure technique de la lecture PostHog en direct : durées et statuts seulement,
 * jamais d'identifiant de visiteur, de requête ou de secret. */
export interface VisualJourneyPostHogTiming {
  /** complete : les deux requêtes ont rendu ; pending : au moins une attend encore ;
   * failed : une requête, ou le contrôle de son résultat, a échoué ; not_configured : aucune requête envoyée. */
  outcome: VisualJourneyQueryOutcome | 'not_configured';
  /** Millisecondes entre la première soumission de la requête la plus ancienne et la fin de cet appel. */
  elapsedMs: number | null;
  /** Vrai quand cet appel reprend des requêtes déjà soumises, sans nouveau calcul demandé. */
  resumed: boolean;
  periodDays: number;
  queries: Record<'identity' | 'overview', {
    outcome: VisualJourneyQueryOutcome;
    /** Depuis la soumission initiale jusqu'à l'issue observée dans cet appel (borne haute pour un résultat relu). */
    elapsedMs: number;
    /** Valeur `is_cached` renvoyée par PostHog ; null si absente ou sans résultat. */
    cached: boolean | null;
    /** Âge du résultat en cache (`last_refresh`) au moment de la lecture ; null hors cache. */
    cacheAgeMs: number | null;
  }> | null;
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
    /** Same people as booked.count; returned only by the authenticated cockpit route. */
    people?: {
      name: string;
      originLabel: string;
      appointments: { id: string; bookedAt: string | null; scheduledAt: string | null; status: string }[];
    }[];
    rates: { calendarFromClicked: VisualJourneyRate; bookedFromCalendar: VisualJourneyRate };
  };
  freshness: Record<VisualJourneySource, {
    observedAt: string | null;
    coveredThrough: string | null;
    /** `unfinished` est posé uniquement par le navigateur quand il cesse d'attendre
     * une lecture `running` ; le serveur ne le renvoie jamais. */
    status: 'available' | 'stale' | 'running' | 'unfinished' | 'failed' | 'missing';
    reason: string | null;
  }>;
  timing?: { posthog: VisualJourneyPostHogTiming };
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
