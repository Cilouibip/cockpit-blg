import test from 'node:test';
import assert from 'node:assert/strict';
import { syncKpiSource } from '../src/lib/kpi-source-store';
import { AppError } from '../src/lib/errors';
import { ConnectorError } from '../src/connectors/http';
import type { Database, Row } from '../src/lib/db';

test('failed KPI publication preserves reviewed SQL fault codes and original errors, never private messages or arbitrary codes', async () => {
 for (const [error, expected] of [
  [new AppError('Synthetic private SQL detail',503,'database_query_interrupted'),'database_query_interrupted'],
  [new AppError('Synthetic private SQL detail',503,'database_busy'),'database_busy'],
  [new AppError('Synthetic private SQL detail',503,'synthetic_private_code'),'CONNECTOR_FAILED'],
  [new ConnectorError('UPSTREAM_HTTP_ERROR',503),'UPSTREAM_HTTP_ERROR HTTP 503'],
 ] as const) {
  const calls: string[] = [];let recorded: Row | undefined;
  const db: Database = { probe: async () => {}, select: async () => [], upsert: async () => {}, rpc: async <T>(name: string,args: Row) => {
   calls.push(name);
   if(name==='cockpit_publish_aggregate_state')throw error;
   if(name==='finish_sync')recorded=args;
   return 'synthetic-run' as T;
  } };
  await assert.rejects(syncKpiSource(db,'wix','synthetic-only','2026-09-01','2026-09-02',async()=>({from:'2026-09-01',to:'2026-09-02',observedAt:'2026-09-02T08:00:00Z',rows:[{day:'2026-09-01',key:'synthetic-key',data:{sent:1}}]})), actual=>actual===error);
  assert.deepEqual(calls,['begin_sync_stream','cockpit_publish_aggregate_state','finish_sync']);
  assert.equal(recorded?.p_error,expected);assert.equal(recorded?.p_complete,false);
  assert.equal(JSON.stringify(recorded).includes('private'),false);
 }
});
