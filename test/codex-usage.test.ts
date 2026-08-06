/**
 * The 10x-overbilling regression guard.
 *
 * codex's `input_tokens` is a superset that already contains `cached_input_tokens`.
 * The payload below is verbatim from `docs/harness-notes.md` (codex-cli 0.146.1);
 * if `uncachedIn` ever stops being `input - cached`, a cache-heavy review bills ~10x.
 */

import { describe, expect, it } from 'vitest';

import { codexHarness } from '../src/harness/codex.js';
import type { HarnessIO, RunContext } from '../src/types.js';

const TURN_COMPLETED = {
  type: 'turn.completed',
  usage: {
    input_tokens: 52020,
    cached_input_tokens: 39168,
    cache_write_input_tokens: 0,
    output_tokens: 156,
    reasoning_output_tokens: 27,
  },
};

function jsonl(events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

function ctx(): RunContext {
  return {
    repoDir: '/tmp/juror-test-repo',
    scratchDir: '/tmp/juror-test-scratch',
    // Deliberately absent: parse() must fall back to the final message, not throw.
    findingsPath: '/tmp/juror-test-scratch/does-not-exist-findings.json',
    promptPath: '/tmp/juror-test-scratch/prompt.md',
    prompt: 'review this',
    model: 'gpt-5.6-sol',
    args: {},
    env: {},
    timeoutMs: 60_000,
    budgetUsd: null,
    maxTurns: 40,
  };
}

function io(stdout: string, over: Partial<HarnessIO> = {}): HarnessIO {
  return {
    stdout,
    stderr: '',
    exitCode: 0,
    signal: null,
    durationMs: 1234,
    timedOut: false,
    ...over,
  };
}

describe('codex parse() — canonical usage', () => {
  it('subtracts cached tokens from the reported input total', () => {
    const r = codexHarness.parse(io(jsonl([TURN_COMPLETED])), ctx());

    expect(r.usage).not.toBeNull();
    expect(r.usage?.uncachedIn).toBe(12852); // 52020 - 39168
    expect(r.usage?.cacheRead).toBe(39168);
    expect(r.usage?.cacheWrite).toBe(0);
    // reasoning_output_tokens (27) is already inside output_tokens — never added.
    expect(r.usage?.out).toBe(156);
  });

  it('reports no cost of its own, and counts completed turns', () => {
    const r = codexHarness.parse(io(jsonl([{ type: 'thread.started' }, TURN_COMPLETED])), ctx());

    expect(r.reportedCostUsd).toBeNull();
    expect(r.turns).toBe(1);
    expect(r.truncated).toBe(false);
  });

  it('clamps to zero if a provider ever reports more cache than input', () => {
    const broken = { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 40, output_tokens: 3 } };
    const r = codexHarness.parse(io(jsonl([broken])), ctx());

    expect(r.usage?.uncachedIn).toBe(0);
    expect(r.usage?.cacheRead).toBe(40);
    expect(r.usage?.cacheWrite).toBe(0);
  });

  it('keeps the last agent_message and treats error items as non-fatal', () => {
    const r = codexHarness.parse(
      io(
        jsonl([
          { type: 'item.completed', item: { type: 'agent_message', text: 'first' } },
          { type: 'item.completed', item: { type: 'error', message: 'skills context budget exceeded' } },
          { type: 'item.completed', item: { type: 'agent_message', text: 'final answer' } },
          'not json at all',
          TURN_COMPLETED,
        ]),
      ),
      ctx(),
    );

    expect(r.rawText).toBe('final answer');
    expect(r.truncated).toBe(false);
    expect(r.diagnostics.some((d) => d.includes('skills context budget exceeded'))).toBe(true);
  });

  it('marks a run with no turn.completed as truncated and usage-less', () => {
    const r = codexHarness.parse(
      io(jsonl([{ type: 'item.completed', item: { type: 'agent_message', text: 'half a thought' } }])),
      ctx(),
    );

    expect(r.usage).toBeNull();
    expect(r.turns).toBe(0);
    expect(r.truncated).toBe(true);
  });
});
