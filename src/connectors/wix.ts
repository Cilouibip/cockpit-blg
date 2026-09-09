import { createHash } from 'node:crypto';
import type { SourceAggregate } from '../domain/models';
import { moneyFromDecimal } from '../domain/metrics';
import { validInstant } from '../domain/dates';
import { ConnectorError, object, readJson, safeConnectorError, text } from './http';
import { newBatch, type SyncOptions } from './types';

export interface WixConfig { apiKey?: string; siteId?: string; fetcher?: typeof fetch; sleep?: (ms: number) => Promise<void> }
export interface WixAggregateMapping {
  /** Values copied from a reviewed List → Get result; never inferred from field-name substrings. */
  modelId: string; modelSlug: string; metric: string; measure: string; currencyField: string;
  dependencies: string[]; reviewedAt: string; currencyExponent: number; taxBasis: 'gross' | 'net' | 'unknown';
}
export interface WixAggregateConfig extends WixConfig, SyncOptions<SourceAggregate> { timezone: string; mapping?: WixAggregateMapping }

export function wixConnectionState(config: WixConfig) {
  return !config.apiKey || !config.siteId ? { status: 'not_configured' as const, transactions: false, detail: 'Clé serveur Wix absente ; accès MCP interactif distinct' } : { status: 'configured_unverified' as const, transactions: false, detail: 'Clé configurée ; schéma et agrégats à vérifier' };
}

const base = 'https://www.wixapis.com/analytics/semantic-model/v3/semantic-models';

export async function syncWixAggregates(config: WixAggregateConfig) {
  const batch = newBatch<SourceAggregate>('wix', config.siteId ?? '', 'wix-aggregate-v1', config.from, config.to);
  if (!config.apiKey || !config.siteId) return batch;
  const seen = new Map<string, SourceAggregate>();
  let offset = config.cursor ? Number(config.cursor) : 0;
  if (config.cursor) batch.checkpoint = { cursor: config.cursor };
  try {
    if (!config.mapping) throw new ConnectorError('WIX_REVIEWED_MAPPING_REQUIRED');
    const mapping = config.mapping;
    if (!/^[a-fA-F0-9-]{36}$/.test(config.siteId) || !/^[a-fA-F0-9-]{36}$/.test(mapping.modelId) || !mapping.reviewedAt || !Number.isSafeInteger(offset) || offset < 0 || validInstant(config.from) >= validInstant(config.to)) throw new ConnectorError('INVALID_CONFIGURATION');
    new Intl.DateTimeFormat('en', { timeZone: config.timezone });
    const headers = { Authorization: config.apiKey, 'wix-site-id': config.siteId, 'Content-Type': 'application/json' };
    const models = object(await readJson(new URL(base), { method: 'GET', headers }, config));
    if (!Array.isArray(models.semanticModels) || !models.semanticModels.some(value => { const model = object(value); return model.id === mapping.modelId && model.slug === mapping.modelSlug; })) throw new ConnectorError('WIX_MODEL_IDENTITY_MISMATCH');
    const schema = object(object(await readJson(new URL(`${base}/${mapping.modelId}`), { method: 'GET', headers }, config)).semanticModel);
    if (schema.id !== mapping.modelId) throw new ConnectorError('WIX_MODEL_IDENTITY_MISMATCH');
    const schemaFields = [...(Array.isArray(schema.measures) ? schema.measures : []), ...(Array.isArray(schema.dimensions) ? schema.dimensions : []), ...(Array.isArray(schema.parameters) ? schema.parameters : [])].map(object);
    const fields = [...new Set([mapping.measure, mapping.currencyField, ...mapping.dependencies])];
    for (const name of fields) {
      const field = schemaFields.find(item => item.name === name);
      if (!field || (Array.isArray(field.dependencies) && field.dependencies.length && !field.dependencies.some(dependency => fields.includes(String(dependency))))) throw new ConnectorError('WIX_SCHEMA_CHANGED');
    }
    for (let page = 0; page < Math.min(config.maxPages ?? 20, 100); page++) {
      const payload = object(await readJson(new URL(`${base}/query-data`), { method: 'POST', headers, body: JSON.stringify({ semanticModelId: mapping.modelId, interval: { start: config.from, end: config.to, timezone: config.timezone }, fields, paging: { limit: 100, offset }, totalsIncluded: false, formattingEnabled: false }) }, config));
      if (!Array.isArray(payload.results)) throw new ConnectorError('INVALID_RESPONSE');
      const records: SourceAggregate[] = [];
      for (const raw of payload.results) {
        batch.counts.read++;
        try {
          const cells = object(object(raw).fields);
          if (fields.some(field => !(field in cells))) throw new ConnectorError('WIX_FIELD_MISSING');
          const currency = text(object(cells[mapping.currencyField]).stringValue);
          const amount = object(cells[mapping.measure]).numericValue;
          if (!currency || (typeof amount !== 'number' && typeof amount !== 'string')) throw new ConnectorError('INVALID_ROW');
          const dimensions: Record<string, string> = {};
          for (const field of mapping.dependencies) { const value = object(cells[field]); const scalar = value.stringValue ?? value.timestampValue ?? value.numericValue; if (typeof scalar !== 'string' && typeof scalar !== 'number') throw new ConnectorError('INVALID_ROW'); dimensions[field] = String(scalar); }
          const externalId = createHash('sha256').update(JSON.stringify([mapping.modelId, mapping.measure, config.from, config.to, config.timezone, currency, Object.entries(dimensions).sort()])).digest('hex');
          records.push({ source: 'wix', accountId: config.siteId, externalId, observedAt: config.now?.() ?? new Date().toISOString(), connectorVersion: batch.version,
            metric: mapping.metric, from: config.from, to: config.to, timezone: config.timezone, amount: moneyFromDecimal(String(amount), currency, mapping.currencyExponent), count: null, taxBasis: mapping.taxBasis, dimensions, transactionGrain: false });
        } catch { batch.counts.rejected++; }
      }
      const metadata = object(payload.pagingMetadata);
      if (metadata.count !== payload.results.length || (metadata.offset !== undefined && metadata.offset !== offset)) throw new ConnectorError('INVALID_PAGINATION');
      const more = payload.results.length === 100;
      const checkpoint = more ? { cursor: String(offset + 100) } : batch.counts.rejected === 0 ? { completedThrough: config.to } : {};
      await config.commitPage?.({ records, checkpoint, terminal: !more });
      records.forEach(record => seen.set(record.externalId, record)); batch.checkpoint = checkpoint; batch.counts.pages++; batch.counts.accepted = seen.size;
      if (!more) {
        batch.records = [...seen.values()]; batch.status = batch.counts.rejected ? 'partial' : seen.size ? 'complete' : 'empty';
        batch.coverage = { from: config.from, to: config.to, complete: batch.counts.rejected === 0, reason: batch.counts.rejected ? 'Champs absents ou lignes rejetées' : seen.size ? 'Agrégats uniquement ; aucune identité transactionnelle' : 'Aucune mesure renvoyée ; ne signifie pas zéro' };
        return batch;
      }
      offset += 100;
    }
    throw new ConnectorError('PAGE_LIMIT_REACHED');
  } catch (error) { batch.records = [...seen.values()]; batch.status = seen.size ? 'partial' : 'failed'; batch.safeError = safeConnectorError(error); batch.coverage.reason = 'Import incomplet ; transactions individuelles non disponibles'; return batch; }
}
