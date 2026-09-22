import { z } from 'zod';

const measuredCount = z.number().int().nonnegative().nullable();
const measuredMoney = z.number().finite().nullable();

export const kpiFunnelDaySchema = z.object({
  date: z.iso.date(),
  partial_day: z.string().min(1).nullable(),
  spend_eur: z.number().finite().nonnegative().nullable(),
  impressions: measuredCount,
  link_clicks: measuredCount,
  unique_link_clicks_campaign_sum: measuredCount,
  landing_page_views: measuredCount,
  wix_form_submission_occurrences: measuredCount,
  reached_cta_oral: measuredCount,
  booking_clicks: measuredCount,
  booking_confirmed_browser: measuredCount,
  booking_meta_attributed: measuredCount,
  calls_scheduled: measuredCount,
  calls_held: measuredCount,
  offers_made: measuredCount,
  sales: measuredCount,
  cash_collected_eur: measuredMoney,
  contracted_revenue_eur: measuredMoney,
}).strict();

export const kpiFunnelTotalsSchema = kpiFunnelDaySchema.omit({ date: true, partial_day: true }).extend({ wix_distinct_contacts: measuredCount, wix_repeat_occurrences: measuredCount }).strict();

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

const additive = ['spend_eur','impressions','link_clicks','unique_link_clicks_campaign_sum','landing_page_views','wix_form_submission_occurrences','reached_cta_oral','booking_clicks','booking_confirmed_browser','booking_meta_attributed','calls_scheduled','calls_held','offers_made','sales','cash_collected_eur','contracted_revenue_eur'] as const;

export const kpiFunnelSnapshotSchema = baseKpiFunnelSnapshotSchema.superRefine((snapshot, context) => {
  const dates = snapshot.daily.map(row => row.date);
  const expected = requiredDailyDates(snapshot.metadata.window_start, snapshot.metadata.window_end_meta);
  if (new Set(dates).size !== dates.length) context.addIssue({ code: 'custom', path: ['daily'], message: 'Les dates quotidiennes doivent être uniques.' });
  if (dates.join('|') !== expected.join('|')) context.addIssue({ code: 'custom', path: ['daily'], message: 'Chaque date de la fenêtre doit être présente une seule fois et dans l’ordre.' });

  for (const key of additive) {
    const values = snapshot.daily.map(row => row[key]);
    const total = snapshot.totals[key];
    const allMissing = values.every(value => value === null);
    const aggregateProven = ['sales','cash_collected_eur'].includes(key) && snapshot.coverage.some(item => /(sales|ventes|cash)/i.test(item.field_group) && ['available','disponible'].includes(item.status));
    if (allMissing && aggregateProven) continue;
    if (values.some(value => value === null)) {
      if (total !== null) context.addIssue({ code: 'custom', path: ['totals', key], message: 'Un total reste non mesuré quand une journée manque.' });
      continue;
    }
    const scale = ['spend_eur','cash_collected_eur','contracted_revenue_eur'].includes(key) ? 100 : 1;
    const sum = values.reduce<number>((accumulator, value) => accumulator + Math.round((value as number) * scale), 0);
    if (total === null || Math.round(total * scale) !== sum) context.addIssue({ code: 'custom', path: ['totals', key], message: 'Le total ne correspond pas aux lignes quotidiennes.' });
  }

  if (snapshot.totals.wix_form_submission_occurrences === null) {
    if (snapshot.totals.wix_distinct_contacts !== null || snapshot.totals.wix_repeat_occurrences !== null) context.addIssue({ code: 'custom', path: ['totals','wix_distinct_contacts'], message: 'Les contacts et répétitions restent non mesurés sans occurrences.' });
  } else if (snapshot.totals.wix_distinct_contacts === null && snapshot.totals.wix_repeat_occurrences === null) {
    // Occurrences stay measured when identities are incomplete; distinct contacts and repeats remain unknown.
  } else if (snapshot.totals.wix_distinct_contacts === null || snapshot.totals.wix_repeat_occurrences === null || snapshot.totals.wix_distinct_contacts + snapshot.totals.wix_repeat_occurrences !== snapshot.totals.wix_form_submission_occurrences) {
    context.addIssue({ code: 'custom', path: ['totals','wix_distinct_contacts'], message: 'Contacts distincts et répétitions doivent reconstituer les occurrences.' });
  }

  const hasCommercialMoney = [snapshot.totals.cash_collected_eur,snapshot.totals.contracted_revenue_eur,...snapshot.daily.flatMap(row => [row.cash_collected_eur,row.contracted_revenue_eur])].some(value => value !== null);
  const commercialCoverage = snapshot.coverage.some(item => /(sales|ventes|cash|contract)/i.test(item.field_group) && ['available','disponible'].includes(item.status));
  const moneyWithoutSale = snapshot.daily.some(row => (row.cash_collected_eur !== null || row.contracted_revenue_eur !== null) && row.sales === null);
  if (hasCommercialMoney && (!commercialCoverage || snapshot.totals.sales === null || moneyWithoutSale)) context.addIssue({ code: 'custom', path: ['totals'], message: 'Les montants commerciaux exigent une cohorte de ventes et une couverture explicites.' });
});

export type KpiFunnelDay = z.infer<typeof kpiFunnelDaySchema>;
export type KpiFunnelSnapshot = z.infer<typeof kpiFunnelSnapshotSchema>;

export type KpiFunnelResponse =
  | { status: 'ready'; snapshot: KpiFunnelSnapshot }
  | { status: 'missing'; message: string }
  | { status: 'unavailable'; message: string };
