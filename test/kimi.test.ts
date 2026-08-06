import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { kimiHarness } from '../src/harness/kimi.js';
import type { HarnessIO, RunContext } from '../src/types.js';

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

const REPORT = {
  merge_confidence: 4,
  confidence_reason: 'One concrete defect.',
  summary: 'Reviews the changed path.',
  highlights: [],
  file_overviews: [],
  sequence_diagram: null,
  async_contracts: [],
  findings: [
    {
      path: 'src/a.ts',
      line: 12,
      end_line: null,
      severity: 'P1',
      title: 'Guard is bypassed',
      body: 'The new branch skips validation.',
      category: 'correctness',
      confidence: 0.9,
      convention: null,
    },
  ],
};

function context(maxTurns = 0): RunContext {
  const repoDir = mkdtempSync(join(tmpdir(), 'juror-kimi-repo-'));
  cleanup.push(repoDir);
  const scratchDir = join(repoDir, '.juror-run', 'kimi-k3');
  mkdirSync(scratchDir, { recursive: true });
  return {
    repoDir,
    scratchDir,
    findingsPath: join(scratchDir, 'findings.json'),
    promptPath: join(scratchDir, 'prompt.md'),
    prompt: 'review this repository',
    model: 'accounts/fireworks/models/kimi-k3',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    args: { reasoning_effort: 'max', context_window: 1_040_000 },
    env: { FIREWORKS_API_KEY: 'test-only' },
    timeoutMs: 60_000,
    budgetUsd: null,
    maxTurns,
  };
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

describe('Kimi Code command isolation', () => {
  it('uses an external private home and a read-only agent profile', () => {
    const ctx = context();
    const command = kimiHarness.command(ctx);
    const runtimeRoot = dirname(command.cwd);
    cleanup.push(runtimeRoot);

    expect(command.cwd.startsWith(ctx.repoDir)).toBe(false);
    expect(command.argv).toContain('stream-json');
    expect(command.argv.slice(command.argv.indexOf('--add-dir') + 1)).toContain(ctx.repoDir);
    expect(command.argv).not.toContain('-m');
    expect(command.env['HOME']).toBe(runtimeRoot);
    expect(command.env['KIMI_CODE_HOME']).toBe(join(runtimeRoot, 'kimi-home'));
    expect(command.env['KIMI_MODEL_NAME']).toBe('accounts/fireworks/models/kimi-k3');
    expect(command.env['KIMI_MODEL_API_KEY']).toBe('test-only');
    expect(command.env['KIMI_MODEL_PROVIDER_TYPE']).toBe('openai');
    expect(command.env['KIMI_MODEL_BASE_URL']).toBe('https://api.fireworks.ai/inference/v1');
    expect(command.env['KIMI_CODE_EXPERIMENTAL_FLAG']).toBe('1');
    expect(command.env['KIMI_MODEL_THINKING_EFFORT']).toBe('max');
    expect(command.env['KIMI_LOOP_MAX_STEPS_PER_TURN']).toBe('0');
    expect(command.env['KIMI_DISABLE_TELEMETRY']).toBe('1');

    const agentFlag = command.argv.indexOf('--agent-file');
    const agentFile = command.argv[agentFlag + 1];
    expect(agentFile).toBeTruthy();
    const profile = readFileSync(agentFile as string, 'utf8');
    expect(profile).toContain('  - Read\n');
    expect(profile).not.toContain('  - Write\n');
    expect(profile).toContain('  - Grep\n');
    expect(profile).toContain('  - Glob\n');
    expect(profile).not.toMatch(/\n\s+- (Bash|WebSearch|FetchURL|Agent|mcp__)/);
  });

  it('passes through an explicitly configured positive step cap', () => {
    const command = kimiHarness.command(context(75));
    cleanup.push(dirname(command.cwd));
    expect(command.env['KIMI_LOOP_MAX_STEPS_PER_TURN']).toBe('75');
  });
});

describe('Kimi Code stream-json parsing', () => {
  it('uses the written report, keeps the last assistant text, and cleans its private runtime', () => {
    const ctx = context();
    writeFileSync(ctx.findingsPath, `${JSON.stringify(REPORT)}\n`, 'utf8');
    const command = kimiHarness.command(ctx);
    const runtimeRoot = dirname(command.cwd);
    const wireDir = join(command.env['KIMI_CODE_HOME'] as string, 'sessions', 'workspace', 'session', 'agents', 'main');
    mkdirSync(wireDir, { recursive: true });
    writeFileSync(
      join(wireDir, 'wire.jsonl'),
      [
        { type: 'metadata', protocol_version: '1.5', created_at: 1 },
        {
          type: 'usage.record',
          model: 'accounts/fireworks/models/kimi-k3',
          usage: { inputOther: 120, inputCacheRead: 80, inputCacheCreation: 4, output: 20 },
          usageScope: 'turn',
        },
        {
          type: 'usage.record',
          model: 'accounts/fireworks/models/kimi-k3',
          usage: { inputOther: 30, inputCacheRead: 10, inputCacheCreation: 0, output: 5 },
          usageScope: 'turn',
        },
      ].map((record) => JSON.stringify(record)).join('\n') + '\n',
      'utf8',
    );

    const stdout = [
      { role: 'meta', type: 'system.version', version: '0.34.0' },
      { role: 'assistant', tool_calls: [{ type: 'function', function: { name: 'Read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: '1', content: 'source' },
      { role: 'assistant', content: 'I wrote the requested report.' },
    ].map((event) => JSON.stringify(event)).join('\n');

    const result = kimiHarness.parse(io(stdout), ctx);
    expect(result.report).toEqual(REPORT);
    expect(result.rawText).toBe('I wrote the requested report.');
    expect(result.turns).toBe(2);
    expect(result.usage).toEqual({ uncachedIn: 150, cacheRead: 90, cacheWrite: 4, out: 25 });
    expect(result.reportedCostUsd).toBeNull();
    expect(existsSync(runtimeRoot)).toBe(false);
  });

  it('recovers a report from the final assistant message when no file was written', () => {
    const ctx = context();
    const stdout = JSON.stringify({ role: 'assistant', content: JSON.stringify(REPORT) });
    const result = kimiHarness.parse(io(stdout), ctx);

    expect(result.report).toEqual(REPORT);
    expect(result.diagnostics).toContain('findings file missing — recovered the report from an assistant message');
  });

  it('keeps an early report but marks it partial when Kimi exits non-zero', () => {
    const ctx = context();
    writeFileSync(ctx.findingsPath, `${JSON.stringify(REPORT)}\n`, 'utf8');
    kimiHarness.command(ctx);

    const result = kimiHarness.parse(
      io(JSON.stringify({ role: 'assistant', content: 'Working.' }), {
        exitCode: 1,
        stderr: 'loop.max_steps_exceeded',
      }),
      ctx,
    );

    expect(result.report).toEqual(REPORT);
    expect(result.truncated).toBe(true);
  });
});
