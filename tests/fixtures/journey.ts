import type { JourneyReport } from '../../src/lib/journey-contract';
export function journeyFixture(): JourneyReport {
  const missing = { available: false, reason: 'Signal absent sur cette version.' };
  const available = { available: true, reason: null };
  const missingMetric = { ...missing, value: null };
  const distribution = { ...available, sessions: 4, averageSeconds: 125, p50Seconds: 100, p75Seconds: 170, p90Seconds: 210 };
  return {
    source: 'posthog', connectorVersion: 'synthetic-fixture', status: 'complete', observedAt: '2026-09-17T14:00:00Z',
    scope: { from: '2026-09-17', to: '2026-09-17', timezone: 'Europe/Paris', tunnel: 'masterclass', source: 'all', campaign: '', includeTests: false, version: null },
    availableVersions: ['mc-fixture-2026-09-17.1'],
    steps: [
      { id: 'visit', label: 'Visite de la page', count: 12, unit: 'sessions', availability: available, fromPrevious: null },
      { id: 'registered', label: 'Inscription confirmée', count: 5, unit: 'sessions', availability: available, fromPrevious: { previousStepId: 'visit', pairedSessions: 4, eligibleSessions: 12, rate: 1 / 3, availability: available } },
      { id: 'video', label: 'Vidéo lancée', count: 4, unit: 'sessions', availability: available, fromPrevious: { previousStepId: 'registered', pairedSessions: 4, eligibleSessions: 5, rate: .8, availability: available } },
      { id: 'booking_click', label: 'Clic pour réserver', count: null, unit: 'sessions', availability: missing, fromPrevious: { previousStepId: 'video', pairedSessions: null, eligibleSessions: null, rate: null, availability: missing } },
      { id: 'booked', label: 'Rendez-vous confirmé', count: 0, unit: 'sessions', availability: available, fromPrevious: { previousStepId: 'booking_click', pairedSessions: null, eligibleSessions: null, rate: null, availability: missing } },
    ],
    sections: [{ id: 'hero', label: 'Présentation', sessions: 12 }, { id: 'questions', label: 'Questions fréquentes', sessions: 3 }],
    questions: [1, 2].map(number => ({ number, reached: missingMetric, answered: { ...available, value: 2 }, abandoned: missingMetric })),
    video: { availability: available, availableVideoVariants: [{ version: 'mc-fixture-2026-09-17.1', videoId: 'fixture-video' }], selectedVideoId: 'fixture-video', durationSeconds: { ...available, value: 600 }, startedSessions: { ...available, value: 4 }, bookedAfterStart: { ...available, value: 0 }, milestones: [{ percent: 25, sessions: 3 }, { percent: 50, sessions: 2 }, { percent: 75, sessions: 1 }, { percent: 100, sessions: 0 }], lastObservedPosition: { availability: available, label: 'Dernière position observée', buckets: [{ fromSeconds: 0, toSeconds: 60, sessions: 1 }, { fromSeconds: 60, toSeconds: 120, sessions: 2 }, { fromSeconds: 120, toSeconds: 180, sessions: 1 }] }, uniqueContentSeconds: distribution, foregroundPlayedSeconds: distribution, exactUniqueVisibleSeconds: { ...missing, sessions: null, averageSeconds: null, p50Seconds: null, p75Seconds: null, p90Seconds: null } },
    coverage: { queryComplete: true, queriedEvents: 100, includedEvents: 80, includedSessions: 12, eventsWithSessionIdentity: 75, eventsMissingSessionIdentity: 5, identifiableTestEvents: 20, testsIncluded: false, unversionedSessions: 0, firstObservedAt: '2026-09-17T10:00:00Z', lastObservedAt: '2026-09-17T13:59:00Z', reason: 'Données synthétiques de test.' }, notices: ['Données synthétiques de test.'],
  };
}
