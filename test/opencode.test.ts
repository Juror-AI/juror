import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { opencodeHarness } from '../src/harness/opencode.js';
import type { HarnessCommand, HarnessIO, RunContext } from '../src/types.js';

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function context(repoDir: string): RunContext {
  const scratchDir = mkdtempSync(join(tmpdir(), 'juror-opencode-scratch-'));
  cleanup.push(scratchDir);
  return {
    repoDir,
    scratchDir,
    findingsPath: join(scratchDir, 'findings.json'),
    promptPath: join(scratchDir, 'prompt.md'),
    prompt: 'review this',
    model: 'fireworks-ai/accounts/fireworks/models/deepseek-v4-flash-0731',
    args: { variant: 'high' },
    env: { FIREWORKS_API_KEY: 'test-only' },
    timeoutMs: 60_000,
    budgetUsd: null,
    maxTurns: 40,
  };
}

function opencodeHome(command: HarnessCommand): string | null {
  const dataHome = command.env['XDG_DATA_HOME'];
  return dataHome ? dirname(dataHome) : null;
}

describe('opencode command path confinement', () => {
  it('resolves symlinked repo paths even before findings.json exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'juror-opencode-paths-'));
    cleanup.push(root);

    const physical = join(root, 'physical');
    const alias = join(root, 'alias');
    mkdirSync(join(physical, 'repo'), { recursive: true });
    symlinkSync(physical, alias, 'dir');

    const ctx = context(join(alias, 'repo'));
    const command = opencodeHarness.command(ctx);
    const home = opencodeHome(command);
    if (home) cleanup.push(home);

    const dirFlag = command.argv.indexOf('--dir');
    expect(dirFlag).toBeGreaterThan(-1);
    expect(command.argv[dirFlag + 1]).toBe(realpathSync(ctx.repoDir));
    expect(command.cwd).toBe(realpathSync(ctx.repoDir));
    expect(command.argv).toContain('--pure');
    expect(command.argv[command.argv.indexOf('--file') + 1]).toBe(ctx.promptPath);
    expect(command.argv).not.toContain(ctx.prompt);
    const messageIndex = command.argv.findIndex((arg) => arg.startsWith('Read the attached review prompt'));
    expect(messageIndex).toBeGreaterThan(-1);
    // `--file` accepts an array and greedily consumes later positionals, so the small
    // message must precede it or opencode mistakes the message for another file path.
    expect(messageIndex).toBeLessThan(command.argv.indexOf('--file'));
    expect(command.env['HOME']).toBe(home);
    expect(command.env['OPENCODE_CONFIG_DIR']).toBe(join(home, 'config'));
    expect(command.env['OPENCODE_DISABLE_PROJECT_CONFIG']).toBe('true');
    expect(command.env['OPENCODE_DISABLE_EXTERNAL_SKILLS']).toBe('true');
    expect(command.env['OPENCODE_DISABLE_CLAUDE_CODE_PROMPT']).toBe('true');
    expect(command.env['OPENCODE_DISABLE_CLAUDE_CODE_SKILLS']).toBe('true');
    expect(command.env['OPENCODE_DISABLE_DEFAULT_PLUGINS']).toBe('true');
    expect(existsSync(join(home, 'config'))).toBe(true);
    expect(existsSync(join(home, 'state'))).toBe(true);
    expect(statSync(home as string).mode & 0o077).toBe(0);

    opencodeHarness.cleanup?.(ctx);
    expect(existsSync(home as string)).toBe(false);
  });

  it('accepts external report paths because the model has no edit capability', () => {
    const root = mkdtempSync(join(tmpdir(), 'juror-opencode-boundary-'));
    cleanup.push(root);
    const repoDir = join(root, 'repo');
    mkdirSync(repoDir);

    const ctx = context(repoDir);
    ctx.findingsPath = join(root, 'repo-elsewhere', 'findings.json');

    const command = opencodeHarness.command(ctx);
    const home = opencodeHome(command);
    if (home) cleanup.push(home);
    expect(command.cwd).toBe(realpathSync(repoDir));
    const configPath = command.env['OPENCODE_CONFIG'];
    expect(configPath).toBeTruthy();
    const config = JSON.parse(readFileSync(configPath as string, 'utf8')) as {
      permission: { edit: string; external_directory: Record<string, string> };
    };
    expect(config.permission.edit).toBe('deny');
    expect(config.permission.external_directory['*']).toBe('deny');
    expect(config.permission.external_directory[`${realpathSync(repoDir)}/**`]).toBe('allow');
    expect(config.permission.external_directory[`${realpathSync(ctx.scratchDir)}/**`]).toBe(
      'allow',
    );
  });
});

describe('opencode custom task parsing', () => {
  it('leaves verifier JSON to the verifier without model-report warnings', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'juror-opencode-verifier-'));
    cleanup.push(repoDir);
    const ctx = context(repoDir);
    ctx.findingsPath = join(ctx.scratchDir, 'verdict.json');
    mkdirSync(ctx.scratchDir, { recursive: true });
    writeFileSync(ctx.findingsPath, '{"refuted":true,"reason":"guarded"}\n', 'utf8');

    const event = {
      type: 'step_finish',
      part: {
        tokens: { input: 10, output: 2, cache: { read: 5, write: 0 } },
        cost: 0.0001,
      },
    };
    const io: HarnessIO = {
      stdout: `${JSON.stringify(event)}\n`,
      stderr: '',
      exitCode: 0,
      signal: null,
      durationMs: 100,
      timedOut: false,
    };

    const result = opencodeHarness.parse(io, ctx);
    expect(result.report).toBeNull();
    expect(result.diagnostics).toEqual([]);
    expect(result.usage).toEqual({ uncachedIn: 10, cacheRead: 5, cacheWrite: 0, out: 2 });
    expect(result.reportedCostUsd).toBe(0.0001);
  });

  it('surfaces provider stderr and marks a nonzero result partial', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'juror-opencode-provider-error-'));
    cleanup.push(repoDir);
    const ctx = context(repoDir);
    const io: HarnessIO = {
      stdout: '',
      stderr: 'provider error: account suspended\n',
      exitCode: 1,
      signal: null,
      durationMs: 100,
      timedOut: false,
    };

    const result = opencodeHarness.parse(io, ctx);
    expect(result.diagnostics).toContain('provider error: account suspended');
    expect(result.truncated).toBe(true);
  });
});
