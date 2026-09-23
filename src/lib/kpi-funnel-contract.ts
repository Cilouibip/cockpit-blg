import { z } from 'zod';

const measuredCount = z.number().int().nonnegative().nullable();
const measuredMoney = z.number().finite().nullable();
const measuredRatio = z.number().finite().nonnegative().nullable();

/** Schéma 3 : colonnes de l'Excel de référence (comptes, taux et coûts en colonnes propres), récapitulatifs datés. */
export const KPI_FUNNEL_SCHEMA_VERSION = '3.0.0';

/** Blocs de source. Un taux qui croise deux blocs n'est calculé que si chacun couvre le jour ou toute la fenêtre (D3). */
export const KPI_BLOCKS = ['meta','forms','notion','commerce','posthog'] as const;
export type KpiBlock = typeof KPI_BLOCKS[number];
export const KPI_BLOCK_LABELS: Record<KpiBlock,string> = {
  meta: 'Diffusion Meta', forms: 'Inscriptions (formulaire Wix)', notion: 'Rendez-vous (Notion)', commerce: 'Ventes (rapport commerce)', posthog: 'Clics bilan (PostHog)',
};

export const KPI_COUNT_FIELDS = [
  'spend_eur','impressions','link_clicks','unique_link_clicks_campaign_sum','landing_page_views','wix_form_submission_occurrences','reached_cta_oral','booking_clicks','booking_confirmed_browser','booking_meta_attributed','calls_scheduled','calls_held','offers_made','sales','cash_collected_eur','contracted_revenue_eur',
  // Schéma 3.
  'registrants','calls_booked','outbound_clicks','meta_reach','meta_unique_link_clicks',
] as const;
export type KpiCountField = typeof KPI_COUNT_FIELDS[number];
/** Additifs : un total ou un récapitulatif est la somme des jours. Inscrits (contacts distincts) et uniques Meta (comptes) ne s'additionnent jamais. */
export const KPI_ADDITIVE_FIELDS = KPI_COUNT_FIELDS.filter(key => !['registrants','meta_reach','meta_unique_link_clicks'].includes(key)) as Exclude<KpiCountField,'registrants'|'meta_reach'|'meta_unique_link_clicks'>[];
const MONEY_FIELDS: readonly KpiCountField[] = ['spend_eur','cash_collected_eur','contracted_revenue_eur'];

