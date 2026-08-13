import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyReviewPreset, defaultConfig } from '../src/config.js';
import {
  credentialReadiness,
  installManagedWorkflow,
  managedWorkflowIsPristine,
  renderManagedWorkflow,
  uploadProviderSecrets,
} from '../src/init.js';
import type { RunOptions } from '../src/util/proc.js';

const dirs: string[] = [];

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'juror-init-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('credentialReadiness', () => {
  it('reports sources and runnable jury size without retaining secret values', () => {
    const readiness = credentialReadiness(
      {
        JUROR_OPENAI_API_KEY: 'dedicated-openai-secret',
        OPENAI_API_KEY: 'legacy-openai-secret',
        FIREWORKS_API_KEY: 'legacy-fireworks-secret',
      },
      defaultConfig(),
    );

    expect(readiness.providers).toEqual([
      {
        canonicalName: 'JUROR_ANTHROPIC_API_KEY',
        label: 'Anthropic',
        available: false,
        source: 'JUROR_ANTHROPIC_API_KEY',
      },
      {
        canonicalName: 'JUROR_OPENAI_API_KEY',
        label: 'OpenAI',
        available: true,
        source: 'JUROR_OPENAI_API_KEY',
      },
      {
        canonicalName: 'JUROR_XAI_API_KEY',
        label: 'xAI',
        available: false,
        source: 'JUROR_XAI_API_KEY',
      },
      {
        canonicalName: 'JUROR_FIREWORKS_API_KEY',
        label: 'Fireworks',
        available: true,
        source: 'FIREWORKS_API_KEY',
      },
      {
        canonicalName: 'JUROR_OPENROUTER_API_KEY',
        label: 'OpenRouter',
        available: false,
        source: 'JUROR_OPENROUTER_API_KEY',
      },
    ]);
    expect(readiness.runnableModels).toEqual(['gpt-5.6-luna', 'deepseek-v4-flash-0731']);
    expect(readiness.juryKind).toBe('multi-model');
    expect(JSON.stringify(readiness)).not.toContain('dedicated-openai-secret');
    expect(JSON.stringify(readiness)).not.toContain('legacy-fireworks-secret');
  });

  it('makes single-model degradation explicit', () => {
    const readiness = credentialReadiness(
      { JUROR_OPENAI_API_KEY: 'one-secret' },
      defaultConfig(),
    );

    expect(readiness.runnableModels).toEqual(['gpt-5.6-luna']);
    expect(readiness.juryKind).toBe('single-model');
  });

  it('recognizes two independent starter families from one OpenRouter credential', () => {
    const readiness = credentialReadiness(
      { JUROR_OPENROUTER_API_KEY: 'one-aggregator-secret' },
      applyReviewPreset(defaultConfig(), 'starter'),
    );

    expect(readiness.runnableModels).toEqual([
      'openrouter-gpt-5.6-luna',
      'openrouter-deepseek-v4-flash',
    ]);
    expect(readiness.runnableFamilies).toEqual(['openai', 'deepseek']);
    expect(readiness.juryKind).toBe('multi-model');
    expect(JSON.stringify(readiness)).not.toContain('one-aggregator-secret');
  });
});

