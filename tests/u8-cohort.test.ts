import test from 'node:test';
import assert from 'node:assert/strict';
import { readLiveKpiFunnel } from '../src/lib/kpi-funnel-live';
import { memoryKpiDatabase } from './helpers/kpi-memory';
import { leadEntryProfile, wixLeadEntryConfig } from '../src/connectors/wix-lead-entries';
import { VISUAL_JOURNEY_FORM_ID } from '../src/lib/visual-journey-report';
import type { Row } from '../src/lib/db';
import type { DashboardFilters } from '../src/lib/ui-contract';

// U8 · inscriptions Wix et bloc commercial (rendez-vous, présence). Identifiants synthétiques, aucune donnée nominative.
const from = '2026-09-20', now = '2026-09-22T11:00:00Z', publishedAt = '2026-09-22T10:00:00Z';
const filters: DashboardFilters = { from, to: '2026-09-21', source: 'all', tunnel: 'masterclass', campaign: '', compare: false };
const config = wixLeadEntryConfig(JSON.stringify({ formIds: [VISUAL_JOURNEY_FORM_ID], ignoredFormIds: [], formEmailField: 'email' }))!;
const profile = leadEntryProfile('forms', config);
const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', WIX_SITE_ID: 'site', WIX_LEAD_ENTRY_CONFIG: JSON.stringify(config), NOTION_DATA_SOURCE_ID: 'notion-ds' };
const AD_VID52 = '120248824582140714';
const run = (id: string, source: string, namespace: string, stream: string, profileKey: string | null, at = publishedAt): Row => ({ id, source, source_namespace: namespace, stream_key: stream, query_profile_key: profileKey, status: 'complete', pagination_complete: true, rows_rejected: 0, started_at: at, finished_at: at, period_to: at });
const formsRun = run('forms-run', 'wix', 'site', 'lead_entries_forms', profile);
const notionRun = run('notion-run', 'notion', 'notion-ds', 'prospects_business', 'notion-profile');
type Reg = { identity?: string | null; person?: string | null; state?: string; day?: string; origin?: Row; firstTouch?: Row | null; form?: string; eligible?: boolean; mapping?: string; current?: boolean };
let sequence = 0;
const registration = (options: Reg = {}): Row => {
  const day = options.day ?? from, index = ++sequence;
  return { id: `obs-${index}`, external_id: `entry-${index}`, family: 'forms', source: 'wix', source_namespace: 'site', source_container_id: options.form ?? VISUAL_JOURNEY_FORM_ID, is_current: options.current ?? true, run_id: 'forms-run', published_at: publishedAt, mapping_profile: options.mapping ?? profile, eligible: options.eligible ?? true, identity_key: options.identity === undefined ? `identity-${index}` : options.identity, identity_state: options.state ?? 'linked', person_id: options.person === undefined ? `person-${index}` : options.person, occurred_day: day, occurred_at: `${day}T08:00:${String(index % 60).padStart(2, '0')}Z`, properties: { origin: options.origin ?? { source: 'facebook', medium: 'paid_social' }, ...(options.firstTouch ? { firstTouch: options.firstTouch } : {}) } };
};
const read = async (tables: Record<string, Row[]>, options: { includeTests?: boolean } = {}) => {
  const memory = memoryKpiDatabase({ sync_runs: [formsRun, notionRun], ...tables } as never);
  const response = await readLiveKpiFunnel(memory.db, filters, { env, now, ...options });
  assert.equal(response.status, 'ready'); if (response.status !== 'ready') throw Error('not ready');
  return response.snapshot;
};

