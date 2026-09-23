import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { syncKpiSource } from '../src/lib/kpi-source-store';
import { refreshCadences } from '../src/lib/sync-jobs';
import { readLiveKpiFunnel } from '../src/lib/kpi-funnel-live';
import { kpiCommonCoverage, kpiFunnelCsv, parisMinute } from '../src/lib/kpi-funnel-export';
import { KpiFunnelReadyTable } from '../src/components/KpiFunnelTable';
import { memoryKpiDatabase } from './helpers/kpi-memory';
import { leadEntryProfile, wixLeadEntryConfig } from '../src/connectors/wix-lead-entries';
import { VISUAL_JOURNEY_FORM_ID } from '../src/lib/visual-journey-report';
import type { Row } from '../src/lib/db';
import type { DashboardFilters } from '../src/lib/ui-contract';
import type { KpiFunnelSnapshot } from '../src/lib/kpi-funnel-contract';

// U8 · fraîcheur par bloc (cadence réelle des flux), couverture commune (D3 option A), affichage et export.
// Données synthétiques ; aucune lecture distante.
const days = ['2026-09-20', '2026-09-21', '2026-09-22'], windowTo = '2026-09-23';
const filters: DashboardFilters = { from: days[0], to: days[2], source: 'all', tunnel: 'masterclass', campaign: '', compare: false };
const minutesBefore = (instant: string, minutes: number) => new Date(Date.parse(instant) - minutes * 60_000).toISOString();
const NOW = '2026-09-22T10:45:00Z';
const config = wixLeadEntryConfig(JSON.stringify({ formIds: [VISUAL_JOURNEY_FORM_ID], ignoredFormIds: [], formEmailField: 'email' }))!;
const profile = leadEntryProfile('forms', config);
const baseEnv = { NODE_ENV: 'test' as const, META_AD_ACCOUNT_ID: 'synthetic-account', POSTHOG_PROJECT_ID: '424242', WIX_SITE_ID: 'site', WIX_LEAD_ENTRY_CONFIG: JSON.stringify(config), NOTION_DATA_SOURCE_ID: 'notion-ds' };
const withCadence = (minutes?: '30' | '60'): NodeJS.ProcessEnv => ({ ...baseEnv, ...(minutes ? { BLG_REFRESH_CADENCE_MINUTES: minutes } : {}) });
const run = (id: string, source: string, namespace: string, stream: string, profileKey: string, at: string): Row => ({ id, source, source_namespace: namespace, stream_key: stream, query_profile_key: profileKey, status: 'complete', pagination_complete: true, rows_rejected: 0, started_at: at, finished_at: at, period_to: at });
const registration = (index: number, day: string): Row => ({ id: `obs-${index}`, external_id: `entry-${index}`, family: 'forms', source: 'wix', source_namespace: 'site', source_container_id: VISUAL_JOURNEY_FORM_ID, is_current: true, run_id: 'forms-run', published_at: '2026-09-20T00:00:00Z', mapping_profile: profile, eligible: true, identity_key: `identity-${index}`, identity_state: 'linked', person_id: `person-${index}`, occurred_day: day, occurred_at: `${day}T08:00:00Z`, properties: { origin: { source: 'facebook', medium: 'paid_social' } } });

