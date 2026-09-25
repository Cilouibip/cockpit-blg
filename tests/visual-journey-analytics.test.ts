import test from 'node:test';
import assert from 'node:assert/strict';
import type { Database, Row, SelectOptions, TableName } from '../src/lib/db';
import { readVisualJourneyReport, sourceFreshness, visualJourneyQueries } from '../src/connectors/visual-journey-analytics';
import { VISUAL_JOURNEY_FORM_ID } from '../src/lib/visual-journey-report';
import { EXCLUDED_TEST_SESSION_IDS } from '../src/lib/traffic-scope';

const SITE = 'synthetic-site';
const VISITOR = '00000000-0000-4000-8000-000000000011';
const AD = '120200000000000011';
const NOW = '2026-09-18T12:00:00Z';
const identityColumns = ['browser_id','visitor_id','sid','first_seen_at','last_seen_at','first_source','first_medium','first_campaign','first_ad','first_link','is_test','page_at','cta_at','form_open_at','form_start_at','video_start_at','booking_click_at','booking_open_at','unique_seconds','unique_observations','duration_seconds','duration_observations','finished_at','sections','cta_placements'];

function dbStub() {
  const calls: { table: TableName; options?: SelectOptions }[] = [];
  const registration: Row = {
    id: 'registration', source_namespace: SITE, source_container_id: VISUAL_JOURNEY_FORM_ID, family: 'forms', is_current: true,
    source_status: 'CONFIRMED', eligible: true, person_id: 'person', identity_state: 'linked', occurred_at: '2026-09-18T08:06:00Z', published_at: '2026-09-18T08:10:00Z',
    properties: { origin: { visitor: VISITOR, session: 'session', source: 'facebook', medium: 'paid_social', ad: AD }, firstTouch: { source: 'facebook', medium: 'paid_social', ad: AD, at: '2026-09-18T08:00:00Z' } },
  };
  const db: Database = {
    async select(table, options) {
      calls.push({ table, options });
      if (table === 'lead_source_observations') return [registration];
      if (table === 'appointments') return [{ id: 'appointment', prospect_id: 'prospect', status: 'unknown', scheduled_day: '2026-09-20', booked_at: null, observed_at: '2026-09-17T23:35:39Z' }];
      if (table === 'prospects') return [{ id: 'prospect', person_id: 'person' }];
      if (table === 'ads') return [{ external_id: AD, ad_name: 'Publicité synthétique' }];
      if (table === 'sync_runs') {
        const stream = options?.eq?.stream_key;
        return stream === 'prospects_business'
          ? [{ status: 'complete', finished_at: '2026-09-17T23:35:39Z', covered_to: '2026-09-17T23:35:39Z' }]
          : [{ source:'wix',stream_key:'lead_entries_forms',status: 'complete', pagination_complete:true, started_at:'2026-09-18T11:45:00Z',finished_at: '2026-09-18T11:50:00Z', period_to: '2026-09-18T11:45:00Z' }];
      }
      return [];
    },
    async upsert() { assert.fail('lecture seule'); },
    async rpc() { assert.fail('lecture sans RPC'); },
    async probe() { assert.fail('aucune sonde mutante'); },
  };
  return { db, calls };
}