/** Taux et coûts : numérateur / dénominateur (× échelle), blocs dont dépendent les deux termes. */
export const KPI_RATIOS = {
  cpm: { numerator: 'spend_eur', denominator: 'impressions', scale: 1000, blocks: ['meta'] },
  ctr: { numerator: 'link_clicks', denominator: 'impressions', blocks: ['meta'] },
  cpc: { numerator: 'spend_eur', denominator: 'link_clicks', blocks: ['meta'] },
  ctru: { numerator: 'meta_unique_link_clicks', denominator: 'meta_reach', blocks: ['meta'] },
  registrants_per_click: { numerator: 'registrants', denominator: 'link_clicks', blocks: ['forms','meta'] },
  cost_per_registrant: { numerator: 'spend_eur', denominator: 'registrants', blocks: ['meta','forms'] },
  cta_views_per_registrant: { numerator: 'reached_cta_oral', denominator: 'registrants', blocks: ['forms'] },
  cost_per_cta_view: { numerator: 'spend_eur', denominator: 'reached_cta_oral', blocks: ['meta'] },
  booked_per_cta_view: { numerator: 'calls_booked', denominator: 'reached_cta_oral', blocks: ['notion'] },
  cost_per_booking: { numerator: 'spend_eur', denominator: 'calls_booked', blocks: ['meta','notion'] },
  registrant_to_booked: { numerator: 'calls_booked', denominator: 'registrants', blocks: ['notion','forms'] },
  attendance: { numerator: 'calls_held', denominator: 'calls_scheduled', blocks: ['notion'] },
  offers_per_call_held: { numerator: 'offers_made', denominator: 'calls_held', blocks: ['notion'] },
  cost_per_offer: { numerator: 'spend_eur', denominator: 'offers_made', blocks: ['meta'] },
  close_rate: { numerator: 'sales', denominator: 'offers_made', blocks: ['commerce'] },
  cost_per_customer: { numerator: 'spend_eur', denominator: 'sales', blocks: ['meta','commerce'] },
  roas_cash: { numerator: 'cash_collected_eur', denominator: 'spend_eur', blocks: ['commerce','meta'] },
  roas: { numerator: 'contracted_revenue_eur', denominator: 'spend_eur', blocks: ['meta'] },
  // Détail (hors colonnes de l'Excel).
  sales_per_call_held: { numerator: 'sales', denominator: 'calls_held', blocks: ['commerce','notion'] },
  outbound_click_rate: { numerator: 'outbound_clicks', denominator: 'impressions', blocks: ['meta'] },
  booking_confirmation_rate: { numerator: 'booking_confirmed_browser', denominator: 'booking_clicks', blocks: ['posthog'] },
  cost_per_meta_booking: { numerator: 'spend_eur', denominator: 'booking_meta_attributed', blocks: ['meta'] },
} as const satisfies Record<string,{ numerator: KpiCountField; denominator: KpiCountField; scale?: number; blocks: readonly KpiBlock[] }>;
export type KpiRatioKey = keyof typeof KPI_RATIOS;
export const KPI_RATIO_KEYS = Object.keys(KPI_RATIOS) as KpiRatioKey[];

/** Libellés des termes, utilisés dans les motifs de non-mesure. */
export const KPI_TERM_LABELS: Record<KpiCountField,string> = {
  spend_eur: 'dépense', impressions: 'impressions', link_clicks: 'clics lien', unique_link_clicks_campaign_sum: 'clics uniques additionnés', landing_page_views: 'vues de page Meta',
  wix_form_submission_occurrences: 'inscriptions (soumissions)', reached_cta_oral: 'vues du CTA', booking_clicks: 'clics bilan', booking_confirmed_browser: 'confirmations navigateur',
  booking_meta_attributed: 'RDV attribués Meta', calls_scheduled: 'appels planifiés', calls_held: 'appels réalisés', offers_made: 'offres faites', sales: 'ventes',
  cash_collected_eur: 'cash encaissé', contracted_revenue_eur: 'CA contracté', registrants: 'inscrits', calls_booked: 'appels réservés', outbound_clicks: 'clics sortants',
  meta_reach: 'comptes touchés (reach)', meta_unique_link_clicks: 'comptes ayant cliqué le lien',
};
/** Termes jamais mesurés à ce jour : responsable et prochaine étape (couverture U8). */
export const KPI_TERM_OWNERS: Partial<Record<KpiCountField,string>> = {
  reached_cta_oral: 'Vues du CTA non mesurées : aucun signal validé (responsable : Mehdi et Codex, choix du signal vidéo).',
  offers_made: 'Offres faites non mesurées : aucun champ source validé (responsable : Jérôme avec Codex, champ Notion).',
  contracted_revenue_eur: 'CA contracté non mesuré : aucune source contractuelle alignée (responsable : lot finance de la suite).',
};