test('U8 inscriptions : occurrences conservées, contacts distincts, essais et lignes hors périmètre exclus, contexte d’origine', async () => {
  const rows = [
    registration({ identity: 'ia', person: 'pa', day: from, origin: { source: 'facebook', medium: 'paid_social', ad: AD_VID52 } }),
    registration({ identity: 'ia', person: 'pa', day: '2026-09-21', origin: { source: 'ig', medium: 'social' } }),
    registration({ identity: 'ib', person: 'pb', day: '2026-09-21', origin: { source: 'test', medium: 'recette' } }),
    registration({ identity: 'ic', person: 'pc', form: 'autre-formulaire' }),
    registration({ identity: 'id', person: 'pd', eligible: false }),
    registration({ identity: 'ie', person: 'pe', mapping: 'ancien-profil' }),
    registration({ identity: 'if', person: 'pf', day: '2026-09-19' }),
    registration({ identity: 'ig', person: 'pg', current: false }),
  ];
  const snapshot = await read({ lead_source_observations: rows });
  assert.deepEqual(snapshot.daily.map(d => d.wix_form_submission_occurrences), [1, 1]);
  assert.deepEqual([snapshot.totals.wix_form_submission_occurrences, snapshot.totals.wix_distinct_contacts, snapshot.totals.wix_repeat_occurrences], [2, 1, 1], 'répétition d’un même contact : deux occurrences, un contact');
  const context = snapshot.attribution_breakdown.wix_submission_context;
  assert.deepEqual(context.arrival, { [`Publicité ${AD_VID52}`]: 1, ig: 1 }, 'arrivée propre à chaque inscription');
  assert.deepEqual(context.selected_first_origin_else_arrival, { [`Publicité ${AD_VID52}`]: 2 }, 'la première origine canonique de la personne est conservée');
  assert.equal(snapshot.coverage.find(c => c.field_group === 'Occurrences du formulaire Wix')?.status, 'available');
  const withTests = await read({ lead_source_observations: rows }, { includeTests: true });
  assert.equal(withTests.totals.wix_form_submission_occurrences, 3, 'l’essai revient seulement avec l’option');
});

test('U8 inscriptions : une identité non résolue garde l’occurrence mais rend les contacts distincts non mesurés', async () => {
  const snapshot = await read({ lead_source_observations: [registration({ identity: 'ia', person: 'pa' }), registration({ identity: null, person: null, state: 'unresolved' })] });
  assert.equal(snapshot.totals.wix_form_submission_occurrences, 2);
  assert.equal(snapshot.totals.wix_distinct_contacts, null);
  assert.equal(snapshot.totals.wix_repeat_occurrences, null);
  assert.equal(snapshot.email_summary.facebook_form_recipient_filter.distinct_emails, null);
});

test('U8 inscriptions : sans publication complète du flux des formulaires, aucune occurrence n’est affichée', async () => {
  const memory = memoryKpiDatabase({ sync_runs: [{ ...formsRun, status: 'failed', pagination_complete: false }], lead_source_observations: [registration({ identity: 'ia', person: 'pa' })] });
  const response = await readLiveKpiFunnel(memory.db, filters, { env, now });
  assert.equal(response.status, 'ready'); if (response.status !== 'ready') return;
  assert.deepEqual(response.snapshot.daily.map(d => d.wix_form_submission_occurrences), [null, null]);
});

const prospect = (id: string, person: string, business: Row, extra: Row = {}): Row => ({ id, external_id: `ext-${id}`, source: 'notion', source_namespace: 'notion-ds', person_id: person, business, archived: false, ...extra });
const appointment = (id: string, prospectId: string, slot: { at?: string; day?: string }, extra: Row = {}): Row => ({ id, prospect_id: prospectId, source: 'notion', source_namespace: 'notion-ds', identity_basis: 'notion_current_slot', scheduled_at: slot.at ?? null, scheduled_day: slot.day ?? null, status: 'unknown', source_status: 'RDV Programmé', ...extra });
function commercialFixture() {
  const people = ['pa', 'pc', 'pd', 'pe', 'pf', 'pg'];
  return {
    lead_source_observations: people.map(person => registration({ identity: `i-${person}`, person })),
    prospects: [
      prospect('Pa', 'pa', { scheduledDay: '2026-09-20', attendance: 'show_up', attendanceBasis: 'source_group' }),
      prospect('Pc', 'pc', { scheduledDay: '2026-09-21', attendance: 'scheduled', attendanceBasis: 'source_status' }),
      prospect('Pd', 'pd', { scheduledDay: '2026-09-21', attendance: 'no_show', attendanceBasis: 'source_group' }),
      prospect('Pe', 'pe', { scheduledDay: '2026-09-20', attendance: 'unknown', attendanceBasis: 'unknown' }),
      prospect('Pf', 'pf', { scheduledDay: '2026-09-21', attendance: 'cancelled', attendanceBasis: 'source_status' }),
      prospect('Pg', 'pg', { scheduledDay: '2026-09-20', attendance: 'show_up', attendanceBasis: 'source_group' }, { archived: true }),
      prospect('Px', 'px', { scheduledDay: '2026-09-20', attendance: 'show_up', attendanceBasis: 'source_group' }),
    ],
    appointments: [
      appointment('a-present', 'Pa', { at: '2026-09-20T07:30:00Z' }),
      appointment('a-past-scheduled', 'Pc', { day: '2026-09-21' }),
      appointment('a-moved-current', 'Pd', { at: '2026-09-21T15:00:00Z' }),
      appointment('a-moved-old', 'Pd', { day: '2026-09-20' }, { identity_basis: 'legacy', status: 'rescheduled' }),
      appointment('a-reported', 'Pe', { day: '2026-09-20' }, { source_status: 'RDV Reporté' }),
      appointment('a-cancelled', 'Pf', { day: '2026-09-21' }, { source_status: 'RDV Annulé' }),
      appointment('a-archived', 'Pg', { day: '2026-09-20' }),
      appointment('a-outside-cohort', 'Px', { day: '2026-09-20' }),
    ],
  };
}

