import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { ConnectorError, integer, object, readJson } from './http';
import { moneyFromDecimal } from '../domain/metrics';
import { previousCalendarDay } from '../domain/dates';
import type { KpiSourceBatch, KpiWindowRow } from '../lib/kpi-source-store';

// Campaign scope already used by the reviewed masterclass table, plus the explicitly prepared replacement campaign.
export const KPI_MASTERCLASS_CAMPAIGNS = ['120248692698770714','120248692706180714','120248808857790714'];
/** Campagnes Masterclass : surcharge serveur `BLG_KPI_MASTERCLASS_CAMPAIGN_IDS` (identifiants numériques seulement), sinon la liste du code. */
export function kpiMasterclassCampaigns(env: NodeJS.ProcessEnv): string[] {
 return (env.BLG_KPI_MASTERCLASS_CAMPAIGN_IDS?.trim() || undefined)?.split(',').map(v => v.trim()).filter(v => /^\d+$/.test(v)) ?? KPI_MASTERCLASS_CAMPAIGNS;
}
/** Identifiant stable d'un jeu de campagnes (ordre indifférent) : liste triée, ou empreinte si elle est trop longue. */
export function kpiCampaignSetKey(ids: readonly string[]): string {
 const sorted = [...new Set(ids)].sort(), joined = sorted.join(',');
 return joined.length <= 180 ? joined : `sha256:${createHash('sha256').update(joined).digest('hex').slice(0, 32)}`;
}
/** Clé des lignes « niveau compte » d'un jour (uniques dédoublonnés entre campagnes). */
export const kpiAccountRowKey = (ids: readonly string[]) => `account:${kpiCampaignSetKey(ids)}`;
/** Fenêtres CTRU lues à la source : 3, 7 et 30 derniers jours finissant hier et finissant aujourd'hui (ambiguïté 6). */
export const KPI_WINDOW_LENGTHS = [3, 7, 30] as const;
export function kpiWindows(from: string, to: string): { since: string; until: string }[] {
 const today = Temporal.PlainDate.from(previousCalendarDay(to)), windows: { since: string; until: string }[] = [];
 for (const end of [today.subtract({ days: 1 }), today]) for (const length of KPI_WINDOW_LENGTHS) {
  const since = end.subtract({ days: length - 1 }).toString();
  if (since >= from) windows.push({ since, until: end.toString() });
 }
 return windows;
}
/** Clics sortants Meta : liste d'actions `outbound_click` ; omise = inconnue (sauf diffusion nulle), jamais un zéro inventé. */
function outboundClicks(row: Record<string, unknown>): number | null {
 if (row.outbound_clicks === undefined || row.outbound_clicks === null) return integer(row.impressions) === 0 ? 0 : null;
 if (!Array.isArray(row.outbound_clicks)) throw new ConnectorError('INVALID_META_COUNT');
 const found = row.outbound_clicks.map(object).filter(action => action.action_type === 'outbound_click');
 if (found.length > 1) throw new ConnectorError('INVALID_META_COUNT');
 return found.length ? integer(found[0].value) : 0;
}
const UNIQUE_FIELDS = 'account_id,date_start,date_stop,reach,impressions,inline_link_clicks,unique_inline_link_clicks,outbound_clicks';
const uniqueData = (row: Record<string, unknown>, campaignIds: string[]) => ({ level: 'account', campaignIds, reach: integer(row.reach), impressions: integer(row.impressions), link_clicks: integer(row.inline_link_clicks), unique_link_clicks: integer(row.unique_inline_link_clicks), outbound_clicks: outboundClicks(row) });

/** Same documented source measures as the reviewed table; campaign-day unique clicks are never deduplicated across days.
 * U8b : la lecture campagne × jour ajoute `reach` et `outbound_clicks` ; une lecture niveau compte par jour, filtrée sur les
 * campagnes Masterclass, donne les comptes uniques dédoublonnés entre campagnes ; six lectures de fenêtre (même niveau et
 * filtre, sans découpage par jour) donnent les uniques de la fenêtre entière. Aucune somme d'uniques, aucune moyenne. */
