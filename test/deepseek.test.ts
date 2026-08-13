import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { deepseekHarness } from '../src/harness/deepseek.js';
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
  async_contracts: [],
  sequence_diagram: null,
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
  const root = mkdtempSync(join(tmpdir(), 'juror-deepseek-test-'));
  cleanup.push(root);
  const repoDir = join(root, 'repo');
  const scratchDir = join(root, 'scratch');
  mkdirSync(repoDir);
  mkdirSync(scratchDir);
  return {
    repoDir,
    scratchDir,
    findingsPath: join(scratchDir, 'findings.json'),
    promptPath: join(scratchDir, 'prompt.md'),
    prompt: 'review this repository',
    model: 'accounts/fireworks/models/deepseek-v4-flash-0731',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    args: { reasoning_effort: 'low' },
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

describe('DeepSeek command isolation', () => {
  it('pins and installs CodeWhale in the GitHub Action', () => {
    const action = readFileSync(join(process.cwd(), 'action.yml'), 'utf8');
    expect(action).toContain("default: 'codewhale@0.9.7'");
    expect(action).toContain('DEEPSEEK_SPEC: ${{ inputs.deepseek-version }}');
    expect(action).toContain('install_harness codewhale "$DEEPSEEK_SPEC"');
  });

  it('uses CodeWhale with a private runtime and a read-only tool surface', () => {
    const ctx = context();
    Object.assign(ctx.env, {
      CODEWHALE_ALLOW_SHELL: 'true',
      DEEPSEEK_ALLOW_SHELL: 'true',
      CODEWHALE_APPROVAL_POLICY: 'never',
      DEEPSEEK_APPROVAL_POLICY: 'never',
      CODEWHALE_SANDBOX_MODE: 'danger-full-access',
      DEEPSEEK_SANDBOX_MODE: 'danger-full-access',
      CODEWHALE_YOLO: 'true',
      DEEPSEEK_YOLO: 'true',
    });
    const command = deepseekHarness.command(ctx);
    const configPath = command.argv[command.argv.indexOf('--config') + 1] as string;
    const runtimeRoot = dirname(command.env['HOME'] as string);
    const trustPath = join(command.env['CODEWHALE_HOME'] as string, 'workspace-trust.json');
    cleanup.push(runtimeRoot);

    expect(command.argv[0]).toBe('codewhale');
    expect(command.argv).toContain('--no-project-config');
    expect(command.argv).not.toContain('--auto');
    expect(command.argv[command.argv.indexOf('--provider') + 1]).toBe('fireworks');
    expect(command.argv[command.argv.indexOf('--model') + 1]).toBe(ctx.model);
    expect(command.argv[command.argv.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(command.argv[command.argv.indexOf('--allowed-tools') + 1]).toBe(
      'read,list_dir,grep_files,file_search',
    );
    expect(command.argv).not.toContain(ctx.prompt);
    expect(command.argv.at(-1)).toContain(ctx.promptPath);
    expect(command.argv.at(-1)).toContain(ctx.repoDir);
    expect(command.cwd).not.toBe(ctx.repoDir);
    expect(command.argv[command.argv.indexOf('-C') + 1]).toBe(command.cwd);
    expect(readFileSync(join(command.cwd, 'README.md'), 'utf8')).toContain(
      'Juror isolated review workspace',
    );
    expect(command.stdin).toBe('');
    expect(command.env['FIREWORKS_API_KEY']).toBe('test-only');
    expect(command.env['CODEWHALE_BASE_URL']).toBe(ctx.baseUrl);
    expect(command.env['CODEWHALE_TELEMETRY']).toBe('0');
    expect(command.env['CODEWHALE_NO_UPDATE_CHECK']).toBe('1');
    expect(command.env['CODEWHALE_ALLOW_SHELL']).toBe('false');
    expect(command.env['DEEPSEEK_ALLOW_SHELL']).toBe('false');
    expect(command.env['CODEWHALE_APPROVAL_POLICY']).toBe('auto');
    expect(command.env['DEEPSEEK_APPROVAL_POLICY']).toBe('auto');
    expect(command.env['CODEWHALE_SANDBOX_MODE']).toBe('read-only');
    expect(command.env['DEEPSEEK_SANDBOX_MODE']).toBe('read-only');
    expect(command.env['CODEWHALE_YOLO']).toBe('false');
    expect(command.env['DEEPSEEK_YOLO']).toBe('false');
    expect(command.env['CODEWHALE_HOME']).not.toContain(ctx.repoDir);
    expect(statSync(runtimeRoot).mode & 0o077).toBe(0);

    const trust = JSON.parse(readFileSync(trustPath, 'utf8')) as {
      workspaces: Record<string, string[]>;
    };
    expect(trust.workspaces[command.cwd]).toEqual(
      expect.arrayContaining([realpathSync(ctx.repoDir), realpathSync(ctx.scratchDir)]),
    );

    const config = readFileSync(configPath, 'utf8');
    expect(config).toContain('provider = "fireworks"');
    expect(config).toContain('telemetry = false');
    expect(config).toContain('allow_shell = false');
    expect(config).toContain('approval_policy = "auto"');
    expect(config).toContain('sandbox_mode = "read-only"');
    expect(config).toContain('scan_codewhale_only = true');
    expect(config).toContain('always_load = ["list_dir", "file_search", "grep_files"]');

    deepseekHarness.cleanup?.(ctx);
    expect(existsSync(runtimeRoot)).toBe(false);
  });

  it('passes reasoning and an explicit positive turn cap', () => {
    const ctx = context(75);
    const command = deepseekHarness.command(ctx);
    cleanup.push(dirname(command.env['HOME'] as string));
    expect(command.argv[command.argv.indexOf('--reasoning-effort') + 1]).toBe('low');
    expect(command.argv[command.argv.indexOf('--max-turns') + 1]).toBe('75');
  });

  it('omits unsafe reasoning values and the unlimited turn flag', () => {
    const ctx = context();
    ctx.args.reasoning_effort = 'high; echo nope';
    const command = deepseekHarness.command(ctx);
    cleanup.push(dirname(command.env['HOME'] as string));
    expect(command.argv).not.toContain('--reasoning-effort');
    expect(command.argv).not.toContain('--max-turns');
  });
});

describe('DeepSeek stream-json parsing', () => {
  it('recovers the report and sums provider usage across tool rounds', () => {
    const ctx = context();
    const stdout = [
      { type: 'content', content: JSON.stringify(REPORT).slice(0, 80) },
      {
        type: 'turn_usage',
        turn: 1,
        input_tokens: 120,
        output_tokens: 20,
        prompt_cache_hit_tokens: 80,
        prompt_cache_miss_tokens: 40,
        prompt_cache_write_tokens: 3,
      },
      { type: 'content', content: JSON.stringify(REPORT).slice(80) },
      {
        type: 'turn_usage',
        turn: 2,
        input_tokens: 150,
        output_tokens: 25,
        prompt_cache_hit_tokens: 90,
        prompt_cache_miss_tokens: 60,
      },
      { type: 'metadata', meta: { status: 'completed', model: ctx.model } },
      { type: 'done' },
    ].map((event) => JSON.stringify(event)).join('\n');

    const result = deepseekHarness.parse(io(stdout), ctx);
    expect(result.report).toEqual(REPORT);
    expect(result.rawText).toBe(JSON.stringify(REPORT));
    expect(result.usage).toEqual({ uncachedIn: 100, cacheRead: 170, cacheWrite: 3, out: 45 });
    expect(result.turns).toBe(2);
    expect(result.usageSource).toBe('provider');
    expect(result.resolvedModel).toBe(ctx.model);
    expect(result.reportedCostUsd).toBeNull();
    expect(result.truncated).toBe(false);
  });

  it('prefers an exact findings file when the task is a model review', () => {
    const ctx = context();
    writeFileSync(ctx.findingsPath, `${JSON.stringify(REPORT)}\n`, 'utf8');
    const result = deepseekHarness.parse(io('{"type":"content","content":"not json"}\n'), ctx);
    expect(result.report).toEqual(REPORT);
  });

  it('treats completed terminal metadata as authoritative over a recoverable error event', () => {
    const ctx = context();
    const stdout = [
      { type: 'error', error: 'transient stream warning' },
      { type: 'content', content: JSON.stringify(REPORT) },
      { type: 'metadata', meta: { status: 'completed' } },
    ].map((event) => JSON.stringify(event)).join('\n');
    const result = deepseekHarness.parse(io(stdout), ctx);
    expect(result.truncated).toBe(false);
    expect(result.diagnostics).toContain('transient stream warning');
  });

  it('marks process and terminal failures partial while retaining diagnostics', () => {
    const ctx = context();
    const stdout = [
      { type: 'error', error: 'provider unavailable' },
      { type: 'metadata', meta: { status: 'failed' } },
    ].map((event) => JSON.stringify(event)).join('\n');
    const result = deepseekHarness.parse(
      io(stdout, { exitCode: 1, stderr: 'request failed\n' }),
      ctx,
    );
    expect(result.truncated).toBe(true);
    expect(result.diagnostics).toContain('provider unavailable');
    expect(result.diagnostics).toContain('request failed');
  });
});