/** Bloc dont dépend chaque compte (motif d'un compte non mesuré). */
export const KPI_COUNT_BLOCKS: Partial<Record<KpiCountField,KpiBlock>> = {
  spend_eur: 'meta', impressions: 'meta', link_clicks: 'meta', unique_link_clicks_campaign_sum: 'meta', landing_page_views: 'meta', booking_meta_attributed: 'meta', outbound_clicks: 'meta', meta_reach: 'meta', meta_unique_link_clicks: 'meta',
  wix_form_submission_occurrences: 'forms', registrants: 'forms', booking_clicks: 'posthog', booking_confirmed_browser: 'posthog',
  calls_booked: 'notion', calls_scheduled: 'notion', calls_held: 'notion', sales: 'commerce', cash_collected_eur: 'commerce',
};
/** Motif d'un compte non mesuré : motif connu, sinon responsable, sinon bloc non couvert. */
export function kpiCountReason(field: KpiCountField, blocks: KpiBlockCoverage, grain: 'day' | 'window', known?: string): string {
  if (known) return known;
  if (KPI_TERM_OWNERS[field]) return KPI_TERM_OWNERS[field]!;
  const block = KPI_COUNT_BLOCKS[field];
  if (block && !blocks[block]) return `Non mesuré : ${KPI_BLOCK_LABELS[block]} ne couvre pas ${grain === 'day' ? 'ce jour' : 'toute la fenêtre'}.`;
  return `Non mesuré : ${KPI_TERM_LABELS[field]} non disponible${grain === 'day' ? ' ce jour' : ' sur la fenêtre'}.`;
}

export type KpiMeasures = Record<KpiCountField, number | null>;
export type KpiRatios = Record<KpiRatioKey, number | null>;
export type KpiBlockCoverage = Record<KpiBlock, boolean>;

/** Un ratio est null si un terme manque, si un bloc ne couvre pas le grain (D3), ou si le dénominateur est nul :
 * jamais 0 % sur un dénominateur nul, jamais « Infinity ». Chaque null porte son motif. */
export function kpiRatios(values: KpiMeasures, blocks: KpiBlockCoverage, options: { grain: 'day' | 'window'; termReasons?: Partial<Record<KpiCountField,string>>; only?: readonly KpiRatioKey[] } = { grain: 'day' }) {
  const ratios = {} as KpiRatios, reasons: Partial<Record<KpiRatioKey,string>> = {};
  for (const key of options.only ?? KPI_RATIO_KEYS) {
    const spec: { numerator: KpiCountField; denominator: KpiCountField; scale?: number; blocks: readonly KpiBlock[] } = KPI_RATIOS[key];
    const uncovered = spec.blocks.filter(block => !blocks[block]);
    const numerator = values[spec.numerator], denominator = values[spec.denominator];
    ratios[key] = null;
    if (uncovered.length) { reasons[key] = `Non mesuré : ${uncovered.map(block => KPI_BLOCK_LABELS[block]).join(' et ')} ne couvre${uncovered.length > 1 ? 'nt' : ''} pas ${options.grain === 'day' ? 'ce jour' : 'toute la fenêtre'}.`; continue; }
    const missing = [spec.numerator, spec.denominator].find(term => values[term] === null);
    if (missing) { reasons[key] = options.termReasons?.[missing] ?? KPI_TERM_OWNERS[missing] ?? `Non mesuré : terme « ${KPI_TERM_LABELS[missing]} » non mesuré.`; continue; }
    if (!denominator) { reasons[key] = `Non calculé : ${KPI_TERM_LABELS[spec.denominator]} = 0.`; continue; }
    ratios[key] = (numerator as number) * (spec.scale ?? 1) / (denominator as number);
  }
  return { ratios, reasons };
}

const measuresShape = Object.fromEntries(KPI_COUNT_FIELDS.map(key => [key, MONEY_FIELDS.includes(key) ? (key === 'spend_eur' ? z.number().finite().nonnegative().nullable() : measuredMoney) : measuredCount])) as Record<KpiCountField, typeof measuredCount>;
const ratiosSchema = z.object(Object.fromEntries(KPI_RATIO_KEYS.map(key => [key, measuredRatio])) as Record<KpiRatioKey, typeof measuredRatio>).strict();
const blocksSchema = z.object(Object.fromEntries(KPI_BLOCKS.map(key => [key, z.boolean()])) as Record<KpiBlock, z.ZodBoolean>).strict();
const reasonsSchema = z.record(z.string().min(1), z.string().min(1));