export async function readKpiMeta(from: string, to: string, env: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch): Promise<KpiSourceBatch> {
 const accountId = env.META_AD_ACCOUNT_ID?.replace(/^act_/, ''), version = env.META_API_VERSION || 'v23.0';
 if (!accountId || !/^\d+$/.test(accountId) || !env.META_ACCESS_TOKEN || !/^v\d+\.0$/.test(version)) throw new ConnectorError('KPI_META_CONFIGURATION');
 const headers = { Authorization: `Bearer ${env.META_ACCESS_TOKEN}` };
 const accountUrl = new URL(`https://graph.facebook.com/${version}/act_${accountId}`);accountUrl.searchParams.set('fields', 'account_id,currency,timezone_name');
 const account = object(await readJson(accountUrl, { headers }, { fetcher, attempts: 1 }));
 if (account.account_id !== accountId || account.currency !== 'EUR' || account.timezone_name !== 'Europe/Paris') throw new ConnectorError('ACCOUNT_IDENTITY_MISMATCH');
 const rows: KpiSourceBatch['rows'] = [], cursors = new Set<string>(); let cursor: string | null = null;
 const observedAt = new Date().toISOString(), lastDay = previousCalendarDay(to);
 for (let page = 0; page < 20; page++) {
  const url = new URL(`https://graph.facebook.com/${version}/act_${accountId}/insights`);
  url.searchParams.set('fields', 'account_id,campaign_id,campaign_name,date_start,date_stop,spend,impressions,reach,inline_link_clicks,unique_inline_link_clicks,outbound_clicks,actions');
  url.searchParams.set('level', 'campaign');url.searchParams.set('time_increment', '1');url.searchParams.set('limit', '500');
  url.searchParams.set('time_range', JSON.stringify({ since: from, until: lastDay }));
  url.searchParams.set('action_attribution_windows', JSON.stringify(['7d_click', '1d_view']));url.searchParams.set('action_report_time', 'impression');
  if (cursor) url.searchParams.set('after', cursor);
  const payload = object(await readJson(url, { headers }, { fetcher, attempts: 1 }));
  if (!Array.isArray(payload.data)) throw new ConnectorError('INVALID_RESPONSE');
  for (const raw of payload.data) {
   const row = object(raw), day = row.date_start, id = row.campaign_id;
   if (row.account_id !== accountId || typeof day !== 'string' || day < from || day >= to || row.date_stop !== day || typeof id !== 'string' || !/^\d+$/.test(id)) throw new ConnectorError('KPI_META_SCOPE');
   const actions = Array.isArray(row.actions) ? row.actions.map(object) : null;
   // The exact custom conversion must be configured, never replaced by the generic Schedule action.
   const action = (name: string | undefined): number | null => { if (!name || !actions) return null; const found = actions.filter(a => a.action_type === name); if (found.length > 1) throw new ConnectorError('KPI_META_DUPLICATE_ACTION'); return found.length ? integer(found[0].value) : 0; };
   rows.push({ day, key: id, data: { campaignId: id, spend_eur: row.spend == null ? null : moneyFromDecimal(String(row.spend), 'EUR', 2).minor / 100, impressions: integer(row.impressions), link_clicks: integer(row.inline_link_clicks), unique_link_clicks_campaign_sum: integer(row.unique_inline_link_clicks), reach: integer(row.reach), outbound_clicks: outboundClicks(row), landing_page_views: action('landing_page_view'), booking_meta_attributed: action(env.BLG_KPI_META_BOOKING_ACTION || 'offsite_conversion.custom.2154825181913636') } });
  }
  const paging = payload.paging ? object(payload.paging) : {};
  if (!paging.next) {
   const campaigns = [...kpiMasterclassCampaigns(env)].sort();
   // Interrupteur serveur : BLG_KPI_META_UNIQUE_READS=off supprime les 7 lectures de plus (CTRU non mesuré, dépense inchangée).
   if (!campaigns.length || env.BLG_KPI_META_UNIQUE_READS === 'off') return { from, to, observedAt, rows };
   // Niveau compte, filtré sur les campagnes Masterclass : un compte touché par deux campagnes compte une fois.
   const unique = async (range: { since: string; until: string }, daily: boolean) => {
    const url = new URL(`https://graph.facebook.com/${version}/act_${accountId}/insights`);
    url.searchParams.set('fields', UNIQUE_FIELDS);url.searchParams.set('level', 'account');url.searchParams.set('limit', '500');
    url.searchParams.set('filtering', JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: campaigns }]));
    if (daily) url.searchParams.set('time_increment', '1');
    url.searchParams.set('time_range', JSON.stringify(range));
    return object(await readJson(url, { headers }, { fetcher, attempts: 1 }));
   };
   const accountRows = await unique({ since: from, until: lastDay }, true);
   if (!Array.isArray(accountRows.data) || (accountRows.paging && object(accountRows.paging).next)) throw new ConnectorError('KPI_META_ACCOUNT_SCOPE');
   const accountKey = kpiAccountRowKey(campaigns), seen = new Set<string>();
   for (const raw of accountRows.data) {
    const row = object(raw), day = row.date_start;
    if (row.account_id !== accountId || typeof day !== 'string' || day < from || day >= to || row.date_stop !== day || seen.has(day)) throw new ConnectorError('KPI_META_ACCOUNT_SCOPE');
    seen.add(day);rows.push({ day, key: accountKey, data: uniqueData(row, campaigns) });
   }
   // Fenêtres : une lecture par fenêtre (time_range sans découpage par jour). Une fenêtre sans diffusion est lue vide (data null).
   const windows: KpiWindowRow[] = [];
   for (const range of kpiWindows(from, to)) {
    const payload = await unique(range, false);
    if (!Array.isArray(payload.data) || payload.data.length > 1 || (payload.paging && object(payload.paging).next)) throw new ConnectorError('KPI_META_WINDOW_SCOPE');
    const row = payload.data.length ? object(payload.data[0]) : null;
    if (row && (row.account_id !== accountId || row.date_start !== range.since || row.date_stop !== range.until)) throw new ConnectorError('KPI_META_WINDOW_SCOPE');
    windows.push({ from: range.since, to: Temporal.PlainDate.from(range.until).add({ days: 1 }).toString(), key: kpiCampaignSetKey(campaigns), data: row ? uniqueData(row, campaigns) : null });
   }
   return { from, to, observedAt, rows, windows };
  }
  const next = paging.cursors ? object(paging.cursors).after : null;
  if (typeof next !== 'string' || !next || cursors.has(next)) throw new ConnectorError('INVALID_PAGINATION');cursors.add(next);cursor = next;
 }
 throw new ConnectorError('PAGE_LIMIT_REACHED');
}
