import { describe, expect, it } from 'vitest';
import {
  calculateRunCost,
  canReserveWithinCap,
  consumeTrialCredit,
  isRunBillable,
} from '../src/cloud/billing.js';

describe('hosted billing', () => {
  it('adds the transparent 25% service fee in integer micro-USD', () => {
    expect(calculateRunCost({ providerMicroUsd: 1_000_001, sandboxMicroUsd: 200_000, storageMicroUsd: 1_000 })).toEqual({
      providerMicroUsd: 1_000_001,
      sandboxMicroUsd: 200_000,
      storageMicroUsd: 1_000,
      directMicroUsd: 1_201_001,
      serviceFeeMicroUsd: 300_250,
      billableMicroUsd: 1_501_251,
      serviceFeeBps: 2_500,
    });
  });

  it('does not bill cancellations, infrastructure failures, or empty reviews', () => {
    expect(isRunBillable('review', 'completed')).toBe(true);
    expect(isRunBillable('review', 'no_usable_model_result')).toBe(false);
    expect(isRunBillable('qa', 'blocked')).toBe(true);
    expect(isRunBillable('qa', 'infrastructure_error')).toBe(false);
    expect(isRunBillable('qa', 'cancelled')).toBe(false);
  });

  it('reserves before starting and warns at 80 percent', () => {
    expect(canReserveWithinCap({ capMicroUsd: 100, consumedMicroUsd: 65, reservedMicroUsd: 5, estimateMicroUsd: 10 })).toEqual({
      allowed: true,
      availableMicroUsd: 30,
      warningAt80Percent: true,
    });
    expect(canReserveWithinCap({ capMicroUsd: 100, consumedMicroUsd: 80, reservedMicroUsd: 10, estimateMicroUsd: 11 }).allowed).toBe(false);
  });

  it('depletes the trial before producing invoice usage', () => {
    expect(consumeTrialCredit(2_000_000, 2_500_000)).toEqual({
      trialDebitMicroUsd: 2_000_000,
      invoiceMicroUsd: 500_000,
      trialRemainingMicroUsd: 0,
    });
  });
});
