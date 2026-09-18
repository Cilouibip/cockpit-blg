import type { VisualJourneyProjectionInput } from '../../src/lib/visual-journey-report';

const NOW = '2026-09-18T12:00:00Z';
export const VISITOR_A = '00000000-0000-4000-8000-000000000001';
export const VISITOR_B = '00000000-0000-4000-8000-000000000002';
export const AD_A = '120200000000000001';
export const AD_B = '120200000000000002';

export function visualJourneyFixture(): VisualJourneyProjectionInput {
  return {
    from: '2026-09-18', to: '2026-09-18', source: 'all', campaign: 'all', includeTests: false, generatedAt: NOW,
    browser: [
      {
        browserId: 'browser-a', visitorId: VISITOR_A, sessionId: 'session-a1', firstSeenAt: '2026-09-18T08:00:00Z', lastSeenAt: '2026-09-18T08:20:00Z',
        origin: { source: 'facebook', medium: 'paid_social', campaign: 'campaign-a', ad: AD_A }, explicitTest: false,
        pageAt: '2026-09-18T08:00:00Z', ctaAt: '2026-09-18T08:02:00Z', formOpenAt: '2026-09-18T08:03:00Z', formStartAt: '2026-09-18T08:04:00Z',
        videoStartAt: '2026-09-18T08:07:00Z', bookingClickAt: '2026-09-18T08:19:00Z', bookingOpenAt: '2026-09-18T08:20:00Z',
        uniqueWatchedSeconds: 210, durationSeconds: 600, finishedAt: null, sections: ['hero', 'programme'], ctaPlacements: ['hero'],
      },
      // Retour explicite du même visiteur : une personne, pas deux visites additionnées.
      {
        browserId: 'browser-a', visitorId: VISITOR_A, sessionId: 'session-a2', firstSeenAt: '2026-09-18T09:00:00Z', lastSeenAt: '2026-09-18T09:05:00Z',
        origin: { source: 'direct' }, explicitTest: false,
        pageAt: '2026-09-18T09:00:00Z', ctaAt: null, formOpenAt: null, formStartAt: null, videoStartAt: '2026-09-18T09:01:00Z',
        bookingClickAt: null, bookingOpenAt: null, uniqueWatchedSeconds: 45, durationSeconds: 600, finishedAt: null, sections: ['hero'], ctaPlacements: [],
      },
      {
        browserId: 'browser-b', visitorId: VISITOR_B, sessionId: 'session-b', firstSeenAt: '2026-09-18T10:00:00Z', lastSeenAt: '2026-09-18T10:05:00Z',
        origin: { source: 'facebook', medium: 'paid_social', campaign: 'campaign-b', ad: AD_B }, explicitTest: false,
        pageAt: '2026-09-18T10:00:00Z', ctaAt: '2026-09-18T10:01:00Z', formOpenAt: '2026-09-18T10:02:00Z', formStartAt: '2026-09-18T10:03:00Z',
        videoStartAt: null, bookingClickAt: null, bookingOpenAt: null, uniqueWatchedSeconds: null, durationSeconds: null, finishedAt: null, sections: ['hero'], ctaPlacements: ['programme'],
      },
      {
        browserId: 'browser-test', visitorId: '00000000-0000-4000-8000-000000000099', sessionId: 'session-test', firstSeenAt: '2026-09-18T11:00:00Z', lastSeenAt: '2026-09-18T11:01:00Z',
        origin: { source: 'test', medium: 'recette', campaign: 'test-mehdi-reader' }, explicitTest: true,
        pageAt: '2026-09-18T11:00:00Z', ctaAt: null, formOpenAt: null, formStartAt: null, videoStartAt: null,
        bookingClickAt: null, bookingOpenAt: null, uniqueWatchedSeconds: null, durationSeconds: null, finishedAt: null, sections: [], ctaPlacements: [],
      },
    ],
    registrations: [
      {
        id: 'registration-a', personId: 'person-a', identityState: 'linked', occurredAt: '2026-09-18T08:06:00Z', publishedAt: '2026-09-18T08:10:00Z',
        origin: { visitor: VISITOR_A, session: 'session-a1', source: 'facebook', medium: 'paid_social', campaign: 'campaign-b', ad: AD_B },
        firstTouch: { source: 'facebook', medium: 'paid_social', campaign: 'campaign-a', ad: AD_A, at: '2026-09-18T08:00:00Z' },
      },
      // Même personne et même confirmation répétée : elle reste une seule inscrite.
      {
        id: 'registration-a-repeat', personId: 'person-a', identityState: 'linked', occurredAt: '2026-09-18T08:06:30Z', publishedAt: '2026-09-18T08:10:00Z',
        origin: { visitor: VISITOR_A, session: 'session-a1', source: 'facebook', medium: 'paid_social', campaign: 'campaign-b', ad: AD_B },
        firstTouch: { source: 'facebook', medium: 'paid_social', campaign: 'campaign-a', ad: AD_A, at: '2026-09-18T08:00:00Z' },
      },
      // Confirmation Wix sans aucun signal navigateur : elle compte dans le total métier.
      {
        id: 'registration-offline', personId: 'person-offline', identityState: 'linked', occurredAt: '2026-09-18T10:30:00Z', publishedAt: '2026-09-18T10:31:00Z',
        origin: { source: 'direct' }, firstTouch: null,
      },
    ],
    appointments: [
      // La date prévue n'est volontairement pas utilisée comme date de réservation.
      { id: 'appointment-a', personId: 'person-a', bookedAt: null, status: 'unknown', observedAt: '2026-09-17T23:35:39Z' },
    ],
    availableAds: [{ id: `meta-ad:${AD_A}`, label: 'Publicité A' }, { id: `meta-ad:${AD_B}`, label: 'Publicité B' }],
    freshness: {
      posthog: { observedAt: NOW, coveredThrough: '2026-09-18T11:01:00Z', status: 'available', reason: null },
      wix: { observedAt: '2026-09-18T10:31:00Z', coveredThrough: '2026-09-18T10:31:00Z', status: 'available', reason: null },
      appointments: { observedAt: '2026-09-17T23:35:39Z', coveredThrough: '2026-09-17T23:35:39Z', status: 'stale', reason: "Le miroir des rendez-vous n'a pas été actualisé depuis plus de six heures." },
    },
  };
}