describe('managed workflow', () => {
  const sha = 'a'.repeat(40);

  it('pins Juror immutably and carries a readable release comment', () => {
    const workflow = renderManagedWorkflow({ actionSha: sha, version: '1.3.3' });

    expect(workflow).toContain(`uses: juror-ai/juror@${sha} # v1.3.3`);
    expect(workflow).toContain(
      'uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0',
    );
    expect(workflow).not.toContain('juror-ai/juror@v1');
    expect(workflow).not.toContain('actions/checkout@v4');
    // Base-revision policy needs the whole ref graph; only history blobs may be deferred.
    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow).toContain('filter: blob:none');
    expect(workflow).toContain('JUROR_OPENROUTER_API_KEY: ${{ secrets.JUROR_OPENROUTER_API_KEY }}');
    expect(workflow).toContain('# juror:init:managed sha256:');
    expect(managedWorkflowIsPristine(workflow)).toBe(true);
  });

  it('creates once, stays idempotent, and refuses to overwrite user edits', async () => {
    const repo = tempRepo();
    const workflow = renderManagedWorkflow({ actionSha: sha, version: '1.3.3' });

    await expect(installManagedWorkflow(repo, workflow, false)).resolves.toEqual({
      path: join(repo, '.github/workflows/juror.yml'),
      outcome: 'created',
    });
    await expect(installManagedWorkflow(repo, workflow, false)).resolves.toEqual({
      path: join(repo, '.github/workflows/juror.yml'),
      outcome: 'unchanged',
    });

    const path = join(repo, '.github/workflows/juror.yml');
    writeFileSync(path, `${readFileSync(path, 'utf8')}# deliberate edit\n`, 'utf8');
    expect(managedWorkflowIsPristine(readFileSync(path, 'utf8'))).toBe(false);

    await expect(installManagedWorkflow(repo, workflow, false)).resolves.toEqual({
      path,
      outcome: 'preserved',
    });
    expect(readFileSync(path, 'utf8')).toContain('# deliberate edit');
  });

  it('plans without touching the filesystem in dry-run mode', async () => {
    const repo = tempRepo();
    const workflow = renderManagedWorkflow({ actionSha: sha, version: '1.3.3' });

    await expect(installManagedWorkflow(repo, workflow, true)).resolves.toMatchObject({
      outcome: 'planned-create',
    });
    expect(() => readFileSync(join(repo, '.github/workflows/juror.yml'), 'utf8')).toThrow();
  });
});

describe('uploadProviderSecrets', () => {
  it('passes values only over stdin and uploads to the dedicated canonical names', async () => {
    const calls: { argv: string[]; opts: RunOptions }[] = [];
    const runner = vi.fn(async (argv: string[], opts: RunOptions = {}) => {
      calls.push({ argv, opts });
      return { stdout: '', stderr: '', exitCode: 0, signal: null, durationMs: 1, timedOut: false };
    });

    const uploaded = await uploadProviderSecrets(
      {
        OPENAI_API_KEY: 'legacy-value',
        JUROR_FIREWORKS_API_KEY: 'dedicated-value',
      },
      ['JUROR_OPENAI_API_KEY', 'JUROR_FIREWORKS_API_KEY'],
      'owner/repo',
      runner,
    );

    expect(uploaded).toEqual(['JUROR_OPENAI_API_KEY', 'JUROR_FIREWORKS_API_KEY']);
    expect(calls).toEqual([
      {
        argv: ['gh', 'secret', 'set', 'JUROR_OPENAI_API_KEY', '--repo', 'owner/repo'],
        opts: { stdin: 'legacy-value', timeoutMs: 120_000 },
      },
      {
        argv: ['gh', 'secret', 'set', 'JUROR_FIREWORKS_API_KEY', '--repo', 'owner/repo'],
        opts: { stdin: 'dedicated-value', timeoutMs: 120_000 },
      },
    ]);
    expect(calls.flatMap((call) => call.argv).join(' ')).not.toContain('legacy-value');
    expect(calls.flatMap((call) => call.argv).join(' ')).not.toContain('dedicated-value');
  });

  it('fails without echoing a rejected secret', async () => {
    const runner = vi.fn(async () => ({
      stdout: '',
      stderr: 'permission denied',
      exitCode: 1,
      signal: null,
      durationMs: 1,
      timedOut: false,
    }));

    await expect(
      uploadProviderSecrets(
        { JUROR_OPENAI_API_KEY: 'never-print-this' },
        ['JUROR_OPENAI_API_KEY'],
        'owner/repo',
        runner,
      ),
    ).rejects.toThrow('JUROR_OPENAI_API_KEY');
    await expect(
      uploadProviderSecrets(
        { JUROR_OPENAI_API_KEY: 'never-print-this' },
        ['JUROR_OPENAI_API_KEY'],
        'owner/repo',
        runner,
      ),
    ).rejects.not.toThrow('never-print-this');
  });

  it('rejects names outside the fixed provider allowlist', async () => {
    await expect(
      uploadProviderSecrets(
        { GITHUB_TOKEN: 'control-plane-token' },
        ['GITHUB_TOKEN'],
        'owner/repo',
        vi.fn(),
      ),
    ).rejects.toThrow('Unsupported Juror provider secret');
  });

  it('uploads an OpenRouter key through stdin under the dedicated name', async () => {
    const calls: { argv: string[]; opts: RunOptions }[] = [];
    const runner = vi.fn(async (argv: string[], opts: RunOptions = {}) => {
      calls.push({ argv, opts });
      return { stdout: '', stderr: '', exitCode: 0, signal: null, durationMs: 1, timedOut: false };
    });

    await expect(
      uploadProviderSecrets(
        { OPENROUTER_API_KEY: 'aggregator-value' },
        ['JUROR_OPENROUTER_API_KEY'],
        'owner/repo',
        runner,
      ),
    ).resolves.toEqual(['JUROR_OPENROUTER_API_KEY']);
    expect(calls).toEqual([{
      argv: ['gh', 'secret', 'set', 'JUROR_OPENROUTER_API_KEY', '--repo', 'owner/repo'],
      opts: { stdin: 'aggregator-value', timeoutMs: 120_000 },
    }]);
    expect(JSON.stringify(calls.map((call) => call.argv))).not.toContain('aggregator-value');
  });
});