type Ages = { meta?: number; posthog?: number; email?: number; forms?: number; notion?: number; emailObservedAt?: string };
/** Chaque flux est publié un certain nombre de minutes avant NOW ; la période couvre deux jours passés et la journée en cours. */
async function scenario(ages: Ages = {}, extra: { metaObservedAt?: string } = {}) {
  const at = (minutes: number | undefined, fallback: number) => minutesBefore(NOW, minutes ?? fallback);
  let clock = NOW;
  const memory = memoryKpiDatabase({
    sync_runs: [run('forms-run', 'wix', 'site', 'lead_entries_forms', profile, at(ages.forms, 20)), run('notion-run', 'notion', 'notion-ds', 'prospects_business', 'notion-profile', at(ages.notion, 45))],
    lead_source_observations: [registration(1, days[0]), registration(2, days[1])],
    prospects: [{ id: 'P1', external_id: 'ext-P1', source: 'notion', source_namespace: 'notion-ds', person_id: 'person-1', archived: false, business: { scheduledDay: days[1], attendance: 'show_up', attendanceBasis: 'source_group' } }, { id: 'P2', external_id: 'ext-P2', source: 'notion', source_namespace: 'notion-ds', person_id: 'person-2', archived: false, business: { scheduledDay: days[1], attendance: 'no_show', attendanceBasis: 'source_group' } }],
    appointments: [{ id: 'A1', prospect_id: 'P1', source_namespace: 'notion-ds', identity_basis: 'notion_current_slot', scheduled_day: days[1], status: 'unknown', source_status: 'RDV Programmé' }, { id: 'A2', prospect_id: 'P2', source_namespace: 'notion-ds', identity_basis: 'notion_current_slot', scheduled_day: days[1], status: 'unknown', source_status: 'RDV Programmé' }],
  }, () => clock);
  const metaAt = extra.metaObservedAt ?? at(ages.meta, 45), metaTo = Date.parse(metaAt) < Date.parse('2026-09-22T00:00:00Z') ? '2026-09-22' : windowTo;
  const metaDays = days.filter(day => day < metaTo);
  clock = metaAt;
  await syncKpiSource(memory.db, 'meta', baseEnv.META_AD_ACCOUNT_ID, days[0], metaTo, async () => ({ from: days[0], to: metaTo, observedAt: metaAt, rows: metaDays.map(day => ({ day, key: '120248808857790714', data: { campaignId: '120248808857790714', spend_eur: 20, impressions: 2000, link_clicks: 40, unique_link_clicks_campaign_sum: 35, landing_page_views: 30, booking_meta_attributed: 1 } })) }));
  const phAt = at(ages.posthog, 15);
  clock = phAt;
  await syncKpiSource(memory.db, 'posthog', baseEnv.POSTHOG_PROJECT_ID, days[0], windowTo, async () => ({ from: days[0], to: windowTo, observedAt: phAt, rows: days.flatMap(day => ['click', 'confirmed'].map(kind => ({ day, key: `${day}-${kind}`, data: { kind, ad: '', campaign: '', source: 'facebook', medium: 'paid_social', link: '', isTest: false, sessions: kind === 'click' ? 4 : 1 } }))) }));
  const emailAt = ages.emailObservedAt ?? at(ages.email, 45), emailTo = Date.parse(emailAt) < Date.parse('2026-09-22T00:00:00Z') ? '2026-09-22' : windowTo;
  clock = emailAt;
  await syncKpiSource(memory.db, 'wix', baseEnv.WIX_SITE_ID, days[0], emailTo, async () => ({ from: days[0], to: emailTo, observedAt: emailAt, rows: days.filter(day => Date.parse(emailAt) > Date.parse(`${day}T00:00:00Z`) - 7_200_000).flatMap(day => [{ day, key: `${day}-cohort`, data: { identity: 'identity-1', message: 'message-1', sent: 1, delivered: 1, opens: 1, clicks: 0 } }, { day, key: `${day}-outside`, data: { identity: 'identity-outside', message: 'message-1', sent: 2, delivered: 2, opens: 0, clicks: 1 } }]) }));
  return memory;
}
async function snapshotFor(env: NodeJS.ProcessEnv, ages: Ages = {}, extra: { metaObservedAt?: string } = {}) {
  const memory = await scenario(ages, extra);
  const response = await readLiveKpiFunnel(memory.db, filters, { env, now: NOW });
  assert.equal(response.status, 'ready'); if (response.status !== 'ready') throw Error('not ready');
  return response.snapshot;
}
const block = (snapshot: KpiFunnelSnapshot, group: string) => snapshot.coverage.find(item => item.field_group === group)!;

