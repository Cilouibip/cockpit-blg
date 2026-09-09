import test from 'node:test';
import assert from 'node:assert/strict';
import { BLG_NOTION_FIELDS, syncNotionSnapshot } from '../src/connectors/notion';

function source(size: number, sameInstant = false) {
  const from = Date.parse('2026-01-02T00:00:00Z');
  const rows = Array.from({ length: size }, (_, index) => ({
    id: `11111111-1111-4111-8111-${index.toString(16).padStart(12, '0')}`,
    last_edited_time: new Date(from + (sameInstant ? 0 : index * 1000)).toISOString(),
    properties: { 'Nom complet': { title: [{ plain_text: 'Exemple de test' }] }, Etat: { select: { name: 'Acquis' } } },
  }));
  const intervals: string[][] = [];
  const fetcher = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const lower = body.filter.and[0].last_edited_time.on_or_after;
    const upper = body.filter.and[1].last_edited_time.before;
    if (!body.start_cursor) intervals.push([lower, upper]);
    const filtered = rows.filter(row => row.last_edited_time >= lower && row.last_edited_time < upper).slice(0, 10_000);
    const offset = Number(body.start_cursor || 0);
    const more = offset + 100 < filtered.length;
    return new Response(JSON.stringify({ results: filtered.slice(offset, offset + 100), has_more: more, next_cursor: more ? String(offset + 100) : null }));
  }) as typeof fetch;
  return { rows, fetcher, intervals };
}

test('a truncated 10,000-row query is split and all later prospects are imported exactly once in the snapshot', async () => {
  const fixture = source(12_050);
  const persisted = new Map<string, unknown>();
  const result = await syncNotionSnapshot({ token: 'synthetic', dataSourceId: '22222222-2222-4222-8222-222222222222', fields: BLG_NOTION_FIELDS, mappingVersion: 'test', from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z', fetcher: fixture.fetcher,
    commitPage: async page => { for (const row of page.records) persisted.set(row.externalId, row); },
  });
  assert.equal(result.status, 'complete'); assert.equal(result.coverage.complete, true);
  assert.equal(result.records.length, 12_050); assert.equal(persisted.size, 12_050);
  assert.equal(result.records.at(-1)?.externalId, fixture.rows.at(-1)?.id);
  assert.equal(fixture.intervals.length, 3);
  assert.equal(fixture.intervals[1][1], fixture.intervals[2][0]);
  assert.equal(result.coverage.from, '2026-01-01T00:00:00.000Z');
  assert.equal(result.coverage.to, '2026-02-01T00:00:00.000Z');
});

test('an unsplittable mass edit never becomes a complete snapshot', async () => {
  const fixture = source(10_001, true);
  const result = await syncNotionSnapshot({ token: 'synthetic', dataSourceId: '22222222-2222-4222-8222-222222222222', fields: BLG_NOTION_FIELDS, mappingVersion: 'test', from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z', fetcher: fixture.fetcher });
  assert.equal(result.status, 'partial'); assert.equal(result.coverage.complete, false);
  assert.equal(result.safeError, 'NOTION_INTERVAL_TOO_DENSE');
  assert.equal(result.records.length, 10_000);
});
