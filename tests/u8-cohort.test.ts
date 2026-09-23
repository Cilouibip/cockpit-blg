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
  assert.equal(snapshot.totals.wix_form_submission_occurrences, 7, 'les occurrences restent mesurées');
});