test('U8 commercial : créneaux effectifs au jour du call, présence Notion seulement, report sans double comptage', async () => {
  const snapshot = await read(commercialFixture());
  // 20/09 : présent (Pa). Ancien créneau reporté (Pd), statut « RDV Reporté » (Pe), fiche archivée (Pg), hors cohorte (Px) exclus.
  // 21/09 : créneau passé encore « programmé » (Pc, pas une présence) et nouveau créneau absent (Pd) ; annulé (Pf) exclu.
  assert.deepEqual(snapshot.daily.map(d => [d.calls_scheduled, d.calls_held]), [[1, 1], [2, 0]]);
  assert.deepEqual([snapshot.totals.calls_scheduled, snapshot.totals.calls_held], [3, 1]);
  for (const day of snapshot.daily) assert.ok((day.calls_held ?? 0) <= (day.calls_scheduled ?? 0), 'les tenus sont une partie des prévus du même jour');
  assert.equal(snapshot.coverage.find(c => c.field_group === 'Rendez-vous et présence')?.status, 'available');
});

test('U8 commercial : règle actuelle cohortComplete, une seule inscription non reliée rend tout le bloc non mesuré', async () => {
  const fixture = commercialFixture();
  fixture.lead_source_observations.push(registration({ identity: 'i-inconnu', person: null, state: 'unresolved', day: '2026-09-21' }));
  const snapshot = await read(fixture);
  assert.deepEqual(snapshot.daily.map(d => [d.calls_scheduled, d.calls_held]), [[null, null], [null, null]], 'y compris le 20/09 où toutes les inscriptions du jour sont reliées');
  assert.deepEqual([snapshot.totals.calls_scheduled, snapshot.totals.calls_held, snapshot.totals.sales, snapshot.totals.cash_collected_eur], [null, null, null, null]);
  const coverage = snapshot.coverage.find(c => c.field_group === 'Rendez-vous et présence');
  assert.equal(coverage?.status, 'missing');
  assert.equal(coverage?.detail, '1 inscription de la période non reliée à une personne : tout le bloc reste non mesuré (règle actuelle : toutes les inscriptions reliées).', 'la couverture chiffre les inscriptions non reliées');
  assert.equal(snapshot.totals.wix_form_submission_occurrences, 7, 'les occurrences restent mesurées');
});

// Ventes et cash sous pause : la dernière publication complète reste lue et datée ; rien n'est converti en zéro.
import { buildNotionCommerceReport } from '../src/lib/notion-commerce-report';
import { publishNotionCommerceReport } from '../src/lib/notion-commerce-storage';
import { commerceConfig, payment, schedule, parcours, client, snapshot as commerceSnapshot } from './commerce-fixtures';

