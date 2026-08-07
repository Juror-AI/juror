import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { grokHarness } from '../src/harness/grok.js';
import type { HarnessIO, RunContext } from '../src/types.js';

const contexts: RunContext[] = [];
const roots: string[] = [];

function context(args: Record<string, unknown>, maxTurns = 0): RunContext {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'juror-grok-test-')));
  const repoDir = join(root, 'repo');
  const scratchDir = join(root, 'scratch');
  mkdirSync(repoDir);
  mkdirSync(scratchDir);
  const ctx: RunContext = {
    repoDir,
    scratchDir,
    findingsPath: join(scratchDir, 'findings.json'),
    promptPath: join(scratchDir, 'prompt.md'),
    prompt: 'review this',
    model: 'grok-4.5',
    args,
    env: { XAI_API_KEY: 'test-only' },
    timeoutMs: 60_000,
    budgetUsd: null,
    maxTurns,
  };
  contexts.push(ctx);
  roots.push(root);
  return ctx;
}

function io(stdout: string, over: Partial<HarnessIO> = {}): HarnessIO {
  return {
    stdout,
    stderr: '',
    exitCode: 0,
    signal: null,
    durationMs: 100,
    timedOut: false,
    ...over,
  };
}

afterEach(() => {
  for (const ctx of contexts.splice(0)) void grokHarness.cleanup?.(ctx);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Grok Build command', () => {
  it('starts outside the PR with a private home and kernel-limited read roots', () => {
    const ctx = context({});
    const command = grokHarness.command(ctx);
    const { argv } = command;
    expect(argv[argv.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    expect(argv[argv.indexOf('--prompt-file') + 1]).toBe(ctx.promptPath);
    expect(argv[argv.indexOf('--sandbox') + 1]).toBe('juror-review');
    expect(argv).toContain('--no-subagents');
    expect(argv).toContain('--no-memory');
    expect(argv[argv.indexOf('--deny') + 1]).toBe('MCPTool(*)');
    expect(argv).not.toContain(ctx.prompt);
    expect(command.cwd).not.toBe(ctx.repoDir);
    expect(command.cwd.startsWith(ctx.repoDir)).toBe(false);
    expect(command.env.HOME).not.toBe(process.env.HOME);
    expect(command.env.GROK_HOME?.startsWith(command.env.HOME ?? '')).toBe(true);

    const sandbox = readFileSync(join(command.env.GROK_HOME ?? '', 'sandbox.toml'), 'utf8');
    expect(sandbox).toContain('[profiles.juror-review]');
    expect(sandbox).toContain(ctx.repoDir);
    expect(sandbox).toContain(ctx.scratchDir);
  });

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

describe('Grok Build result status', () => {
  it('marks a nonzero no-envelope result as partial', () => {
    const result = grokHarness.parse(io('not json', { exitCode: 1 }), context({}));
    expect(result.truncated).toBe(true);
  });

  it('marks error and turn-limit envelopes as partial', () => {
    const errored = grokHarness.parse(io(JSON.stringify({ is_error: true })), context({}));
    const limited = grokHarness.parse(
      io(JSON.stringify({ stop_reason: 'max_turns', num_turns: 5 })),
      context({}, 5),
    );
    expect(errored.truncated).toBe(true);
    expect(limited.truncated).toBe(true);
  });

  it('does not mark a normal completed envelope as partial', () => {
    const result = grokHarness.parse(
      io(JSON.stringify({ stop_reason: 'end_turn', num_turns: 2 })),
      context({}),
    );
    expect(result.truncated).toBe(false);
  });
});
