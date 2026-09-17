export type JourneyTunnel = 'quiz' | 'masterclass';
export type JourneySource = 'all' | 'paid' | 'organic' | 'unknown';
export type JourneyStatus = 'not_configured' | 'complete' | 'empty' | 'failed';

export interface JourneyScope {
  from: string;
  to: string;
  timezone: 'Europe/Paris';
  tunnel: JourneyTunnel;
  source: JourneySource;
  campaign: string;
  includeTests: boolean;
  version: string | null;
}

export interface JourneyAvailability {
  available: boolean;
  reason: string | null;
}

export interface JourneyMetric extends JourneyAvailability {
  value: number | null;
}

export interface JourneyStep {
  id: string;
  label: string;
  /** Distinct instrumented journey sessions, never CRM people. */
  count: number | null;
  unit: 'sessions';
  availability: JourneyAvailability;
  /** Conversion only when both events occur in order in the same session. */
  fromPrevious: null | {
    previousStepId: string;
    pairedSessions: number | null;
    eligibleSessions: number | null;
    rate: number | null;
    availability: JourneyAvailability;
  };
}

export interface JourneySection {
  id: string;
  label: string;
  sessions: number;
}

export interface JourneyQuestion {
  number: number;
  reached: JourneyMetric;
  answered: JourneyMetric;
  /** Sessions that reached the question without an observed answer in that same session. */
  abandoned: JourneyMetric;
}

export interface JourneyVideoDistribution extends JourneyAvailability {
  sessions: number | null;
  averageSeconds: number | null;
  p50Seconds: number | null;
  p75Seconds: number | null;
  p90Seconds: number | null;
}

export interface JourneyVideoReport {
  availability: JourneyAvailability;
  /** Report remains unavailable when more than one video/version variant is selected. */
  availableVideoVariants: Array<{ version: string; videoId: string }>;
  selectedVideoId: string | null;
  durationSeconds: JourneyMetric;
  startedSessions: JourneyMetric;
  /** Ordered mc_video_start -> mc_booking_confirmed in the same session. */
  bookedAfterStart: JourneyMetric;
  milestones: Array<{ percent: 25 | 50 | 75 | 100; sessions: number }>;
  /** Position of the last received observation. A seek can move it forward. */
  lastObservedPosition: {
    availability: JourneyAvailability;
    label: 'Dernière position observée';
    buckets: Array<{ fromSeconds: number; toSeconds: number | null; sessions: number }>;
  };
  /** Union of content positions reported by the public player; background play may be included. */
  uniqueContentSeconds: JourneyVideoDistribution;
  /** Foreground playback duration; replays may be counted more than once. */
  foregroundPlayedSeconds: JourneyVideoDistribution;
  exactUniqueVisibleSeconds: JourneyVideoDistribution;
}

export interface JourneyCoverage {
  queryComplete: boolean;
  queriedEvents: number | null;
  includedEvents: number | null;
  includedSessions: number | null;
  eventsWithSessionIdentity: number | null;
  eventsMissingSessionIdentity: number | null;
  identifiableTestEvents: number | null;
  testsIncluded: boolean;
  unversionedSessions: number | null;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  reason: string;
}

export interface JourneyReport {
  source: 'posthog';
  connectorVersion: string;
  status: JourneyStatus;
  safeError?: string;
  observedAt: string | null;
  scope: JourneyScope;
  availableVersions: string[];
  steps: JourneyStep[];
  sections: JourneySection[];
  questions: JourneyQuestion[];
  video: JourneyVideoReport;
  coverage: JourneyCoverage;
  notices: string[];
}