describe('juror init CLI', () => {
  it('creates the managed workflow and explains single-model readiness', () => {
    const repo = tempRepo();
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:owner/example.git'], { cwd: repo });
    writeFileSync(join(repo, '.env'), 'JUROR_OPENAI_API_KEY=test-only-value\n', 'utf8');

    const output = execFileSync(
      join(process.cwd(), 'node_modules', '.bin', 'vite-node'),
      [
        join(process.cwd(), 'src/cli.ts'),
        'init',
        '--repo-dir',
        repo,
        '--action-sha',
        'b'.repeat(40),
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          NO_COLOR: '1',
        },
      },
    );

    expect(output).toContain('Repository: owner/example');
    expect(output).toContain('single-model');
    expect(output).toContain('Workflow: .github/workflows/juror.yml created');
    expect(output).not.toContain('test-only-value');
    const workflow = readFileSync(join(repo, '.github/workflows/juror.yml'), 'utf8');
    expect(workflow).toContain(`juror-ai/juror@${'b'.repeat(40)} # v1.3.3`);
  });

  it('does not create a workflow when requested secret setup cannot start', () => {
    const repo = tempRepo();
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:owner/example.git'], { cwd: repo });

    const result = spawnSync(
      join(process.cwd(), 'node_modules', '.bin', 'vite-node'),
      [
        join(process.cwd(), 'src/cli.ts'),
        'init',
        '--repo-dir',
        repo,
        '--action-sha',
        'b'.repeat(40),
        '--set-secrets',
        '--yes',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: '1' },
      },
    );

    expect(result.status).not.toBe(0);
    expect(() => readFileSync(join(repo, '.github/workflows/juror.yml'), 'utf8')).toThrow();
  });

  it('persists an explicit starter preset and reports a one-key multi-model jury', () => {
    const repo = tempRepo();
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:owner/example.git'], { cwd: repo });
    writeFileSync(join(repo, '.env'), 'JUROR_OPENROUTER_API_KEY=test-only-value\n', 'utf8');

    const output = execFileSync(
      join(process.cwd(), 'node_modules', '.bin', 'vite-node'),
      [
        join(process.cwd(), 'src/cli.ts'),
        'init',
        '--repo-dir',
        repo,
        '--preset',
        'starter',
        '--action-sha',
        'b'.repeat(40),
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: '1' },
      },
    );

    expect(output).toContain('Preset: starter (CLI override)');
    expect(output).toContain('2 runnable models across 2 families');
    expect(output).not.toContain('test-only-value');
    const workflow = readFileSync(join(repo, '.github/workflows/juror.yml'), 'utf8');
    expect(workflow).toContain('preset: starter');
  });
});