test('U8 fraîcheur : l’état « ancien » suit la cadence réelle de chaque flux, pas un seuil fixe d’une heure', async () => {
  assert.equal(refreshCadences(withCadence('30')).kpi_meta, 30 * 60_000, 'précondition : flux pilotes à 30 minutes après bascule');
  assert.equal(refreshCadences(withCadence('30')).notion, 60 * 60_000, 'précondition : Notion reste à une heure');
  const pilot30 = await snapshotFor(withCadence('30'));
  // Meta et email lus il y a 45 min : anciens à 30 min, à jour à 60 min.
  assert.equal(block(pilot30, 'Diffusion Meta').stale, true);
  assert.equal(block(pilot30, 'Activité email').stale, true);
  assert.equal(block(pilot30, 'Clics bilan et confirmations navigateur').stale, false, 'lu il y a 15 min');
  assert.equal(block(pilot30, 'Occurrences du formulaire Wix').stale, false, 'lu il y a 20 min');
  // Notion lu il y a 45 min reste à jour (cadence d'une heure) même quand les flux pilotes passent à 30 min.
  assert.equal(block(pilot30, 'Rendez-vous et présence').stale, false);
  const hourly = await snapshotFor(withCadence('60'));
  assert.equal(block(hourly, 'Diffusion Meta').stale, false);
  assert.equal(block(hourly, 'Activité email').stale, false);
  const lateNotion = await snapshotFor(withCadence('30'), { notion: 75 });
  assert.equal(block(lateNotion, 'Rendez-vous et présence').stale, true, 'Notion au-delà d’une heure');
  const lateForms = await snapshotFor(withCadence('30'), { forms: 35, notion: 10 });
  assert.equal(block(lateForms, 'Rendez-vous et présence').stale, true, 'la cohorte des inscrits (flux pilote) est plus vieille que sa cadence');
});

test('U8 fraîcheur : un bloc à plusieurs sources est daté par la plus ancienne ; la couverture commune est la plus ancienne des blocs disponibles', async () => {
  const snapshot = await snapshotFor(withCadence('30'), { forms: 20, notion: 50 });
  assert.equal(block(snapshot, 'Rendez-vous et présence').through, minutesBefore(NOW, 50));
  assert.equal(block(snapshot, 'Occurrences du formulaire Wix').through, minutesBefore(NOW, 20));
  const available = snapshot.coverage.filter(item => item.status === 'available').map(item => item.field_group);
  assert.deepEqual(available.sort(), ['Activité email', 'Clics bilan et confirmations navigateur', 'Diffusion Meta', 'Occurrences du formulaire Wix', 'Rendez-vous et présence']);
  assert.deepEqual(kpiCommonCoverage(snapshot), { through: minutesBefore(NOW, 50), stale: true });
  assert.equal(block(snapshot, 'Ventes payées et cash').status, 'missing', 'non configuré : exclu de la couverture commune');
  assert.equal(block(snapshot, 'Ventes payées et cash').through, undefined, 'sans publication commerciale, pas d’heure de couverture empruntée aux autres sources');
  assert.match(block(snapshot, 'Ventes payées et cash').reason!, /^Rapport des ventes non configuré ou illisible/);
});