export const kpiFunnelDaySchema = z.object({
  date: z.iso.date(),
  partial_day: z.string().min(1).nullable(),
  ...measuresShape,
  ratios: ratiosSchema,
  blocks: blocksSchema,
  reasons: reasonsSchema,
}).strict();

export const kpiFunnelTotalsSchema = z.object({ ...measuresShape, wix_distinct_contacts: measuredCount, wix_repeat_occurrences: measuredCount }).strict();

/** Récapitulatifs de l'Excel (Global, 3 jours, 7 jours) : sommes des jours puis ratios des sommes, jamais une moyenne de taux. */
export const KPI_SUMMARY_KEYS = ['global','last_3_days','last_7_days'] as const;
export const kpiFunnelSummarySchema = z.object({
  key: z.enum(KPI_SUMMARY_KEYS),
  label: z.string().min(1),
  from: z.iso.date(),
  to: z.iso.date(),
  within_period: z.boolean(),
  partial_day: z.string().min(1).nullable(),
  ...measuresShape,
  ratios: ratiosSchema,
  blocks: blocksSchema,
  reasons: reasonsSchema,
}).strict();

const emailDeliverySchema = z.object({
  sent: measuredCount,
  delivered: measuredCount,
  opens_sum_by_message: measuredCount,
  clicks_sum_by_message: measuredCount,
}).strict();

const emailRecipientSchema = z.object({
  submissions: measuredCount,
  distinct_emails: measuredCount,
  sent: measuredCount,
  delivered: measuredCount,
  opens: measuredCount,
  clicks: measuredCount,
}).strict();

const baseKpiFunnelSnapshotSchema = z.object({
  metadata: z.object({
    dataset_id: z.string().min(1),
    mode: z.enum(['automatic','snapshot']).optional(),
    include_tests: z.boolean().optional(),
    schema_version: z.string().min(1),
    generated_at: z.iso.datetime({ offset: true }),
    timezone: z.literal('Europe/Paris'),
    window_start: z.iso.datetime({ offset: true }),
    window_end_meta: z.iso.datetime({ offset: true }),
    window_end_email: z.iso.datetime({ offset: true }),
    window_end_commercial: z.iso.datetime({ offset: true }),
    scope: z.string().min(1),
    scope_note: z.string().min(1),
    campaign_ids: z.array(z.string().min(1)),
    exclusions: z.array(z.string().min(1)),
  }).strict(),
  definitions: z.record(z.string(), z.string()),
  daily: z.array(kpiFunnelDaySchema).min(1),
  totals: kpiFunnelTotalsSchema,
  summaries: z.array(kpiFunnelSummarySchema).length(3),
  attribution_breakdown: z.object({
    freshness: z.iso.datetime({ offset: true }),
    metric: z.string().min(1),
    rows: z.array(z.object({
      label: z.string().min(1),
      ad_id: z.string().min(1).nullable(),
      booking_click_sessions: z.number().int().nonnegative(),
      booking_confirmed_browser: z.number().int().nonnegative(),
    }).strict()),
    wix_submission_context: z.object({
      arrival: z.record(z.string(), z.number().int().nonnegative()),
      selected_first_origin_else_arrival: z.record(z.string(), z.number().int().nonnegative()),
      rule: z.string().min(1),
      interpretation: z.string().min(1),
      freshness: z.iso.datetime({ offset: true }),
    }).strict(),
  }).strict(),
  email_summary: z.object({
    scope: z.string().min(1),
    all_three_forms: emailDeliverySchema,
    facebook_form_recipient_filter: emailRecipientSchema,
  }).strict(),
  coverage: z.array(z.object({
    field_group: z.string().min(1),
    status: z.string().min(1),
    through: z.iso.datetime({ offset: true }).optional(),
    reason: z.string().min(1).optional(),
    warning: z.string().min(1).optional(),
    detail: z.string().min(1).optional(),
    stale: z.boolean().optional(),
    last_attempt: z.string().optional(),
    last_error: z.string().optional(),
  }).strict()),
  source_locators: z.array(z.object({
    source: z.string().min(1),
    locator: z.string().min(1),
  }).strict()),
  benchmarks_and_targets: z.object({
    mehdi_targets: z.object({
      cost_per_booking_eur: z.string().min(1),
      media_cac_eur: z.string().min(1),
      review_threshold_media_cac_eur: z.number().finite(),
    }).strict(),
    marc_experience_references: z.object({
      capture_rate: z.string().min(1),
      lead_to_call_without_setting: z.string().min(1),
      status: z.string().min(1),
    }).strict(),
    proposal_observed_in_call: z.object({
      monthly_eur: z.number().finite(),
      months: z.number().int().positive(),
      total_eur: z.number().finite(),
      status: z.string().min(1),
    }).strict(),
  }).strict().optional(),
}).strict();

