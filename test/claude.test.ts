import { describe, expect, it } from 'vitest';

import { claudeHarness } from '../src/harness/claude.js';
import type { RunContext } from '../src/types.js';

function context(maxTurns = 0): RunContext {
  return {
    repoDir: '/tmp/juror-claude-repo',
    scratchDir: '/tmp/juror-claude-repo/.juror-run/claude',
    findingsPath: '/tmp/juror-claude-repo/.juror-run/claude/findings.json',
    promptPath: '/tmp/juror-claude-repo/.juror-run/claude/prompt.md',
    prompt: 'review this',
    model: 'claude-opus-5',
    args: {},
    env: { ANTHROPIC_API_KEY: 'test-only' },
    timeoutMs: 60_000,
    budgetUsd: null,
    maxTurns,
  };
}

describe('Claude Code command', () => {
  it('omits the turn flag in unlimited mode', () => {
    expect(claudeHarness.command(context()).argv).not.toContain('--max-turns');
  });

  it('passes through an explicitly configured positive turn cap', () => {
    const argv = claudeHarness.command(context(75)).argv;
    const index = argv.indexOf('--max-turns');
    expect(index).toBeGreaterThan(-1);
    expect(argv[index + 1]).toBe('75');
  });
});
