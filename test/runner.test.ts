import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyReviewPreset, defaultConfig } from '../src/config.js';
import { loadPricing } from '../src/cost/compute.js';
import { fanOut, harnessScratch, runHarness, shouldRetryEmptyRun } from '../src/harness/runner.js';
import type { Harness, HarnessResult, RunContext } from '../src/types.js';

const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

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

describe('starter fan-out', () => {
  it('runs two isolated model families with one key and keeps charged cost per model', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'juror-starter-repo-'));
    const scratchRoot = mkdtempSync(join(tmpdir(), 'juror-starter-scratch-'));
    dirs.push(repoDir, scratchRoot);
    const secret = 'one-openrouter-key';
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      return new Response(JSON.stringify({
        model: body.model,
        choices: [{ message: { role: 'assistant', content: JSON.stringify({
          merge_confidence: 5,
          confidence_reason: 'No defect found.',
          summary: 'Reviewed.',
          highlights: [],
          file_overviews: [],
          async_contracts: [],
          sequence_diagram: null,
          findings: [],
        }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.001 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const runs = await fanOut({
      config: applyReviewPreset(defaultConfig(), 'starter'),
      diff: {
        patch: '',
        files: [],
        baseSha: 'b'.repeat(40),
        headSha: 'a'.repeat(40),
        sinceSha: null,
        totalAdditions: 0,
        totalDeletions: 0,
        ignoredPaths: [],
        truncated: false,
      },
      repoDir,
      scratchRoot,
      promptTemplate: 'Review the repository and return the report.',
      promptVars: {},
      pricing: loadPricing(),
      secrets: { JUROR_OPENROUTER_API_KEY: secret },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(runs.map((run) => run.ok)).toEqual([true, true]);
    expect(runs.map((run) => run.result?.resolvedModel)).toEqual([
      'openai/gpt-5.6-luna',
      'deepseek/deepseek-v4-flash-0731',
    ]);
    expect(runs.map((run) => run.cost)).toEqual([
      { usd: 0.001, source: 'reported', longContext: false },
      { usd: 0.001, source: 'reported', longContext: false },
    ]);
    expect(readdirSync(scratchRoot)).toHaveLength(2);
    for (const call of fetchMock.mock.calls) {
      const headers = call[1]?.headers as Record<string, string>;
      expect(headers.authorization).toBe(`Bearer ${secret}`);
      expect(String(call[1]?.body)).not.toContain(secret);
    }
    expect(JSON.stringify(runs)).not.toContain(secret);
  });
});
