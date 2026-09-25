import test from 'node:test';
import assert from 'node:assert/strict';
import { journeyQueries, readJourneyAnalytics, type JourneyAnalyticsConfig } from '../src/connectors/journey-analytics';
import { EXCLUDED_TEST_SESSION_IDS } from '../src/lib/traffic-scope';

const columns = {
  overview: ['queried_events','included_events','included_sessions','events_with_session_id','events_missing_session_id','identifiable_test_events','unversioned_sessions','first_observed_at','last_observed_at'],
  steps: ['journey_version','step_event','sessions','paired_sessions','eligible_sessions'],
  questions: ['journey_version','question_number','reached','answered','abandoned','reached_events','answered_events'],
  video: ['journey_version','video_id','started_sessions','booked_after_start','duration_seconds','m25','m50','m75','m100','unique_sessions','unique_average','unique_p50','unique_p75','unique_p90','visible_sessions','visible_average','visible_p50','visible_p75','visible_p90'],
  breakdown: ['kind','journey_version','item','bucket','sessions'],
} as const;

type QueryName = keyof typeof columns;
const response = (name: QueryName, results: unknown[][]) => ({ columns: columns[name], results, query_status: { complete: true } });
const baseConfig: JourneyAnalyticsConfig = {
  host: 'https://eu.posthog.com', projectId: '123', personalApiKey: 'secret',
  from: '2026-09-01', to: '2026-09-17', tunnel: 'masterclass', source: 'all', campaign: '', includeTests: false,
  now: () => '2026-09-17T16:00:00Z',
};

function fetcher(fixtures: Partial<Record<QueryName, unknown>>) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (init?.method === 'GET') return Response.json({ id: 123 });
    const body = JSON.parse(String(init?.body)) as { name: string };
    const name = body.name.replace('BLG journey aggregate ', '') as QueryName;
    const payload = fixtures[name] ?? response(name, []);
    return Response.json(payload);
  };
}