const requiredDailyDates = (start: string, end: string) => {
  const dates: string[] = [];
  const cursor = new Date(`${start.slice(0, 10)}T12:00:00Z`);
  const last = new Date(`${end.slice(0, 10)}T12:00:00Z`);
  while (cursor <= last) { dates.push(cursor.toISOString().slice(0, 10)); cursor.setUTCDate(cursor.getUTCDate() + 1); }
  return dates;
};
const shiftDay = (day: string, days: number) => { const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); };
const scaleOf = (key: KpiCountField) => MONEY_FIELDS.includes(key) ? 100 : 1;
const sumOf = (key: KpiCountField, values: (number | null)[]) => values.reduce<number>((accumulator, value) => accumulator + Math.round((value as number) * scaleOf(key)), 0);
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

type Context = z.RefinementCtx;
/** Garde-fous d'une ligne (jour ou récapitulatif) : uniques ≤ totaux, inscrits ≤ soumissions, ratios cohérents avec leurs termes et la couverture. */
function checkRow(row: KpiMeasures & { ratios: KpiRatios; blocks: KpiBlockCoverage; reasons: Record<string,string> }, path: (string | number)[], context: Context) {
  const pairs: [KpiCountField, KpiCountField][] = [['meta_unique_link_clicks','link_clicks'],['meta_reach','impressions'],['registrants','wix_form_submission_occurrences'],['calls_held','calls_scheduled']];
  for (const [part, whole] of pairs) if (row[part] !== null && row[whole] !== null && (row[part] as number) > (row[whole] as number)) context.addIssue({ code: 'custom', path: [...path, part], message: `${KPI_TERM_LABELS[part]} ne peut dépasser ${KPI_TERM_LABELS[whole]}.` });
  for (const key of KPI_RATIO_KEYS) {
    const spec: { numerator: KpiCountField; denominator: KpiCountField; scale?: number; blocks: readonly KpiBlock[] } = KPI_RATIOS[key], value = row.ratios[key];
    if (value === null) { if (!row.reasons[key]) context.addIssue({ code: 'custom', path: [...path, 'reasons', key], message: 'Un taux non mesuré porte son motif.' }); continue; }
    const numerator = row[spec.numerator], denominator = row[spec.denominator];
    // D3 : un taux inter-blocs exige que chaque bloc couvre le grain ; jamais un dénominateur nul.
    if (spec.blocks.some(block => !row.blocks[block])) { context.addIssue({ code: 'custom', path: [...path, 'ratios', key], message: 'Un taux exige la couverture de chacun de ses blocs.' }); continue; }
    if (numerator === null || denominator === null || denominator === 0 || !close(value, numerator * (spec.scale ?? 1) / denominator)) context.addIssue({ code: 'custom', path: [...path, 'ratios', key], message: 'Le taux ne correspond pas à ses termes.' });
  }
}