const posthogFetch: typeof fetch = async (_input, init) => {
  const body = JSON.parse(String(init?.body)) as { query: { query: string } };
  if (body.query.query.includes('AS browser_id')) return new Response(JSON.stringify({
    columns: identityColumns,
    results: [[
      'posthog-browser-not-used-for-wix', VISITOR, 'session', '2026-09-18T08:00:00Z', '2026-09-18T08:20:00Z',
      'facebook', 'paid_social', 'campaign', AD, '', 0,
      '2026-09-18T08:00:00Z', '2026-09-18T08:02:00Z', '2026-09-18T08:03:00Z', '2026-09-18T08:04:00Z', '2026-09-18T08:07:00Z',
      '2026-09-18T08:19:00Z', '2026-09-18T08:20:00Z', 210, 2, 600, 2, null, ['hero'], ['hero'],
    ]],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify({ columns: ['queried_events','missing_identity_events','first_observed_at','last_observed_at'], results: [[12, 0, '2026-09-18T08:00:00Z', '2026-09-18T08:20:00Z']] }), { status: 200, headers: { 'content-type': 'application/json' } });
};

test('les requêtes utilisent blg_vid, la durée unique et les placements sans position interpolée', () => {
  const queries = visualJourneyQueries({ from: '2026-09-18', to: '2026-09-18' });
  assert.match(queries.identity, /properties\.visitor_id/);
  assert.match(queries.identity, /unique_watched_seconds/);
  assert.match(queries.identity, /properties\.placement/);
  assert.doesNotMatch(queries.identity, /position_seconds/);
  assert.doesNotMatch(queries.identity, /page_version =/);
  assert.match(queries.identity, /GROUP BY browser_id, visitor_id, sid/);
  for(const sid of EXCLUDED_TEST_SESSION_IDS)assert.match(queries.identity,new RegExp(sid));
});

test('le lecteur joint visitor_id à Wix, conserve le RDV lié et reste strictement en lecture seule', async () => {
  const { db, calls } = dbStub();
  const report = await readVisualJourneyReport(db, {
    host: 'https://eu.posthog.com', projectId: '123', personalApiKey: 'synthetic', fetcher: posthogFetch,
    wixSiteId: SITE, syncEnv, from: '2026-09-18', to: '2026-09-18', source: 'all', campaign: 'all', includeTests: false, now: () => NOW,
  });
  assert.deepEqual(report.stages.map(stage => stage.count), [1, 1, 1, 1, 1]);
  assert.equal(report.stages[3].fromPrevious?.rate, 1, 'le distinct_id différent ne casse pas le lien blg_vid explicite');
  assert.equal(report.stages[4].fromPrevious?.available, false, 'scheduled_at ne remplace pas booked_at');
  assert.equal(report.page.ctaPlacements[0].id, 'hero');
  assert.deepEqual(report.availableAds, [{ id: `meta-ad:${AD}`, label: 'Publicité synthétique' }]);
  const leadRead = calls.find(call => call.table === 'lead_source_observations');
  assert.equal(leadRead?.options?.eq?.is_current, 'true');
  assert.equal(leadRead?.options?.gte, undefined, 'l’origine antérieure à la période reste lisible');
});

test('une inscription CONFIRMED sans navigateur subsiste quand PostHog échoue', async () => {
  const { db } = dbStub();
  const report = await readVisualJourneyReport(db, {
    wixSiteId: SITE, from: '2026-09-18', to: '2026-09-18', source: 'all', campaign: 'all', includeTests: false, now: () => NOW,
  });
  assert.equal(report.form.registered.count, 1);
  assert.equal(report.page.visitors.count, null);
  assert.equal(report.freshness.posthog.status, 'missing');
  assert.equal(report.booking.booked.count, 1, 'le miroir ancien ne masque pas son volume relié');
});

test('le site Wix est obligatoire pour ne jamais lire un autre espace', async () => {
  const previous = process.env.WIX_SITE_ID; delete process.env.WIX_SITE_ID;
  try {
    await assert.rejects(() => readVisualJourneyReport(dbStub().db, { from: '2026-09-18', to: '2026-09-18', source: 'all', campaign: 'all', includeTests: false }), /INVALID_CONFIGURATION/);
  } finally { if (previous === undefined) delete process.env.WIX_SITE_ID; else process.env.WIX_SITE_ID = previous; }
});

test('une erreur Wix ou rendez-vous reste locale et ne supprime pas les autres sources', async () => {
  const wixBase = dbStub().db;
  const wixFailure: Database = { ...wixBase, async select(table, options) { if (table === 'lead_source_observations') throw new Error('synthetic wix failure'); return wixBase.select(table, options); } };
  const withoutWix = await readVisualJourneyReport(wixFailure, {
    host: 'https://eu.posthog.com', projectId: '123', personalApiKey: 'synthetic', fetcher: posthogFetch, wixSiteId: SITE,
    from: '2026-09-18', to: '2026-09-18', source: 'all', campaign: 'all', includeTests: false, now: () => NOW,
  });
  assert.equal(withoutWix.page.visitors.count, 1);
  assert.equal(withoutWix.form.registered.count, null);
  assert.equal(withoutWix.freshness.wix.status, 'failed');

  const appointmentBase = dbStub().db;
  const appointmentFailure: Database = { ...appointmentBase, async select(table, options) { if (table === 'appointments') throw new Error('synthetic appointment failure'); return appointmentBase.select(table, options); } };
  const withoutAppointments = await readVisualJourneyReport(appointmentFailure, {
    host: 'https://eu.posthog.com', projectId: '123', personalApiKey: 'synthetic', fetcher: posthogFetch, wixSiteId: SITE,
    from: '2026-09-18', to: '2026-09-18', source: 'all', campaign: 'all', includeTests: false, now: () => NOW,
  });
  assert.equal(withoutAppointments.page.visitors.count, 1);
  assert.equal(withoutAppointments.form.registered.count, 1);
  assert.equal(withoutAppointments.booking.booked.count, null);
  assert.equal(withoutAppointments.freshness.appointments.status, 'failed');
});

const syncEnv: NodeJS.ProcessEnv = { NODE_ENV: 'test', WIX_SITE_ID: SITE, WIX_API_KEY: 'synthetic', WIX_LEAD_ENTRY_CONFIG: JSON.stringify({formIds:[VISUAL_JOURNEY_FORM_ID]}), NOTION_DATA_SOURCE_ID: 'notion-synthetic' };
const freshRun = {source:'notion',stream_key:'prospects_business',status:'complete',pagination_complete:true,started_at:'2026-09-18T11:45:00Z',finished_at:'2026-09-18T11:50:00Z',period_to:'2026-09-18T11:45:00Z'};
const freshConfig = {wixSiteId:SITE,syncEnv,from:'2026-09-18',to:'2026-09-18',source:'all' as const,campaign:'all',includeTests:false,now:()=>NOW};

test('la fraîcheur suit le cycle publié et sa borne, jamais la fin du long scan ni une fiche inchangée',()=>{
  const longScan={...freshRun,started_at:'2026-09-18T01:00:00Z',period_to:'2026-09-18T01:00:00Z',finished_at:'2026-09-18T11:59:00Z'};
  assert.equal(sourceFreshness([longScan],'notion','prospects_business',NOW,'les rendez-vous').status,'stale');
  const recent=sourceFreshness([freshRun],'notion','prospects_business',NOW,'les rendez-vous');
  assert.equal(recent.status,'available');
  assert.equal(recent.coveredThrough,'2026-09-18T11:45:00.000Z');
  const failed={...freshRun,status:'failed',started_at:'2026-09-18T11:58:00Z',finished_at:'2026-09-18T11:59:00Z'};
  const retained=sourceFreshness([failed,freshRun],'notion','prospects_business',NOW,'les rendez-vous');
  assert.equal(retained.status,'failed');
  assert.equal(retained.observedAt,'2026-09-18T11:50:00.000Z');
});

test('une réservation datée au jour compte sans inventer une heure après la vidéo ; les annulations métier sont exclues',async()=>{
  const base=dbStub().db;let attendance='scheduled';
  const db:Database={...base,async select(table,options){
    if(table==='prospects')return [{id:'prospect',person_id:'person',business:{scheduledDay:'2026-09-20',attendance,bookedDay:'2026-09-18',dates:{booked:'2026-09-18'}}}];
    if(table==='sync_runs')return [freshRun];
    return base.select(table,options);
  }};
  const report=await readVisualJourneyReport(db,{...freshConfig,host:'https://eu.posthog.com',projectId:'123',personalApiKey:'synthetic',fetcher:posthogFetch});
  assert.equal(report.booking.booked.count,1);
  assert.equal(report.stages[4].fromPrevious?.rate,null);
  attendance='cancelled';
  assert.equal((await readVisualJourneyReport(db,freshConfig)).booking.booked.count,0);
});

test('les lectures de fraîcheur sont isolées au bon espace et au profil publié ; les essais serveur restent exclus',async()=>{
  const {db:base,calls}=dbStub();
  const db:Database={...base,async select(table,options){
    const rows=await base.select(table,options);
    return table==='lead_source_observations'?rows.map(row=>({...row,properties:{...row.properties as Row,is_test:true}})):rows;
  }};
  const excluded=await readVisualJourneyReport(db,freshConfig);
  assert.equal(excluded.form.registered.count,0);
  const included=await readVisualJourneyReport(db,{...freshConfig,includeTests:true});
  assert.equal(included.form.registered.count,1);
  const reads=calls.filter(call=>call.table==='sync_runs' && call.options?.eq?.stream_key);
  assert.ok(reads.length>=4);
  for(const {options} of reads){assert.ok(options?.eq?.source_namespace);assert.ok(options?.eq?.query_profile_key);}
  assert.ok(reads.some(call=>call.options?.eq?.pagination_complete==='true'));
});

test('l’origine avant la période suit toutes les étapes sans recompter le formulaire antérieur ni un autre espace',async()=>{
  const base=dbStub().db, adBefore='120200000000000099';
  const db:Database={...base,async select(table,options){
    const rows=await base.select(table,options);if(table!=='lead_source_observations')return rows;
    return [...rows,{...rows[0],id:'earlier',occurred_at:'2026-09-10T08:00:00Z',properties:{origin:{source:'facebook',medium:'paid_social',ad:adBefore}}},
      {...rows[0],id:'wrong-site',person_id:'someone-else',source_namespace:'other-site'},
      {...rows[0],id:'wrong-form',person_id:'someone-else',source_container_id:'other-form'}];
  }};
  const report=await readVisualJourneyReport(db,{...freshConfig,campaign:`meta-ad:${adBefore}`,host:'https://eu.posthog.com',projectId:'123',personalApiKey:'synthetic',fetcher:posthogFetch});
  assert.deepEqual(report.stages.slice(0,4).map(row=>row.count),[1,1,1,1]);
  assert.equal(report.coverage.registrations,1);
  assert.equal(report.form.registered.count,1);
});

test('une panne du miroir commercial ne masque pas les inscriptions confirmées Wix',async()=>{
  const base=dbStub().db;
  const db:Database={...base,async select(table,options){if(table==='prospects')throw Error('synthetic unavailable');return base.select(table,options);}};
  const report=await readVisualJourneyReport(db,freshConfig);
  assert.equal(report.form.registered.count,1);
  assert.equal(report.booking.booked.count,null);
});

test('un calcul long garde Wix/RDV visibles et reprend les deux requêtes sans nouveau POST',async()=>{
 const {db}=dbStub();let resume:import('../src/lib/visual-journey-resume').VisualJourneyContinuation|undefined,ready=false,posts=0;
 const queries=new Map<string,string>();
 const fetcher:typeof fetch=async(input,init)=>{
  const url=new URL(String(input));
  if(init?.method==='POST'){
   posts++;const payload=JSON.parse(String(init.body));const id=payload.client_query_id;assert.ok(id);queries.set(id,payload.query.query);
   return Response.json({query_status:{id,team_id:123,complete:false}},{status:202});
  }
  const id=url.pathname.split('/').filter(Boolean).at(-1)!;assert.ok(queries.has(id));
  if(!ready)return Response.json({query_status:{id,team_id:123,complete:false}});
  const response=await posthogFetch(input,{method:'POST',body:JSON.stringify({query:{query:queries.get(id)}})});return Response.json({...await response.json(),query_status:{id,team_id:123,complete:true}});
 };
 const config={host:'https://eu.posthog.com',projectId:'123',personalApiKey:'synthetic',wixSiteId:SITE,syncEnv,from:'2026-09-18',to:'2026-09-18',source:'all' as const,campaign:'all',includeTests:false,now:()=>NOW,fetcher,sleep:async()=>{},onBrowserContinuation:(state:import('../src/lib/visual-journey-resume').VisualJourneyContinuation)=>{resume=state;}};
 const pending=await readVisualJourneyReport(db,config);
 assert.equal(pending.freshness.posthog.status,'running');assert.equal(pending.form.registered.count,1);assert.equal(pending.booking.booked.count,1);assert.equal(pending.page.visitors.count,null);assert.equal(posts,2);assert.ok(resume?.identity);assert.ok(resume?.overview);
 ready=true;const done=await readVisualJourneyReport(db,{...config,resumeBrowser:resume});
 assert.equal(posts,2);assert.equal(done.page.visitors.count,1);assert.equal(done.video.started.count,1);assert.equal(done.freshness.posthog.status,'available');
});

const PERSONAL = new RegExp([VISITOR, 'posthog-browser-not-used-for-wix', 'session', 'synthetic', AD, 'campaign', '2026-09-18', 'client_query_id', 'Bearer'].join('|'));
function onlyDurationsAndStatuses(value: unknown, path = 'timing'): void {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return;
  if (typeof value === 'string') { assert.ok(['complete', 'pending', 'failed', 'not_configured'].includes(value), `${path} = ${value}`); return; }
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), path);
  for (const [key, item] of Object.entries(value)) {
    assert.ok(['posthog', 'outcome', 'elapsedMs', 'resumed', 'periodDays', 'queries', 'identity', 'overview', 'cached', 'cacheAgeMs'].includes(key), `${path}.${key}`);
    onlyDurationsAndStatuses(item, `${path}.${key}`);
  }
}