test('U8 D3 : un jour passé lu en cours de journée n’est pas présenté comme complet ; chaque taux reste dans un seul bloc', async () => {
  // Dernière publication Meta le 21/09 à 17:00 (Paris) : le 20/09 est complet, le 21/09 partiel, le 22/09 absent.
  const snapshot = await snapshotFor(withCadence('30'), {}, { metaObservedAt: '2026-09-21T15:00:00Z' });
  assert.deepEqual(snapshot.daily.map(d => d.spend_eur), [20, null, null]);
  const instant = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
  assert.ok(renderToStaticMarkup(createElement(KpiFunnelReadyTable, { snapshot })).includes(`Lecture la plus ancienne des blocs disponibles (couverture commune) : ${instant.format(new Date(minutesBefore(NOW, 45)))}`), 'le bloc Meta incomplet ne fixe pas la couverture commune');
  assert.equal(snapshot.totals.spend_eur, null);
  assert.equal(block(snapshot, 'Diffusion Meta').status, 'missing');
  for (const day of snapshot.daily) {
    const pairs: [string, (number | null)[]][] = [['meta', [day.spend_eur, day.impressions, day.link_clicks, day.landing_page_views, day.booking_meta_attributed]], ['posthog', [day.booking_clicks, day.booking_confirmed_browser]], ['notion', [day.calls_scheduled, day.calls_held]]];
    for (const [name, values] of pairs) assert.ok(values.every(v => v === null) || values.every(v => v !== null), `${name} ${day.date} : numérateur et dénominateur ont la même couverture`);
  }
  assert.deepEqual(snapshot.daily.map(d => [d.calls_scheduled, d.calls_held]), [[0, 0], [2, 1], [0, 0]]);
  assert.equal(snapshot.daily[2].partial_day, 'Journée en cours ou à venir');
  // Schéma 3 : taux en colonnes propres. Un taux Meta n'existe que sur un jour couvert par Meta ; le motif nomme le bloc.
  assert.equal(snapshot.daily[0].ratios.ctr, 40 / 2000);
  assert.equal(snapshot.daily[1].ratios.ctr, null);
  assert.equal(snapshot.daily[1].reasons.ctr, 'Non mesuré : Diffusion Meta ne couvre pas ce jour.');
  assert.equal(snapshot.daily[1].ratios.booking_confirmation_rate, 1 / 4, 'le taux PostHog reste calculé : ses deux termes sont couverts');
  assert.equal(snapshot.daily[1].ratios.attendance, 1 / 2);
  assert.equal(snapshot.summaries[0].ratios.ctr, null, 'total Meta non mesuré : aucun taux Meta au récapitulatif global');
  const html = renderToStaticMarkup(createElement(KpiFunnelReadyTable, { snapshot }));
  const body = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>')).split('</tr>');
  const [global, , , day20, day21] = body;
  assert.match(day20, /2,0\u00a0%|2,0 %/, 'CTR du 20/09 affiché dans sa colonne');
  assert.match(day21, /title="Non mesuré : Diffusion Meta ne couvre pas ce jour\."/, 'le motif nomme le bloc non couvert');
  assert.match(day21, /50,0/, 'présence du 21/09 (Notion couvert)');
  assert.match(global, /title="Non mesuré : Diffusion Meta ne couvre pas toute la fenêtre\."/);
});

test('U8 affichage : heure de couverture de chaque bloc, état « ancien », couverture commune en tête, responsables des non mesurés', async () => {
  const snapshot = await snapshotFor(withCadence('30'));
  const html = renderToStaticMarkup(createElement(KpiFunnelReadyTable, { snapshot }));
  const instant = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
  const common = kpiCommonCoverage(snapshot).through!;
  assert.ok(html.includes(`Lecture la plus ancienne des blocs disponibles (couverture commune) : ${instant.format(new Date(common))}, heure de Paris.`), 'couverture commune visible en tête');
  assert.ok(html.includes('Certaines sources attendent une mise à jour.'));
  const strip = html.slice(html.indexOf('kpi-funnel-coverage'), html.indexOf('kpi-funnel-scroll'));
  assert.ok(strip.includes(`<strong>Diffusion Meta</strong><span>Disponible · ancien · jusqu’au ${instant.format(new Date(block(snapshot, 'Diffusion Meta').through!))}</span>`));
  assert.ok(strip.includes(`<strong>Clics bilan et confirmations navigateur</strong><span>Disponible · à jour · jusqu’au ${instant.format(new Date(block(snapshot, 'Clics bilan et confirmations navigateur').through!))}</span>`));
  assert.ok(strip.includes('<strong>CTA oral</strong><span>Non mesuré</span>'));
  for (const [group, detail] of [['CTA oral', 'Responsable : Mehdi et Codex. Prochaine étape : choisir le signal vidéo ; aucune collecte créée d’ici là.'], ['Offres faites', 'Responsable : Jérôme avec Codex. Prochaine étape : définir le champ source dans Notion ; aucune écriture Notion d’ici là.'], ['CA contracté', 'Responsable : lot finance de la suite. Prochaine étape : aligner la source contractuelle dans ce lot.']] as const) {
    assert.equal(block(snapshot, group).status, 'missing');
    assert.equal(block(snapshot, group).detail, detail);
    assert.ok(html.includes(detail), `${group} : responsable et prochaine étape affichés`);
  }
  for (const key of ['reached_cta_oral', 'offers_made', 'contracted_revenue_eur'] as const) assert.ok(snapshot.daily.every(d => d[key] === null) && snapshot.totals[key] === null, `${key} jamais à zéro`);
});

