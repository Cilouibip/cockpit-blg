import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { kpiFunnelSnapshotSchema, type KpiFunnelResponse } from './kpi-funnel-contract';

const MAX_SNAPSHOT_BYTES = 2_000_000;

type KpiFunnelEnvironment = { BLG_KPI_FUNNEL_JSON?: string; BLG_KPI_FUNNEL_PATH?: string };

export async function readKpiFunnelSnapshot(env: KpiFunnelEnvironment = { BLG_KPI_FUNNEL_JSON: process.env.BLG_KPI_FUNNEL_JSON, BLG_KPI_FUNNEL_PATH: process.env.BLG_KPI_FUNNEL_PATH }): Promise<KpiFunnelResponse> {
  const inline = env.BLG_KPI_FUNNEL_JSON?.trim();
  const configured = env.BLG_KPI_FUNNEL_PATH?.trim();
  if (!inline && !configured) return { status: 'missing', message: 'Aucun relevé chargé.' };
  if (!inline && (!configured || !path.isAbsolute(configured))) return { status: 'unavailable', message: 'Le relevé configuré ne peut pas être lu.' };

  try {
    const raw = inline ?? await readFile(configured!, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_SNAPSHOT_BYTES) return { status: 'unavailable', message: 'Le relevé configuré est trop volumineux.' };
    const parsed: unknown = JSON.parse(raw);
    const snapshot = kpiFunnelSnapshotSchema.parse(parsed);
    return { status: 'ready', snapshot };
  } catch {
    return { status: 'unavailable', message: 'Le relevé configuré ne peut pas être lu.' };
  }
}