test('les deux requêtes du parcours demandent le cache récent (async) et la mesure ne contient que durées et statuts', async () => {
  const { db } = dbStub(), refresh: unknown[] = [], lines: string[] = [];
  const fetcher: typeof fetch = async (input, init) => { refresh.push(JSON.parse(String(init?.body)).refresh); return posthogFetch(input, init); };
  const report = await readVisualJourneyReport(db, { ...freshConfig, host: 'https://eu.posthog.com', projectId: '123', personalApiKey: 'synthetic', fetcher, log: line => lines.push(line) });
  assert.deepEqual(refresh, ['async', 'async']);
  const timing = report.timing?.posthog;
  assert.equal(timing?.outcome, 'complete'); assert.equal(timing?.resumed, false); assert.equal(timing?.periodDays, 1);
  assert.ok(typeof timing?.elapsedMs === 'number' && timing.elapsedMs >= 0);
  assert.equal(timing?.queries?.identity.outcome, 'complete'); assert.equal(timing?.queries?.identity.cached, null);
  assert.equal(report.freshness.posthog.observedAt, report.generatedAt, 'un calcul neuf est daté de cette lecture');
  assert.equal(lines.length, 1); assert.match(lines[0], /^\[parcours\] lecture PostHog \{/);
  assert.doesNotMatch(lines[0], PERSONAL);
  onlyDurationsAndStatuses(JSON.parse(lines[0].slice(lines[0].indexOf('{'))));
  onlyDurationsAndStatuses(report.timing);
});

test('un résultat servi par le cache PostHog garde l’heure de son calcul, pas celle de la lecture', async () => {
  // 920 ms : Temporal écrit « .92Z », la comparaison porte sur l'instant.
  const { db } = dbStub(), refreshedAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 10 * 60_000 + 920).toISOString();
  const fetcher: typeof fetch = async (input, init) => Response.json({ ...await (await posthogFetch(input, init)).json(), is_cached: true, last_refresh: refreshedAt });
  const report = await readVisualJourneyReport(db, { ...freshConfig, host: 'https://eu.posthog.com', projectId: '123', personalApiKey: 'synthetic', fetcher, log: () => {} });
  assert.equal(report.freshness.posthog.status, 'available');
  assert.equal(Date.parse(report.freshness.posthog.observedAt!), Date.parse(refreshedAt));
  const identity = report.timing?.posthog.queries?.identity;
  assert.equal(identity?.cached, true);
  assert.ok(identity?.cacheAgeMs != null && identity.cacheAgeMs >= 9 * 60_000 && identity.cacheAgeMs < 11 * 60_000);
});

