import { describe, expect, it } from 'vitest';

import { grokHarness } from '../src/harness/grok.js';
import type { RunContext } from '../src/types.js';

function context(args: Record<string, unknown>, maxTurns = 0): RunContext {
  return {
    repoDir: '/tmp/juror-grok-repo',
    scratchDir: '/tmp/juror-grok-repo/.juror-run/grok',
    findingsPath: '/tmp/juror-grok-repo/.juror-run/grok/findings.json',
    promptPath: '/tmp/juror-grok-repo/.juror-run/grok/prompt.md',
    prompt: 'review this',
    model: 'grok-4.5',
    args,
    env: { XAI_API_KEY: 'test-only' },
    timeoutMs: 60_000,
    budgetUsd: null,
    maxTurns,
  };
}

describe('Grok Build command', () => {
  it('omits the turn flag in unlimited mode', () => {
    expect(grokHarness.command(context({})).argv).not.toContain('--max-turns');
  });

  it('passes through an explicitly configured positive turn cap', () => {
    const argv = grokHarness.command(context({}, 75)).argv;
    const index = argv.indexOf('--max-turns');
    expect(index).toBeGreaterThan(-1);
    expect(argv[index + 1]).toBe('75');
  });

  it('passes the preset reasoning effort to the CLI', () => {
    const command = grokHarness.command(context({ reasoning_effort: 'high' }));
    const index = command.argv.indexOf('--reasoning-effort');
    expect(index).toBeGreaterThan(-1);
    expect(command.argv[index + 1]).toBe('high');
  });

  it('does not pass an unsafe reasoning effort token', () => {
    const command = grokHarness.command(context({ reasoning_effort: 'high; echo nope' }));
    expect(command.argv).not.toContain('--reasoning-effort');
  });
});