export const kpiFunnelSnapshotSchema = baseKpiFunnelSnapshotSchema.superRefine((snapshot, context) => {
  const dates = snapshot.daily.map(row => row.date);
  const expected = requiredDailyDates(snapshot.metadata.window_start, snapshot.metadata.window_end_meta);
  if (new Set(dates).size !== dates.length) context.addIssue({ code: 'custom', path: ['daily'], message: 'Les dates quotidiennes doivent être uniques.' });
  if (dates.join('|') !== expected.join('|')) context.addIssue({ code: 'custom', path: ['daily'], message: 'Chaque date de la fenêtre doit être présente une seule fois et dans l’ordre.' });

  for (const key of KPI_ADDITIVE_FIELDS) {
    const values = snapshot.daily.map(row => row[key]);
    const total = snapshot.totals[key];
    const allMissing = values.every(value => value === null);
    const aggregateProven = ['sales','cash_collected_eur'].includes(key) && snapshot.coverage.some(item => /(sales|ventes|cash)/i.test(item.field_group) && ['available','disponible'].includes(item.status));
    if (allMissing && aggregateProven) continue;
    if (values.some(value => value === null)) {
      if (total !== null) context.addIssue({ code: 'custom', path: ['totals', key], message: 'Un total reste non mesuré quand une journée manque.' });
      continue;
    }
    if (total === null || Math.round(total * scaleOf(key)) !== sumOf(key, values)) context.addIssue({ code: 'custom', path: ['totals', key], message: 'Le total ne correspond pas aux lignes quotidiennes.' });
  }
  // Inscrits (contacts distincts) : jamais la somme des jours ; bornés par le plus grand jour et par la somme.
  const registrantDays = snapshot.daily.map(row => row.registrants);
  if (snapshot.totals.registrants !== null) {
    if (registrantDays.some(value => value === null)) context.addIssue({ code: 'custom', path: ['totals','registrants'], message: 'Les inscrits de la période restent non mesurés quand une journée manque.' });
    else if (snapshot.totals.registrants > sumOf('registrants', registrantDays) || snapshot.totals.registrants < Math.max(...(registrantDays as number[]))) context.addIssue({ code: 'custom', path: ['totals','registrants'], message: 'Les inscrits de la période sont des contacts distincts compris entre le plus grand jour et la somme des jours.' });
    if (snapshot.totals.wix_distinct_contacts !== null && snapshot.totals.wix_distinct_contacts !== snapshot.totals.registrants) context.addIssue({ code: 'custom', path: ['totals','registrants'], message: 'Inscrits et contacts distincts de la période sont la même mesure.' });
  }

  if (snapshot.totals.wix_form_submission_occurrences === null) {
    if (snapshot.totals.wix_distinct_contacts !== null || snapshot.totals.wix_repeat_occurrences !== null) context.addIssue({ code: 'custom', path: ['totals','wix_distinct_contacts'], message: 'Les contacts et répétitions restent non mesurés sans occurrences.' });
  } else if (snapshot.totals.wix_distinct_contacts === null && snapshot.totals.wix_repeat_occurrences === null) {
    // Occurrences stay measured when identities are incomplete; distinct contacts and repeats remain unknown.
  } else if (snapshot.totals.wix_distinct_contacts === null || snapshot.totals.wix_repeat_occurrences === null || snapshot.totals.wix_distinct_contacts + snapshot.totals.wix_repeat_occurrences !== snapshot.totals.wix_form_submission_occurrences) {
    context.addIssue({ code: 'custom', path: ['totals','wix_distinct_contacts'], message: 'Contacts distincts et répétitions doivent reconstituer les occurrences.' });
  }

  const hasCommercialMoney = [snapshot.totals.cash_collected_eur,snapshot.totals.contracted_revenue_eur,...snapshot.daily.flatMap(row => [row.cash_collected_eur,row.contracted_revenue_eur])].some(value => value !== null);
  const commercialTotalMoney = snapshot.totals.cash_collected_eur !== null || snapshot.totals.contracted_revenue_eur !== null;
  const commercialCoverage = snapshot.coverage.some(item => /(sales|ventes|cash|contract)/i.test(item.field_group) && ['available','disponible'].includes(item.status));
  const moneyWithoutSale = snapshot.daily.some(row => (row.cash_collected_eur !== null || row.contracted_revenue_eur !== null) && row.sales === null);
  if (hasCommercialMoney && (!commercialCoverage || (commercialTotalMoney && snapshot.totals.sales === null) || moneyWithoutSale)) context.addIssue({ code: 'custom', path: ['totals'], message: 'Les montants commerciaux exigent une cohorte de ventes et une couverture explicites.' });

  snapshot.daily.forEach((row, index) => checkRow(row, ['daily', index], context));

  // Récapitulatifs : fenêtres datées finissant le dernier jour de la période ; sommes des jours, jamais une moyenne.
  const last = dates.at(-1)!, first = dates[0];
  const windows: Record<typeof KPI_SUMMARY_KEYS[number], string> = { global: first, last_3_days: shiftDay(last, -2), last_7_days: shiftDay(last, -6) };
  if (snapshot.summaries.map(summary => summary.key).join('|') !== KPI_SUMMARY_KEYS.join('|')) context.addIssue({ code: 'custom', path: ['summaries'], message: 'Récapitulatifs attendus : Global, 3 derniers jours, 7 derniers jours.' });
  snapshot.summaries.forEach((summary, index) => {
    const path = ['summaries', index];
    if (summary.to !== last || summary.from !== windows[summary.key]) context.addIssue({ code: 'custom', path, message: 'Un récapitulatif finit le dernier jour de la période et couvre exactement sa fenêtre.' });
    const inside = summary.from >= first;
    if (summary.within_period !== inside) context.addIssue({ code: 'custom', path: [...path, 'within_period'], message: 'Une fenêtre qui commence avant la période est signalée.' });
    const days = snapshot.daily.filter(row => row.date >= summary.from && row.date <= summary.to);
    for (const key of KPI_COUNT_FIELDS) {
      const value = summary[key];
      if (!inside) { if (value !== null) context.addIssue({ code: 'custom', path: [...path, key], message: 'Une fenêtre hors période reste non mesurée.' }); continue; }
      const values = days.map(row => row[key]);
      if (values.some(item => item === null)) { if (value !== null && !['meta_reach','meta_unique_link_clicks'].includes(key)) context.addIssue({ code: 'custom', path: [...path, key], message: 'Un jour non mesuré rend la somme non mesurée.' }); continue; }
      if (value === null) continue;
      if (key === 'registrants') { if (value > sumOf(key, values) || value < Math.max(...(values as number[]))) context.addIssue({ code: 'custom', path: [...path, key], message: 'Inscrits de la fenêtre : contacts distincts de la fenêtre.' }); continue; }
      if (key === 'meta_reach' || key === 'meta_unique_link_clicks') continue; // Lecture de la fenêtre entière à la source, jamais une somme de jours.
      if (Math.round(value * scaleOf(key)) !== sumOf(key, values)) context.addIssue({ code: 'custom', path: [...path, key], message: 'Le récapitulatif est la somme des jours de sa fenêtre.' });
    }
    if (summary.key === 'global') for (const key of KPI_COUNT_FIELDS) if (summary[key] !== snapshot.totals[key]) context.addIssue({ code: 'custom', path: [...path, key], message: 'Le récapitulatif global reprend les totaux de la période.' });
    checkRow(summary, path, context);
  });
});

export type KpiFunnelDay = z.infer<typeof kpiFunnelDaySchema>;
export type KpiFunnelSummary = z.infer<typeof kpiFunnelSummarySchema>;
export type KpiFunnelSnapshot = z.infer<typeof kpiFunnelSnapshotSchema>;

export type KpiFunnelResponse =
  | { status: 'ready'; snapshot: KpiFunnelSnapshot }
  | { status: 'missing'; message: string }
  | { status: 'unavailable'; message: string };
