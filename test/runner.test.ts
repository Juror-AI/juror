import { describe, expect, it } from 'vitest';

import { harnessScratch, runHarness, shouldRetryEmptyRun } from '../src/harness/runner.js';
import type { Harness, HarnessResult, RunContext } from '../src/types.js';

describe('harnessScratch', () => {
  it('separates model ids that normalize to the same filesystem slug', () => {
    expect(harnessScratch('/tmp/juror', 'foo/bar')).not.toBe(
      harnessScratch('/tmp/juror', 'foo-bar'),
    );
  });

  it('separates duplicate configured ids by their fan-out ordinal', () => {
    expect(harnessScratch('/tmp/juror', 'same', 0)).not.toBe(
      harnessScratch('/tmp/juror', 'same', 1),
    );
  });
});

describe('shouldRetryEmptyRun', () => {
  const empty: HarnessResult = {
    report: null,
    usage: null,
    reportedCostUsd: null,
    turns: 0,
    truncated: false,
    rawText: '',
    diagnostics: ['opencode emitted no JSON events on stdout'],
  };

  it('retries only a pre-turn, unbilled failure', () => {
    expect(shouldRetryEmptyRun(empty)).toBe(true);
    expect(shouldRetryEmptyRun({ ...empty, turns: 1 })).toBe(false);
    expect(
      shouldRetryEmptyRun({
        ...empty,
        usage: { uncachedIn: 1, cacheRead: 0, cacheWrite: 0, out: 0 },
      }),
    ).toBe(false);
    expect(shouldRetryEmptyRun({ ...empty, reportedCostUsd: 0.001 })).toBe(false);
    expect(shouldRetryEmptyRun({ ...empty, rawText: 'provider returned malformed output' })).toBe(false);
  });

  it('does not retry after cancellation', () => {
    const controller = new AbortController();
    controller.abort();
    expect(shouldRetryEmptyRun(empty, controller.signal)).toBe(false);
  });
});

describe('runHarness lifecycle', () => {
  it('runs adapter cleanup even when startup fails', async () => {
    let cleaned = false;
    const harness: Harness = {
      id: 'opencode',
      label: 'test harness',
      locate: async () => {
        throw new Error('startup failed');
      },
      command: () => {
        throw new Error('unreachable');
      },
      parse: () => {
        throw new Error('unreachable');
      },
      cleanup: () => {
        cleaned = true;
      },
    };
    const ctx: RunContext = {
      repoDir: '/tmp/repo',
      scratchDir: '/tmp/juror-test-scratch',
      findingsPath: '/tmp/juror-test-scratch/findings.json',
      promptPath: '/tmp/juror-test-scratch/prompt.md',
      prompt: 'review',
      model: 'test-model',
      args: {},
      env: {},
      timeoutMs: 1_000,
      budgetUsd: null,
      maxTurns: 0,
    };

    const result = await runHarness(harness, ctx);

    expect(result.report).toBeNull();
    expect(result.diagnostics.join(' ')).toContain('startup failed');
    expect(cleaned).toBe(true);
  });
});
