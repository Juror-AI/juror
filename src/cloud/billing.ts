import type { QaOutcome } from '../qa/types.js';
import type { ReviewPreset } from '../types.js';

export const MICRO_USD_PER_USD = 1_000_000;
export const SERVICE_FEE_BPS = 2_500;
export const BPS_DENOMINATOR = 10_000;
export const TRIAL_CREDIT_MICRO_USD = 10 * MICRO_USD_PER_USD;
export const DEFAULT_MONTHLY_CAP_MICRO_USD = 100 * MICRO_USD_PER_USD;

const REVIEW_RESERVATION_MICRO_USD: Record<ReviewPreset, number> = {
  starter: 5 * MICRO_USD_PER_USD,
  fast: 8 * MICRO_USD_PER_USD,
  balanced: 30 * MICRO_USD_PER_USD,
  high: 50 * MICRO_USD_PER_USD,
  ultra: 100 * MICRO_USD_PER_USD,
};

/** Maximum customer charge admitted for a hosted run; any operator-cost overflow is non-billable. */
export function maximumRunReservationMicroUsd(kind: BillableRunKind, preset: ReviewPreset = 'fast'): number {
  return kind === 'qa' ? 10 * MICRO_USD_PER_USD : REVIEW_RESERVATION_MICRO_USD[preset];
}

export type BillableRunKind = 'review' | 'qa';
export type RunBillingOutcome =
  | 'completed'
  | 'no_usable_model_result'
  | 'infrastructure_error'
  | 'cancelled'
  | QaOutcome;

export interface DirectRunCost {
  providerMicroUsd: number;
  sandboxMicroUsd: number;
  storageMicroUsd: number;
}

export interface RunCostReceipt extends DirectRunCost {
  directMicroUsd: number;
  serviceFeeMicroUsd: number;
  billableMicroUsd: number;
  serviceFeeBps: typeof SERVICE_FEE_BPS;
}

function assertMicroUsd(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

/** Integer-only cost-plus arithmetic. The service fee rounds to the nearest micro-USD. */
export function calculateRunCost(input: DirectRunCost): RunCostReceipt {
  assertMicroUsd(input.providerMicroUsd, 'providerMicroUsd');
  assertMicroUsd(input.sandboxMicroUsd, 'sandboxMicroUsd');
  assertMicroUsd(input.storageMicroUsd, 'storageMicroUsd');

  const directMicroUsd = input.providerMicroUsd + input.sandboxMicroUsd + input.storageMicroUsd;
  assertMicroUsd(directMicroUsd, 'directMicroUsd');
  const serviceFeeMicroUsd = Math.round((directMicroUsd * SERVICE_FEE_BPS) / BPS_DENOMINATOR);
  const billableMicroUsd = directMicroUsd + serviceFeeMicroUsd;
  assertMicroUsd(billableMicroUsd, 'billableMicroUsd');

  return {
    ...input,
    directMicroUsd,
    serviceFeeMicroUsd,
    billableMicroUsd,
    serviceFeeBps: SERVICE_FEE_BPS,
  };
}

export function isRunBillable(kind: BillableRunKind, outcome: RunBillingOutcome): boolean {
  if (outcome === 'cancelled' || outcome === 'infrastructure_error') return false;
  if (kind === 'review') return outcome !== 'no_usable_model_result';
  return true;
}

export interface CapReservationInput {
  capMicroUsd: number;
  consumedMicroUsd: number;
  reservedMicroUsd: number;
  estimateMicroUsd: number;
}

export interface CapReservationDecision {
  allowed: boolean;
  availableMicroUsd: number;
  warningAt80Percent: boolean;
}

export function canReserveWithinCap(input: CapReservationInput): CapReservationDecision {
  for (const [label, value] of Object.entries(input)) assertMicroUsd(value, label);
  const committed = input.consumedMicroUsd + input.reservedMicroUsd;
  const availableMicroUsd = Math.max(0, input.capMicroUsd - committed);

  return {
    allowed: input.estimateMicroUsd <= availableMicroUsd,
    availableMicroUsd,
    warningAt80Percent: committed + input.estimateMicroUsd >= Math.ceil(input.capMicroUsd * 0.8),
  };
}

export function consumeTrialCredit(trialRemainingMicroUsd: number, billableMicroUsd: number): {
  trialDebitMicroUsd: number;
  invoiceMicroUsd: number;
  trialRemainingMicroUsd: number;
} {
  assertMicroUsd(trialRemainingMicroUsd, 'trialRemainingMicroUsd');
  assertMicroUsd(billableMicroUsd, 'billableMicroUsd');
  const trialDebitMicroUsd = Math.min(trialRemainingMicroUsd, billableMicroUsd);
  return {
    trialDebitMicroUsd,
    invoiceMicroUsd: billableMicroUsd - trialDebitMicroUsd,
    trialRemainingMicroUsd: trialRemainingMicroUsd - trialDebitMicroUsd,
  };
}