test('la durée d’une lecture reprise part de la soumission initiale ; attente, échec et absence de connexion sont distingués', async () => {
  const { db } = dbStub(); let resume: import('../src/lib/visual-journey-resume').VisualJourneyContinuation | undefined, ready = false;
  const queries = new Map<string, string>();
  const fetcher: typeof fetch = async (input, init) => {
    if (init?.method === 'POST') { const payload = JSON.parse(String(init.body)); queries.set(payload.client_query_id, payload.query.query); return Response.json({ query_status: { id: payload.client_query_id, team_id: 123, complete: false } }, { status: 202 }); }
    const id = new URL(String(input)).pathname.split('/').filter(Boolean).at(-1)!;
    if (!ready) return Response.json({ query_status: { id, team_id: 123, complete: false } });
    const body = await (await posthogFetch(input, { method: 'POST', body: JSON.stringify({ query: { query: queries.get(id) } }) })).json();
    return Response.json({ query_status: { id, team_id: 123, complete: true, results: body } });
  };
  const lines: string[] = [];
  const config = { ...freshConfig, host: 'https://eu.posthog.com', projectId: '123', personalApiKey: 'synthetic', fetcher, sleep: async () => {}, log: (line: string) => lines.push(line), onBrowserContinuation: (state: typeof resume) => { resume = state; } };
  const pending = await readVisualJourneyReport(db, config);
  assert.equal(pending.timing?.posthog.outcome, 'pending'); assert.equal(pending.timing?.posthog.queries?.identity.outcome, 'pending');
  // Soumission initiale 90 s plus tôt : la mesure couvre toute l'attente, pas ce seul appel.
  const earlier = Date.now() - 90_000;
  resume = { identity: { ...resume!.identity!, startedAt: earlier }, overview: { ...resume!.overview!, startedAt: earlier } };
  ready = true;
  const done = await readVisualJourneyReport(db, { ...config, resumeBrowser: resume });
  assert.equal(done.timing?.posthog.outcome, 'complete'); assert.equal(done.timing?.posthog.resumed, true);
  assert.ok(done.timing!.posthog.elapsedMs! >= 90_000 && done.timing!.posthog.elapsedMs! < 150_000);
  for (const line of lines) { assert.doesNotMatch(line, PERSONAL); onlyDurationsAndStatuses(JSON.parse(line.slice(line.indexOf('{')))); }

  const failed = await readVisualJourneyReport(db, { ...freshConfig, host: 'https://eu.posthog.com', projectId: '123', personalApiKey: 'synthetic', log: () => {}, fetcher: async () => Response.json({ detail: 'refusé' }, { status: 403 }) });
  assert.equal(failed.timing?.posthog.outcome, 'failed'); assert.equal(failed.freshness.posthog.status, 'failed');
  const missing = await readVisualJourneyReport(db, { ...freshConfig, log: () => {} });
  assert.deepEqual({ outcome: missing.timing?.posthog.outcome, elapsedMs: missing.timing?.posthog.elapsedMs, queries: missing.timing?.posthog.queries }, { outcome: 'not_configured', elapsedMs: null, queries: null });
});

