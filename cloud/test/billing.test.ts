import { describe, expect, it } from 'vitest';
import { retainedStorageCostMicroUsd, sandboxCostMicroUsd } from '../worker/billing';
import type { Env } from '../worker/env';

const rates = {
  CONTAINER_CPU_MICRO_USD_PER_VCPU_SECOND: '20',
  CONTAINER_MEMORY_MICRO_USD_PER_GIB_SECOND: '2.5',
  CONTAINER_DISK_MICRO_USD_PER_GB_SECOND: '0.07',
  R2_STORAGE_MICRO_USD_PER_GB_MONTH: '15000',
} as Env;

describe('container cost receipt', () => {
  it('uses measured CPU time and provisioned memory/disk duration', () => {
    expect(sandboxCostMicroUsd(rates, 'review', 10_000, 5_000)).toBe(312);
    expect(sandboxCostMicroUsd(rates, 'qa', 10_000, 5_000)).toBe(259);
  });

  it('caps impossible CPU receipts at the instance capacity', () => {
    expect(sandboxCostMicroUsd(rates, 'review', 1_000, 100_000)).toBe(62);
  });

  it('prices decimal-GB retention for reports and 90-day QA evidence', () => {
    expect(retainedStorageCostMicroUsd(rates, 1_000_000_000, 1_000_000_000)).toBe(227_500);
  });
});