test('les requetes ferment le perimetre, excluent la recette et groupent d abord par sid', () => {
  const excluded = journeyQueries(baseConfig), included = journeyQueries({ ...baseConfig, includeTests: true });
  assert.match(excluded.overview, /page_path/);
  assert.match(excluded.overview, /\/masterclass26/);
  assert.match(excluded.overview, /page_id[^\n]+blg-rugby-mc/);
  assert.match(excluded.overview, /environment[^\n]+production/);
  assert.match(excluded.overview, /host[^\n]+ = '' OR/);
  assert.match(excluded.overview, /test-mehdi/);
  assert.match(excluded.overview, /utm_medium[^\n]+recette/);
  assert.match(excluded.steps, /GROUP BY journey_session, journey_version/);
  assert.match(excluded.steps, /eligible_sessions AS[\s\S]+GROUP BY journey_session HAVING[\s\S]+max\(if\([\s\S]+test-mehdi/);
  for(const sid of EXCLUDED_TEST_SESSION_IDS)assert.match(excluded.steps,new RegExp(sid));
  assert.match(excluded.steps, /sid\), ''\) IN \(SELECT journey_session FROM eligible_sessions\)/, 'le marqueur porte sur la session puis toutes ses etapes restent eligibles');
  assert.match(excluded.steps, /last_t1 >= first_t0/);
  assert.ok((excluded.overview.match(/test-mehdi/g)?.length ?? 0) > (included.overview.match(/test-mehdi/g)?.length ?? 0), 'inclure les tests retire seulement leur exclusion ; le compteur de couverture reste present');
  assert.match(excluded.video, /maxIf\([^\n]*unique_watched_seconds/);
  assert.match(excluded.video, /GROUP BY journey_session, journey_version\)/, 'la reservation sans video_id reste rattachee au sid avant le regroupement video');
  assert.match(excluded.questions, /AS reached/);
  assert.match(excluded.questions, /countIf\(reached_flag > 0 AND answered_flag = 0\) AS abandoned/);
  assert.match(excluded.video, /AS booked_after_start/);
  assert.match(excluded.video, /WHERE video_event_count > 0/);
  assert.match(excluded.breakdown, /argMaxIf\([^\n]*position_seconds/);
  assert.match(excluded.breakdown, /started_at > toDateTime\(0\) AND observations > 0/);
  assert.throws(() => journeyQueries({ ...baseConfig, campaign: 'meta-creative:42' }), { message: 'POSTHOG_SCOPE_UNAVAILABLE' });
  assert.match(journeyQueries({ ...baseConfig, campaign: 'meta:1234567890' }).overview, /1234567890/);
  assert.match(journeyQueries({ ...baseConfig, campaign: 'meta-ad:9876543210' }).overview, /9876543210/);
  assert.match(journeyQueries({ ...baseConfig, campaign: "rentree\\rugby'26" }).overview, /rentree\\\\rugby''26/);
  assert.throws(() => journeyQueries({ ...baseConfig, from: '2026-09-18', to: '2026-09-17' }), { message: 'INVALID_PERIOD' });
});

test('la masterclass conserve paliers, seeks, temps vus et vraie chaine sequentielle', async () => {
  const fixtures = {
    overview: response('overview', [[48,44,8,44,1,3,0,'2026-09-10T08:00:00Z','2026-09-17T15:00:00Z']]),
    steps: response('steps', [
      ['mc-wix-access-2026-09-17.1','mc_page_view',8,8,8],
      ['mc-wix-access-2026-09-17.1','mc_optin_submit',5,4,6],
      ['mc-wix-access-2026-09-17.1','mc_optin_recorded',4,4,5],
      ['mc-wix-access-2026-09-17.1','mc_video_start',4,3,4],
      ['mc-wix-access-2026-09-17.1','mc_booking_confirmed',2,1,2],
    ]),
    questions: response('questions', []),
    video: response('video', [[
      'mc-wix-access-2026-09-17.1','future-masterclass',4,1,437,
      4,3,2,1,4,40,36,48,60,4,55,50,65,80,
    ]]),
    breakdown: response('breakdown', [
      ['section','mc-wix-access-2026-09-17.1','hero',0,8],
      ['section','mc-wix-access-2026-09-17.1','preuves',0,6],
      ['stop','mc-wix-access-2026-09-17.1','future-masterclass',30,1],
      ['stop','mc-wix-access-2026-09-17.1','future-masterclass',120,2],
      ['stop','mc-wix-access-2026-09-17.1','future-masterclass',420,1],
    ]),
  };
  const report = await readJourneyAnalytics({ ...baseConfig, fetcher: fetcher(fixtures) });
  assert.equal(report.status, 'complete');
  assert.equal(report.coverage.includedSessions, 8);
  assert.equal(report.coverage.eventsMissingSessionIdentity, 1);
  assert.equal(report.coverage.identifiableTestEvents, 3);
  assert.equal(report.steps.find(step => step.id === 'video_started')?.count, 4);
  assert.deepEqual(report.steps.find(step => step.id === 'video_started')?.fromPrevious, {
    previousStepId: 'optin_recorded', pairedSessions: 3, eligibleSessions: 4, rate: 0.75,
    availability: { available: true, reason: null },
  });
  assert.equal(report.video.bookedAfterStart.value, 1);
  assert.deepEqual(report.video.milestones, [{percent:25,sessions:4},{percent:50,sessions:3},{percent:75,sessions:2},{percent:100,sessions:1}]);
  assert.equal(report.video.uniqueContentSeconds.averageSeconds, 40, 'les positions uniques restent distinctes de la position finale apres seek');
  assert.equal(report.video.foregroundPlayedSeconds.averageSeconds, 55, 'les relectures visibles restent une autre mesure');
  assert.deepEqual(report.video.lastObservedPosition.buckets[1], { fromSeconds: 120, toSeconds: 135, sessions: 2 });
  assert.equal(report.video.exactUniqueVisibleSeconds.available, false);
  assert.deepEqual(report.sections.map(section => section.sessions), [8,6]);
});

test('le quiz ne fabrique ni question vue, ni abandon, ni cohorte booking quand le signal manque', async () => {
  const quiz = { ...baseConfig, tunnel: 'quiz' as const };
  const fixtures = {
    overview: response('overview', [[30,28,6,28,0,2,6,'2026-09-12T08:00:00Z','2026-09-15T12:00:00Z']]),
    steps: response('steps', [
      ['unversioned','$pageview',6,6,6],
      ['unversioned','quiz_demarre',5,5,6],
      ['unversioned','ecran_coordonnees',3,3,5],
      ['unversioned','rendezvous_confirme',1,0,0],
    ]),
    questions: response('questions', [
      ['unversioned',1,0,5,0,0,5],
      ['unversioned',2,0,4,0,0,4],
    ]),
    video: response('video', []), breakdown: response('breakdown', []),
  };
  const report = await readJourneyAnalytics({ ...quiz, fetcher: fetcher(fixtures) });
  assert.equal(report.questions[0].reached.value, null);
  assert.equal(report.questions[0].answered.value, 5);
  assert.equal(report.questions[0].abandoned.value, null);
  assert.equal(report.steps.find(step => step.id === 'booking_click')?.count, null);
  const booking = report.steps.find(step => step.id === 'booking_confirmed')!;
  assert.equal(booking.count, 1, 'la confirmation recue reste visible comme volume');
  assert.equal(booking.fromPrevious?.pairedSessions, null, 'aucune conversion n est inferee sans clic intermediaire');
  assert.match(booking.fromPrevious?.availability.reason ?? '', /aucune cohorte/);
  assert.equal(report.video.availability.available, false);
});

test('l abandon question compte les memes sid plutot que soustraire deux totaux independants', async () => {
  const fixtures = {
    overview: response('overview', [[4,4,2,4,0,0,2,'2026-09-12T08:00:00Z','2026-09-12T08:05:00Z']]),
    steps: response('steps', [['unversioned','$pageview',2,2,2]]),
    // Un sid a vu sans repondre ; un autre a repondu sans signal de vue.
    questions: response('questions', [['unversioned',1,1,1,1,1,1]]),
    video: response('video', []), breakdown: response('breakdown', []),
  };
  const report = await readJourneyAnalytics({ ...baseConfig, tunnel: 'quiz', fetcher: fetcher(fixtures) });
  assert.equal(report.questions[0].reached.value, 1);
  assert.equal(report.questions[0].answered.value, 1);
  assert.equal(report.questions[0].abandoned.value, 1, '1 - 1 aurait fabrique zero malgré la tentative abandonnee');
});

test('les versions restent separees et une limite amont rend tout le rapport indisponible', async () => {
  const variants = {
    overview: response('overview', [[20,20,4,20,0,0,0,'2026-09-12T08:00:00Z','2026-09-15T12:00:00Z']]),
    steps: response('steps', [['legacy-v1','mc_page_view',2,2,2],['new-v2','mc_page_view',2,2,2]]),
    questions: response('questions', []),
    video: response('video', [
      ['legacy-v1','old-video',1,0,400,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
      ['new-v2','new-video',1,0,437,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    ]),
    breakdown: response('breakdown', []),
  };
  const mixed = await readJourneyAnalytics({ ...baseConfig, fetcher: fetcher(variants) });
  assert.equal(mixed.steps[0].count, null);
  assert.equal(mixed.video.availability.available, false);
  assert.deepEqual(mixed.availableVersions, ['legacy-v1','new-v2']);
  assert.match(mixed.notices[0], /Plusieurs versions/);

  const limited = { ...variants, steps: { ...response('steps', []), hasMore: true } };
  const failed = await readJourneyAnalytics({ ...baseConfig, fetcher: fetcher(limited) });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.safeError, 'POSTHOG_RESULT_LIMIT');
  assert.equal(failed.coverage.queryComplete, false);
  assert.deepEqual(failed.steps, []);
  assert.equal(failed.video.availability.available, false);
  assert.equal(failed.video.startedSessions.value, null);
});

test('une variante video multiple ou sans identifiant ne fabrique jamais un axe temps', async () => {
  for (const videoId of ['multiple','unknown']) {
    const fixtures = {
      overview: response('overview', [[8,8,1,8,0,0,0,'2026-09-12T08:00:00Z','2026-09-12T08:05:00Z']]),
      steps: response('steps', [['new-v2','mc_page_view',1,1,1],['new-v2','mc_video_start',1,0,0]]),
      questions: response('questions', []),
      video: response('video', [['new-v2',videoId,1,0,437,0,0,0,0,1,10,10,10,10,1,10,10,10,10]]),
      breakdown: response('breakdown', [['stop','new-v2',videoId,15,1]]),
    };
    const report = await readJourneyAnalytics({ ...baseConfig, version: 'new-v2', fetcher: fetcher(fixtures) });
    assert.equal(report.video.availability.available, false);
    assert.equal(report.video.startedSessions.value, null);
    assert.deepEqual(report.video.lastObservedPosition.buckets, []);
  }
});

test('un périmètre vide laisse les étapes et la courbe vidéo indisponibles', async () => {
  const fixtures = {
    overview: response('overview', [[0,0,0,0,0,0,0,null,null]]),
    steps: response('steps', []), questions: response('questions', []), video: response('video', []), breakdown: response('breakdown', []),
  };
  const report = await readJourneyAnalytics({ ...baseConfig, fetcher: fetcher(fixtures) });
  assert.equal(report.status, 'empty');
  assert.equal(report.coverage.includedSessions, 0);
  assert.equal(report.steps.find(step => step.id === 'page_view')?.count, null);
  assert.equal(report.steps.find(step => step.id === 'page_view')?.availability.available, false);
  assert.equal(report.video.startedSessions.value, null);
  assert.equal(report.video.lastObservedPosition.availability.available, false);
  assert.match(report.notices.join(' '), /ne prouve pas/);
});

test('des evenements sans sid ne deviennent jamais des zeros de parcours disponibles', async () => {
  const fixtures = {
    overview: response('overview', [[7,0,0,0,7,0,0,null,null]]),
    steps: response('steps', []), questions: response('questions', []), video: response('video', []), breakdown: response('breakdown', []),
  };
  const report = await readJourneyAnalytics({ ...baseConfig, fetcher: fetcher(fixtures) });
  assert.equal(report.status, 'empty');
  assert.equal(report.steps[0].count, null);
  assert.equal(report.steps[0].availability.available, false);
  assert.equal(report.video.startedSessions.value, null);
  assert.match(report.coverage.reason, /sans sid/);
});
