import type { AppointmentStatus, Evidence } from '../domain/models';
import { ConnectorError, object, readJson, safeConnectorError, text } from './http';
import { newBatch, type SyncOptions } from './types';

export type CommercialField = 'name' | 'status' | 'responsible' | 'closer' | 'appointmentAt' | 'nextFollowUpAt';
/** Schema-only GET verified 2026-09-07. No prospect rows or personal fields were needed. */
export const BLG_NOTION_FIELDS: Record<CommercialField, string> = {
  name: 'Nom complet', status: 'Etat', responsible: 'Animateur RDV', closer: 'Closer',
  appointmentAt: 'Date du RDV', nextFollowUpAt: 'À relancer le',
};
export interface NotionProspect extends Evidence {
  source: 'notion'; personId: null; name: string | null; status: string | null; responsible: string[]; closer: string[];
  appointmentAt: string | null; nextFollowUpAt: string | null; appointmentStatus: AppointmentStatus;
  archived: boolean; notionUrl: string; mappingVersion: string;
}
export interface NotionConfig extends SyncOptions<NotionProspect> {
  token?: string; dataSourceId?: string;
  /** Fixed reviewed schema property names or IDs. There is deliberately no arbitrary properties passthrough. */
  fields: Partial<Record<CommercialField, string>>; mappingVersion: string;
  statusMapping?: Record<string, AppointmentStatus>;
}

function richText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const rendered = value.map(item => text(object(item).plain_text) ?? '').join('').slice(0, 300);
  return rendered || null;
}
function field(properties: Record<string, unknown>, name: string | undefined): Record<string, unknown> | null {
  if (!name) return null;
  const byName = properties[name];
  if (byName) return object(byName);
  return Object.values(properties).map(object).find(property => property.id === name) ?? null;
}
function selected(property: Record<string, unknown> | null): string | null {
  if (!property) return null;
  const value = property.select ?? property.status;
  return value ? text(object(value).name) : null;
}
function people(property: Record<string, unknown> | null): string[] {
  // Source select label, or opaque people/relation IDs. Never user emails/profile images.
  if (!property) return [];
  if (property.select) { const label = text(object(property.select).name); return label ? [label.slice(0, 150)] : []; }
  const entries = property.people ?? property.relation;
  if (!Array.isArray(entries)) return [];
  return entries.map(value => text(object(value).id)).filter((value): value is string => !!value).slice(0, 25);
}
function date(property: Record<string, unknown> | null): string | null {
  const value = property?.date ? text(object(property.date).start) : null;
  return value ?? null; // Date-only values stay date-only; never invent a time or attendance.
}

