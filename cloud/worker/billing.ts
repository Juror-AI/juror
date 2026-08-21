import { calculateRunCost, isRunBillable } from '../../src/cloud/billing';
import type { QaOutcome } from '../../src/qa/types';
import type { Env } from './env';

interface FinalizeUsageInput {
  runId: string;
  kind: 'review' | 'qa';
  outcome: 'completed' | 'no_usable_model_result' | QaOutcome;
  providerMicroUsd: number;
  sandboxMicroUsd: number;
  storageMicroUsd: number;
}

export async function finalizeUsage(env: Env, input: FinalizeUsageInput): Promise<void> {
  const run = await env.DB.prepare('SELECT workspace_id, status FROM run WHERE id = ?').bind(input.runId).first<{ workspace_id: string; status: string }>();
  if (!run) throw new Error('Run not found while finalizing usage');
  const effectiveOutcome = run.status === 'cancelled' ? 'cancelled' : input.outcome;
  const billable = isRunBillable(input.kind, effectiveOutcome);
  const receipt = calculateRunCost({ providerMicroUsd: input.providerMicroUsd, sandboxMicroUsd: input.sandboxMicroUsd, storageMicroUsd: input.storageMicroUsd });
  const charged = billable ? receipt.billableMicroUsd : 0;
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO usage_ledger (id, workspace_id, run_id, provider_micro_usd, sandbox_micro_usd, storage_micro_usd, service_fee_micro_usd, billable_micro_usd, trial_debit_micro_usd, invoice_micro_usd, trial_applied_at, created_at)
      SELECT ?, w.id, ?, ?, ?, ?, ?, ?, MIN(w.trial_remaining_micro_usd, ?), ? - MIN(w.trial_remaining_micro_usd, ?), NULL, ? FROM workspace w WHERE w.id = ?`)
      .bind(`ledger_${input.runId}`, input.runId, input.providerMicroUsd, input.sandboxMicroUsd, input.storageMicroUsd, billable ? receipt.serviceFeeMicroUsd : 0, charged, charged, charged, charged, now, run.workspace_id),
    env.DB.prepare(`UPDATE workspace SET trial_remaining_micro_usd = MAX(0, trial_remaining_micro_usd - (SELECT trial_debit_micro_usd FROM usage_ledger WHERE run_id = ?)), updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM usage_ledger WHERE run_id = ? AND trial_applied_at IS NULL)`)
      .bind(input.runId, now, run.workspace_id, input.runId),
    env.DB.prepare('UPDATE usage_ledger SET trial_applied_at = ? WHERE run_id = ? AND trial_applied_at IS NULL')
      .bind(now, input.runId),
    env.DB.prepare(`UPDATE run SET provider_micro_usd = ?, sandbox_micro_usd = ?, storage_micro_usd = ?, service_fee_micro_usd = ?, billable_micro_usd = ?, reserved_micro_usd = 0, billable = ?, updated_at = ? WHERE id = ?`)
      .bind(input.providerMicroUsd, input.sandboxMicroUsd, input.storageMicroUsd, billable ? receipt.serviceFeeMicroUsd : 0, charged, billable ? 1 : 0, now, input.runId),
  ]);

  const ledger = await env.DB.prepare('SELECT invoice_micro_usd FROM usage_ledger WHERE run_id = ?').bind(input.runId).first<{ invoice_micro_usd: number }>();
  if (!ledger) throw new Error('Usage ledger was not created');
  if (ledger.invoice_micro_usd > 0) {
    try {
      await env.WEBHOOK_QUEUE.send({ kind: 'stripe_meter', runId: input.runId }, { contentType: 'json' });
    } catch (error) {
      // Usage is already in the idempotent D1 ledger. Do not turn a successful customer
      // run into an infrastructure failure because Stripe or Queues is temporarily down;
      // the scheduled reconciliation pass will enqueue it again.
      console.error(JSON.stringify({ message: 'Stripe meter event enqueue failed', runId: input.runId, error: error instanceof Error ? error.message : String(error) }));
    }
  }
}

export async function emitStripeMeterEvent(env: Env, runId: string): Promise<void> {
  const row = await env.DB.prepare(`SELECT ul.workspace_id, ul.invoice_micro_usd, ul.stripe_meter_emitted_at, sc.stripe_customer_id FROM usage_ledger ul LEFT JOIN stripe_customer sc ON sc.workspace_id = ul.workspace_id WHERE ul.run_id = ?`)
    .bind(runId).first<{ workspace_id: string; invoice_micro_usd: number; stripe_meter_emitted_at: string | null; stripe_customer_id: string | null }>();
  if (!row || row.invoice_micro_usd <= 0 || row.stripe_meter_emitted_at) return;
  if (!row.stripe_customer_id) throw new Error('Billable usage has no Stripe customer');

  const body = new URLSearchParams();
  body.set('event_name', env.STRIPE_METER_EVENT_NAME);
  body.set('identifier', `juror:${runId}`);
  body.set('payload[stripe_customer_id]', row.stripe_customer_id);
  body.set('payload[value]', String(row.invoice_micro_usd));
  body.set('timestamp', String(Math.floor(Date.now() / 1000)));
  const response = await fetch('https://api.stripe.com/v1/billing/meter_events', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': `juror-run-${runId}` },
    body,
  });
  if (!response.ok) throw new Error(`Stripe meter event failed (${response.status})`);
  await env.DB.prepare('UPDATE usage_ledger SET stripe_meter_event_name = ?, stripe_meter_emitted_at = ? WHERE run_id = ? AND stripe_meter_emitted_at IS NULL')
    .bind(env.STRIPE_METER_EVENT_NAME, new Date().toISOString(), runId).run();
}

export async function reconcileStripeMeterEvents(env: Env): Promise<number> {
  const pending = await env.DB.prepare(`SELECT run_id FROM usage_ledger WHERE invoice_micro_usd > 0 AND stripe_meter_emitted_at IS NULL ORDER BY created_at LIMIT 100`)
    .all<{ run_id: string }>();
  let queued = 0;
  for (const ledger of pending.results) {
    try {
      await env.WEBHOOK_QUEUE.send({ kind: 'stripe_meter', runId: ledger.run_id }, { contentType: 'json' });
      queued += 1;
    } catch (error) {
      console.error(JSON.stringify({ message: 'Stripe meter reconciliation enqueue failed', runId: ledger.run_id, error: error instanceof Error ? error.message : String(error) }));
      break;
    }
  }
  return queued;
}

export function sandboxCostMicroUsd(env: Env, kind: 'review' | 'qa', durationMs: number, cpuTimeMs: number): number {
  const cpuPerSecond = Number(env.CONTAINER_CPU_MICRO_USD_PER_VCPU_SECOND ?? '0');
  const memoryPerSecond = Number(env.CONTAINER_MEMORY_MICRO_USD_PER_GIB_SECOND ?? '0');
  const diskPerSecond = Number(env.CONTAINER_DISK_MICRO_USD_PER_GB_SECOND ?? '0');
  if (![cpuPerSecond, memoryPerSecond, diskPerSecond].every((rate) => Number.isFinite(rate) && rate >= 0)) throw new Error('Invalid Container micro-USD rate');
  if (!Number.isFinite(durationMs) || durationMs < 0 || !Number.isFinite(cpuTimeMs) || cpuTimeMs < 0) throw new Error('Invalid Container usage measurement');
  const resources = kind === 'review' ? { vCpu: 2, memoryGib: 8, diskGb: 16 } : { vCpu: 1, memoryGib: 6, diskGb: 12 };
  const durationSeconds = durationMs / 1000;
  const cpuSeconds = Math.min(cpuTimeMs / 1000, resources.vCpu * durationSeconds);
  return Math.ceil(cpuSeconds * cpuPerSecond + durationSeconds * (resources.memoryGib * memoryPerSecond + resources.diskGb * diskPerSecond));
}

export function retainedStorageCostMicroUsd(env: Env, reportBytes: number, evidenceBytes: number): number {
  const perGbMonth = Number.parseInt(env.R2_STORAGE_MICRO_USD_PER_GB_MONTH ?? '0', 10);
  if (!Number.isSafeInteger(perGbMonth) || perGbMonth < 0) throw new Error('Invalid R2 storage micro-USD rate');
  const gb = 1000 ** 3;
  return Math.ceil((reportBytes / gb * (365 / 30) + evidenceBytes / gb * (90 / 30)) * perGbMonth);
}