test('une requête servie par le cache pendant que l’autre calcule est resoumise, jamais relue par un identifiant inconnu', async () => {
  const { db } = dbStub(); let resume: import('../src/lib/visual-journey-resume').VisualJourneyContinuation | undefined, identityReady = false;
  const jobs = new Map<string, string>(), requests: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    if (init?.method === 'POST') {
      const payload = JSON.parse(String(init.body)), identity = payload.query.query.includes('AS browser_id');
      requests.push(`POST ${identity ? 'identity' : 'overview'}`);
      if (!identity) return Response.json({ ...await (await posthogFetch(input, init)).json(), is_cached: true, last_refresh: new Date().toISOString() });
      jobs.set(payload.client_query_id, payload.query.query);
      return Response.json({ query_status: { id: payload.client_query_id, team_id: 123, complete: false } }, { status: 202 });
    }
    const id = new URL(String(input)).pathname.split('/').filter(Boolean).at(-1)!;
    if (!jobs.has(id)) { requests.push('GET inconnu'); return Response.json({ detail: 'Query not found' }, { status: 404 }); }
    requests.push('GET identity');
    if (!identityReady) return Response.json({ query_status: { id, team_id: 123, complete: false } });
    const body = await (await posthogFetch(input, { method: 'POST', body: JSON.stringify({ query: { query: jobs.get(id) } }) })).json();
    return Response.json({ query_status: { id, team_id: 123, complete: true, results: body } });
  };
  const config = { ...freshConfig, host: 'https://eu.posthog.com', projectId: '123', personalApiKey: 'synthetic', fetcher, sleep: async () => {}, log: () => {}, onBrowserContinuation: (state: typeof resume) => { resume = state; } };
  const pending = await readVisualJourneyReport(db, config);
  assert.equal(pending.freshness.posthog.status, 'running');
  assert.deepEqual(Object.keys(resume ?? {}), ['identity'], 'seule la requête en calcul est reprise');
  identityReady = true;
  const done = await readVisualJourneyReport(db, { ...config, resumeBrowser: resume });
  assert.equal(done.freshness.posthog.status, 'available'); assert.equal(done.page.visitors.count, 1);
  assert.ok(!requests.includes('GET inconnu'));
  assert.equal(requests.filter(request => request === 'POST identity').length, 1, 'le calcul coûteux n’est jamais relancé');
  assert.equal(requests.filter(request => request === 'POST overview').length, 2);
});