export async function syncNotion(config: NotionConfig) {
  const accountId = config.dataSourceId ?? '';
  const batch = newBatch<NotionProspect>('notion', accountId, 'notion-read-v1', config.from, config.to);
  if (!config.token || !accountId) return batch;
  let cursor = config.cursor;
  if (cursor) batch.checkpoint = { cursor };
  const seen = new Map<string, NotionProspect>(), cursors = new Set<string>();
  try {
    if (!/^[a-fA-F0-9-]{32,36}$/.test(accountId) || !config.mappingVersion || !config.fields.name || !config.fields.status) throw new ConnectorError('NOTION_FIELD_MAPPING_REQUIRED');
    if (!Number.isFinite(Date.parse(config.from)) || !Number.isFinite(Date.parse(config.to)) || Date.parse(config.from) >= Date.parse(config.to)) throw new ConnectorError('INVALID_CONFIGURATION');
    const allowedFields: CommercialField[] = ['name', 'status', 'responsible', 'closer', 'appointmentAt', 'nextFollowUpAt'];
    if (Object.keys(config.fields).some(key => !allowedFields.includes(key as CommercialField))) throw new ConnectorError('UNSAFE_FIELD_MAPPING');
    for (let page = 0; page < Math.min(config.maxPages ?? 20, 100); page++) {
      const url = new URL(`https://api.notion.com/v1/data_sources/${accountId}/query`);
      for (const property of Object.values(config.fields)) if (property) url.searchParams.append('filter_properties[]', property);
      if (cursor) { if (cursors.has(cursor)) throw new ConnectorError('PAGINATION_LOOP'); cursors.add(cursor); }
      const body = { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}),
        filter: { and: [{ timestamp: 'last_edited_time', last_edited_time: { on_or_after: config.from } }, { timestamp: 'last_edited_time', last_edited_time: { before: config.to } }] },
        sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }] };
      // This POST queries data. No write endpoint, page blocks or unreviewed free-form fields are used.
      const payload = object(await readJson(url, { method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, config));
      if (!Array.isArray(payload.results) || typeof payload.has_more !== 'boolean') throw new ConnectorError('INVALID_RESPONSE');
      const records: NotionProspect[] = [];
      for (const raw of payload.results) {
        batch.counts.read++;
        try {
          const pageRow = object(raw), id = text(pageRow.id), updatedAt = text(pageRow.last_edited_time), properties = object(pageRow.properties);
          if (!id || !/^[a-fA-F0-9-]{32,36}$/.test(id) || !updatedAt || !Number.isFinite(Date.parse(updatedAt))) throw new ConnectorError('INVALID_ROW');
          const nameProperty = field(properties, config.fields.name), sourceStatus = selected(field(properties, config.fields.status));
          const status = sourceStatus ? config.statusMapping?.[sourceStatus] : undefined;
          const record: NotionProspect = { source: 'notion', accountId, externalId: id, connectorVersion: batch.version, observedAt: config.now?.() ?? new Date().toISOString(), sourceUpdatedAt: updatedAt,
            personId: null, name: richText(nameProperty?.title), status: sourceStatus, responsible: people(field(properties, config.fields.responsible)), closer: people(field(properties, config.fields.closer)),
            appointmentAt: date(field(properties, config.fields.appointmentAt)), nextFollowUpAt: date(field(properties, config.fields.nextFollowUpAt)),
            // A current CRM status alone cannot prove attendance; preserve an explicit mapping as a proposal.
            appointmentStatus: status === 'attended' ? 'unknown' : status ?? 'unknown', archived: pageRow.archived === true || pageRow.in_trash === true,
            notionUrl: `https://www.notion.so/${id.replace(/-/g, '')}`, mappingVersion: config.mappingVersion };
          records.push(record);
        } catch { batch.counts.rejected++; }
      }
      const next = payload.has_more ? text(payload.next_cursor) : null;
      if (payload.has_more && (!next || next.length > 4096)) throw new ConnectorError('INVALID_PAGINATION');
      const checkpoint = next ? { cursor: next } : batch.counts.rejected === 0 && batch.counts.read < 10_000 ? { completedThrough: config.to } : {};
      await config.commitPage?.({ records, checkpoint, terminal: !payload.has_more });
      records.forEach(record => seen.set(record.externalId, record));
      batch.checkpoint = checkpoint; batch.counts.pages++; batch.counts.accepted = seen.size;
      if (!payload.has_more) {
        const complete = batch.counts.rejected === 0 && batch.counts.read < 10_000;
        batch.records = [...seen.values()]; batch.status = !complete ? 'partial' : seen.size ? 'complete' : 'empty';
        batch.coverage = { from: config.from, to: config.to, complete, reason: !complete ? 'Lignes rejetées ou plafond de requête atteint' : seen.size ? 'État courant observé ; aucun historique antérieur fabriqué' : 'Aucune modification dans cette période', observedAt: config.now?.() ?? new Date().toISOString() };
        return batch;
      }
      cursor = next!;
    }
    throw new ConnectorError('PAGE_LIMIT_REACHED');
  } catch (error) {
    batch.records = [...seen.values()]; batch.status = seen.size ? 'partial' : 'failed'; batch.safeError = safeConnectorError(error); batch.coverage.reason = 'Import interrompu ; reprise au dernier checkpoint validé'; return batch;
  }
}