test('U8 export : les lignes de couverture (bloc, état, actualisation, heure de Paris) accompagnent les données', async () => {
  const snapshot = await snapshotFor(withCadence('30'));
  const csv = kpiFunnelCsv(snapshot);
  const lines = csv.replace('﻿', '').split('\r\n');
  assert.equal(lines[2], `"Couverture commune (plus ancienne des sources disponibles, heure de Paris)";"${parisMinute(kpiCommonCoverage(snapshot).through)}";"Au moins une source ancienne"`);
  assert.ok(lines.includes('"Sources";"État";"Actualisation";"Données lues jusqu’au (heure de Paris)";"Dernière tentative (heure de Paris)";"Dernière erreur";"Limite";"Responsable et prochaine étape"'));
  const meta = lines.find(line => line.startsWith('"Diffusion Meta"'))!;
  assert.match(meta, /^"Diffusion Meta";"Disponible";"Ancienne";"22\/09\/2026 12:00";"22\/09\/2026 12:00";"";/);
  const posthog = lines.find(line => line.startsWith('"Clics bilan et confirmations navigateur"'))!;
  assert.match(posthog, /^"Clics bilan et confirmations navigateur";"Disponible";"À jour";"22\/09\/2026 12:30";/);
  assert.ok(lines.some(line => line.startsWith('"CTA oral";"Non mesuré";"";"";"";"";"Non mesuré : aucun signal validé du passage au CTA oral.";"Responsable : Mehdi et Codex.')));
  assert.ok(lines.includes('"Inscriptions Wix";"Occurrences";"Contacts distincts";"Répétitions"'));
  assert.ok(lines.includes('"Total de la période";"2";"2";"0"'));
  assert.equal(parisMinute('2026-09-22T12:55:00Z'), '22/09/2026 14:55');
  assert.equal(parisMinute('2026-12-01T12:55:00Z'), '01/12/2026 13:55', 'heure d’hiver');
});

test('U8 détail par annonce : sans lecture complète des clics bilan, aucune date de lecture n’est affichée', async () => {
  const memory = memoryKpiDatabase({});
  const response = await readLiveKpiFunnel(memory.db, filters, { env: withCadence('30'), now: NOW });
  assert.equal(response.status, 'ready'); if (response.status !== 'ready') return;
  const html = renderToStaticMarkup(createElement(KpiFunnelReadyTable, { snapshot: response.snapshot }));
  assert.ok(html.includes('aucune lecture complète des clics bilan sur la période'));
  assert.ok(html.includes('Aucune lecture complète sur la période.'), 'aucune heure de couverture inventée en tête');
  assert.ok(!html.includes('Sessions de clic bilan ; lecture automatique. · lu'), 'l’heure de la requête n’est pas présentée comme une lecture');
  const read = await snapshotFor(withCadence('30'));
  const withData = renderToStaticMarkup(createElement(KpiFunnelReadyTable, { snapshot: read }));
  assert.ok(withData.includes('Sessions de clic bilan ; lecture automatique. · lu jusqu’au '));
  assert.equal(response.snapshot.daily.every(d => d.booking_clicks === null), true, 'aucune session lue : non mesuré, pas zéro');
});

test('U8 emails : deux périmètres (séquence complète, contacts inscrits de la période), non mesurés si un jour n’est pas couvert', async () => {
  const snapshot = await snapshotFor(withCadence('30'));
  assert.deepEqual(snapshot.email_summary.all_three_forms, { sent: 9, delivered: 9, opens_sum_by_message: 3, clicks_sum_by_message: 3 });
  assert.deepEqual(snapshot.email_summary.facebook_form_recipient_filter, { submissions: 2, distinct_emails: 2, sent: 3, delivered: 3, opens: 3, clicks: 0 }, 'seuls les destinataires dont la clé figure parmi les inscriptions de la période');
  assert.equal(block(snapshot, 'Activité email').status, 'available');
  const partial = await snapshotFor(withCadence('30'), { emailObservedAt: '2026-09-21T15:00:00Z' });
  assert.deepEqual(partial.email_summary.all_three_forms, { sent: null, delivered: null, opens_sum_by_message: null, clicks_sum_by_message: null }, 'le 21/09 lu à 17:00 et le 22/09 non lu : totaux non mesurés');
  assert.equal(partial.email_summary.facebook_form_recipient_filter.sent, null);
  assert.equal(block(partial, 'Activité email').status, 'missing');
});
