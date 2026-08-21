import { boundRunEventMessage, RUN_EVENT_SCHEMA_VERSION, type RunEventStatus, type RunPhase } from '../../src/cloud/types';
import type { Env } from './env';

export async function appendRunEvent(env: Env, runId: string, phase: RunPhase, status: RunEventStatus, message: string, metrics: Record<string, number> = {}): Promise<number> {
  const inserted = await env.DB.prepare(`INSERT INTO run_event (run_id, sequence, timestamp, phase, status, message, metrics_json) SELECT ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ?, ?, ? FROM run_event WHERE run_id = ? RETURNING sequence`)
    .bind(runId, new Date().toISOString(), phase, status, boundRunEventMessage(message), JSON.stringify({ schemaVersion: RUN_EVENT_SCHEMA_VERSION, ...metrics }), runId).first<{ sequence: number }>();
  if (!inserted) throw new Error('Run event could not be appended');
  return inserted.sequence;
}

export async function updateRunPhase(env: Env, runId: string, phase: RunPhase, status: string, message: string, metrics: Record<string, number> = {}): Promise<boolean> {
  const now = new Date().toISOString();
  const updated = await env.DB.prepare(`UPDATE run SET phase = ?, status = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND status IN ('queued','running')`)
    .bind(phase, status, now, now, runId).run();
  if (!updated.meta.changes) return false;
  await appendRunEvent(env, runId, phase, status === 'succeeded' ? 'succeeded' : status === 'failed' ? 'failed' : status === 'cancelled' ? 'cancelled' : status === 'warning' || status === 'blocked' ? 'warning' : 'running', message, metrics);
  return true;
}