async function commerceScenario(options: { reader?: string; observedAt?: string; now?: string } = {}) {
  const at = '2026-09-23T08:50:00Z', observedAt = options.observedAt ?? '2026-09-22T12:55:00Z';
  const memory = memoryKpiDatabase({
    sync_runs: [
      { ...formsRun, started_at: at, finished_at: at, period_to: at },
      { ...notionRun, started_at: at, finished_at: at, period_to: at },
      run('clients-run', 'notion', 'clients-ds', 'lead_entries_client_history', 'clients-profile', at),
      { id: 'commerce-try', source: 'notion', source_namespace: 'synthetic-parcours', stream_key: 'commerce_reader_checkpoint', status: 'failed', pagination_complete: false, rows_rejected: 0, started_at: '2026-09-23T06:00:00Z', finished_at: '2026-09-23T06:00:45Z', error_code: 'COMMERCE_CHECKPOINT_TIMEOUT' },
    ],
    lead_source_observations: [
      { ...registration({ identity: 'i-pa', person: 'pa', day: '2026-09-21' }) },
      { id: 'client-link', external_id: 'client-a', family: 'client_history', source: 'notion', source_namespace: 'clients-ds', is_current: true, run_id: 'clients-run', published_at: at, mapping_profile: 'clients-profile', eligible: true, identity_key: 'i-pa', identity_state: 'linked', person_id: 'pa', occurred_day: '2026-01-01', occurred_at: '2026-01-01T10:00:00Z', properties: {} },
    ],
  }, () => '2026-09-22T12:56:00Z');
  const report = buildNotionCommerceReport(commerceSnapshot({
    clients: [client('client-a')], payments: [payment('payment-a', { day: '2026-09-21', rawDate: '2026-09-21' })],
    schedules: [schedule('schedule-a', { day: '2026-09-21', rawDate: '2026-09-21' })], parcours: [parcours('parcours-a', { startDay: '2026-09-21', rawStart: '2026-09-21', closingDay: '2026-09-20', rawClosing: '2026-09-20' })],
    startedAt: '2026-09-22T12:50:00Z', observedAt,
  }));
  await publishNotionCommerceReport(memory.db, commerceConfig, report);
  const commerceEnv: NodeJS.ProcessEnv = { ...env, NOTION_CLIENT_DATA_SOURCE_ID: 'clients-ds', NOTION_COMMERCE_CONFIG: JSON.stringify(commerceConfig), ...(options.reader ? { BLG_COMMERCE_READER: options.reader } : {}) };
  const response = await readLiveKpiFunnel(memory.db, { ...filters, from: '2026-09-21', to: '2026-09-23' }, { env: commerceEnv, now: options.now ?? '2026-09-23T09:00:00Z' });
  assert.equal(response.status, 'ready'); if (response.status !== 'ready') throw Error('not ready');
  return response.snapshot;
}

test('U8 ventes sous pause : lecture suspendue, dernière publication et dernière tentative datées, jours non couverts jamais à zéro', async () => {
  const snapshot = await commerceScenario();
  assert.deepEqual(snapshot.daily.map(d => [d.date, d.sales, d.cash_collected_eur]), [['2026-09-21', 1, 100], ['2026-09-22', null, null], ['2026-09-23', null, null]], 'le 22/09 n’est couvert que jusqu’à 14:55 ; le 23/09 pas du tout');
  assert.equal(snapshot.totals.sales, null, 'un seul jour inconnu rend le total indisponible');
  assert.equal(snapshot.totals.cash_collected_eur, null);
  const line = snapshot.coverage.find(c => c.field_group === 'Ventes payées et cash')!;
  assert.equal(line.status, 'available', 'la dernière publication complète reste valide et lue ; les jours qu’elle ne couvre pas sont non mesurés');
  assert.match(line.reason!, /^Lecture suspendue \(réglage BLG_COMMERCE_READER\)/);
  assert.match(line.reason!, /dernière publication complète du 22\/09\/2026 14:55/);
  assert.match(line.reason!, /dernière tentative le 23\/09\/2026 08:00 \(échec\)/);
  assert.equal(line.through, '2026-09-22T12:55:00Z');
  assert.equal(line.stale, true, 'une publication de la veille est ancienne');
  assert.equal(line.last_error, 'COMMERCE_CHECKPOINT_TIMEOUT');
  const contracted = snapshot.coverage.find(c => c.field_group === 'CA contracté')!;
  assert.match(contracted.reason!, /sans lien avec la pause des ventes/);
  assert.equal(snapshot.totals.contracted_revenue_eur, null);
});

test('U8 ventes : lecteur actif avec tentative en échec, et publication couvrant toute la veille', async () => {
  const active = await commerceScenario({ reader: 'active' });
  const line = active.coverage.find(c => c.field_group === 'Ventes payées et cash')!;
  assert.match(line.reason!, /^Dernier rapport valide conservé \(dernière publication complète du 22\/09\/2026 14:55\) ; dernière tentative le 23\/09\/2026 08:00 \(échec\)/);
  const covered = await commerceScenario({ observedAt: '2026-09-22T22:30:00Z' });
  assert.deepEqual(covered.daily.map(d => [d.sales, d.partial_day !== null]), [[1, false], [0, false], [0, true]], 'publiée à 00:30 le 23/09 : le 22/09 est entièrement couvert, le 23/09 est partiel et signalé');
  assert.equal(covered.totals.sales, 1);
});
