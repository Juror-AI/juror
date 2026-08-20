import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import {
  loadConfigFromBase,
  loadQaConfigConsensusFromBases,
} from '../src/qa/trusted-config.js';

const cleanup: string[] = [];

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'],
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Juror Test',
      GIT_AUTHOR_EMAIL: 'juror@example.test',
      GIT_COMMITTER_NAME: 'Juror Test',
      GIT_COMMITTER_EMAIL: 'juror@example.test',
    },
  }).trim();
}

function configRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), 'juror-trusted-consensus-'));
  cleanup.push(repository);
  git(repository, 'init', '--quiet', '--initial-branch=main');
  return repository;
}

function commitConfig(repository: string, contents: string, message: string): string {
  writeFileSync(join(repository, '.juror.yml'), contents);
  git(repository, 'add', '.juror.yml');
  git(repository, 'commit', '--quiet', '--allow-empty', '-m', message);
  return git(repository, 'rev-parse', 'HEAD');
}

describe('trusted PR configuration', () => {
  it('reads an outside symlink into the repository from the trusted base revision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'juror-trusted-config-'));
    cleanup.push(root);
    const repository = join(root, 'repository');
    const external = join(root, 'operator-link.yml');
    mkdirSync(repository);
    git(repository, 'init', '--quiet');
    writeFileSync(join(repository, '.juror.yml'), 'version: 1\nqa:\n  enabled: false\n');
    git(repository, 'add', '.juror.yml');
    git(repository, 'commit', '--quiet', '-m', 'trusted base');
    const base = git(repository, 'rev-parse', 'HEAD');
    writeFileSync(join(repository, '.juror.yml'), 'version: 1\nqa:\n  enabled: true\n');
    symlinkSync(join(repository, '.juror.yml'), external);

    const loaded = await loadConfigFromBase(repository, base, external);

    expect(loaded.config.qa.enabled).toBe(false);
    expect(loaded.sourcePath).toContain(`.juror.yml@${base.slice(0, 12)}`);
  });

  it('reads a missing base config through the isolated trusted promisor only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'juror-trusted-config-partial-'));
    cleanup.push(root);
    const origin = join(root, 'origin.git');
    const seed = join(root, 'seed');
    const partial = join(root, 'partial');
    git(root, 'init', '--bare', '--quiet', origin);
    git(origin, 'config', 'uploadpack.allowFilter', 'true');
    git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    mkdirSync(seed);
    git(seed, 'init', '--quiet', '--initial-branch=main');
    writeFileSync(join(seed, '.juror.yml'), 'version: 1\nqa:\n  enabled: true\n');
    git(seed, 'add', '.juror.yml');
    git(seed, 'commit', '--quiet', '-m', 'trusted base');
    const base = git(seed, 'rev-parse', 'HEAD');
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'push', '--quiet', 'origin', 'main');
    writeFileSync(join(seed, 'later.txt'), 'later revision\n');
    git(seed, 'add', 'later.txt');
    git(seed, 'commit', '--quiet', '-m', 'later');
    git(seed, 'push', '--quiet', 'origin', 'main');
    execFileSync('git', [
      '-c',
      'protocol.file.allow=always',
      'clone',
      '--quiet',
      '--depth=1',
      '--filter=blob:none',
      '--no-checkout',
      '--branch=main',
      `file://${origin}`,
      partial,
    ]);

    const hostileMarker = join(root, 'hostile-source-config-ran');
    const hostileCommand = join(root, 'hostile-source-command');
    writeFileSync(hostileCommand, `#!/bin/sh\nprintf ran > ${JSON.stringify(hostileMarker)}\nexit 1\n`);
    chmodSync(hostileCommand, 0o755);
    git(partial, 'config', 'remote.origin.url', `ext::${hostileCommand}`);
    git(partial, 'config', 'core.sshCommand', hostileCommand);
    git(partial, 'config', 'credential.helper', `!${hostileCommand}`);
    expect(() => execFileSync('git', ['cat-file', '-e', `${base}^{commit}`], {
      cwd: partial,
      env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
      stdio: 'ignore',
    })).toThrow();

    const priorProvider = process.env['JUROR_OPENAI_API_KEY'];
    const priorBrowser = process.env['JUROR_QA_SECRETS_B64'];
    process.env['JUROR_OPENAI_API_KEY'] = 'provider-secret-must-not-reach-git';
    process.env['JUROR_QA_SECRETS_B64'] = 'browser-secret-must-not-reach-git';
    const loaded = await (async () => {
      try {
        return await loadConfigFromBase(partial, base, null, {
          url: `file://${origin}`,
          allowFile: true,
          token: 'ephemeral-test-token',
        });
      } finally {
        if (priorProvider === undefined) delete process.env['JUROR_OPENAI_API_KEY'];
        else process.env['JUROR_OPENAI_API_KEY'] = priorProvider;
        if (priorBrowser === undefined) delete process.env['JUROR_QA_SECRETS_B64'];
        else process.env['JUROR_QA_SECRETS_B64'] = priorBrowser;
      }
    })();

    expect(loaded.config.qa.enabled).toBe(true);
    expect(loaded.sourcePath).toContain(`.juror.yml@${base.slice(0, 12)}`);
    expect(existsSync(hostileMarker)).toBe(false);
    expect(() => execFileSync('git', ['cat-file', '-e', `${base}^{commit}`], {
      cwd: partial,
      env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
      stdio: 'ignore',
    })).toThrow();
  });

  it('rejects a present config whose blob cannot be hydrated instead of treating it as absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'juror-trusted-config-unreadable-'));
    cleanup.push(root);
    const origin = join(root, 'origin.git');
    const missingOrigin = join(root, 'missing.git');
    const seed = join(root, 'seed');
    const partial = join(root, 'partial');
    git(root, 'init', '--bare', '--quiet', origin);
    git(origin, 'config', 'uploadpack.allowFilter', 'true');
    mkdirSync(seed);
    git(seed, 'init', '--quiet', '--initial-branch=main');
    writeFileSync(join(seed, '.juror.yml'), 'version: 1\nqa:\n  enabled: true\n');
    git(seed, 'add', '.juror.yml');
    git(seed, 'commit', '--quiet', '-m', 'trusted base');
    const base = git(seed, 'rev-parse', 'HEAD');
    const configBlob = git(seed, 'rev-parse', `${base}:.juror.yml`);
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'push', '--quiet', 'origin', 'main');
    execFileSync('git', [
      '-c',
      'protocol.file.allow=always',
      'clone',
      '--quiet',
      '--filter=blob:none',
      '--no-local',
      '--no-checkout',
      '--branch=main',
      `file://${origin}`,
      partial,
    ]);
    expect(() => execFileSync('git', ['cat-file', '-e', configBlob], {
      cwd: partial,
      env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
      stdio: 'ignore',
    })).toThrow();

    await expect(loadQaConfigConsensusFromBases(
      partial,
      [base],
      null,
      { promisor: { url: `file://${missingOrigin}`, allowFile: true } },
    )).rejects.toThrow('cannot read trusted config .juror.yml');
  });
});

describe('trusted QA topology consensus', () => {
  it('cancels in-flight trusted config hydration instead of defaulting or waiting', async () => {
    const repository = configRepository();
    const base = commitConfig(repository, 'version: 1\nqa:\n  enabled: true\n', 'enabled');
    const wrapperDir = join(repository, 'slow-git');
    const marker = join(repository, 'config-hydration-started');
    const realGit = execFileSync('/usr/bin/env', ['which', 'git'], { encoding: 'utf8' }).trim();
    mkdirSync(wrapperDir);
    writeFileSync(
      join(wrapperDir, 'git'),
      '#!/bin/sh\n' +
        'for juror_arg in "$@"; do\n' +
        '  if [ "$juror_arg" = ls-tree ]; then\n' +
        `    printf started > ${JSON.stringify(marker)}\n` +
        '    sleep 30\n' +
        '  fi\n' +
        'done\n' +
        `exec ${JSON.stringify(realGit)} "$@"\n`,
      'utf8',
    );
    chmodSync(join(wrapperDir, 'git'), 0o755);

    const priorPath = process.env.PATH;
    process.env.PATH = `${wrapperDir}:${priorPath ?? ''}`;
    const controller = new AbortController();
    try {
      const pending = loadQaConfigConsensusFromBases(repository, [base], null, {
        signal: controller.signal,
      });
      const deadline = Date.now() + 2_000;
      while (!existsSync(marker) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const hydrationStarted = existsSync(marker);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(hydrationStarted).toBe(true);
    } finally {
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
    }
  }, 15_000);

  it('allows dormant QA fields to differ only when every candidate is disabled and not forced', async () => {
    const repository = configRepository();
    const first = commitConfig(repository, `version: 1
qa:
  enabled: false
  evidence:
    retention_days: 3
`, 'disabled three days');
    const second = commitConfig(repository, `version: 1
qa:
  enabled: false
  evidence:
    retention_days: 9
`, 'disabled nine days');

    const loaded = await loadQaConfigConsensusFromBases(
      repository,
      [first, second],
      null,
      { force: false },
    );

    expect(loaded.config.qa.enabled).toBe(false);
    expect(loaded.config.qa.evidence.retention_days).toBe(3);
    await expect(loadQaConfigConsensusFromBases(
      repository,
      [first, second],
      null,
      { force: true },
    )).rejects.toThrow('disagree on parsed qa configuration');
  });

  it('rejects mixed enablement before choosing any candidate policy', async () => {
    const repository = configRepository();
    const disabled = commitConfig(repository, 'version: 1\nqa:\n  enabled: false\n', 'disabled');
    const enabled = commitConfig(repository, 'version: 1\nqa:\n  enabled: true\n', 'enabled');

    await expect(loadQaConfigConsensusFromBases(
      repository,
      [disabled, enabled],
      null,
    )).rejects.toThrow('disagree on qa.enabled');
  });

  it('rejects an oversized intermediate policy blob before parsing attacker text', async () => {
    const repository = configRepository();
    const safe = commitConfig(repository, 'version: 1\nqa:\n  enabled: false\n', 'safe');
    const canary = 'attacker-config-scalar-must-not-be-rendered';
    const oversized = commitConfig(
      repository,
      `version: 1\nqa:\n  enabled: false\nuntrusted: ${canary}${'x'.repeat(300_000)}\n`,
      'oversized intermediate policy',
    );

    const error = await loadQaConfigConsensusFromBases(
      repository,
      [safe, oversized],
      null,
    ).then(
      () => null,
      (reason: unknown) => reason instanceof Error ? reason : new Error(String(reason)),
    );

    expect(error?.message).toContain('262144-byte limit');
    expect(error?.message).toContain(oversized.slice(0, 12));
    expect(error?.message).not.toContain(canary);
    expect(error?.message.length).toBeLessThan(500);
  });

  it('allows a forced run only when every disabled candidate has the same parsed QA policy', async () => {
    const repository = configRepository();
    const first = commitConfig(repository, `version: 1
qa:
  enabled: false
  limits:
    max_scenarios: 2
`, 'first disabled policy');
    const second = commitConfig(repository, `version: 1
qa:
  enabled: false
  limits:
    max_scenarios: 2
`, 'second disabled policy');

    await expect(loadQaConfigConsensusFromBases(
      repository,
      [first, second],
      null,
      { force: true },
    )).resolves.toMatchObject({ config: { qa: { enabled: false, limits: { max_scenarios: 2 } } } });
  });

  it('compares normalized parsed QA policy rather than raw YAML or unrelated review fields', async () => {
    const repository = configRepository();
    const implicitDefaults = commitConfig(repository, `version: 1
review:
  severity_floor: P1
qa:
  enabled: true
`, 'implicit QA defaults');
    const explicitDefault = commitConfig(repository, `version: 1
review:
  severity_floor: P3
qa:
  enabled: true
  evidence:
    retention_days: 14
`, 'explicit QA default');

    const loaded = await loadQaConfigConsensusFromBases(
      repository,
      [implicitDefaults, explicitDefault],
      null,
    );

    expect(loaded.config.qa.enabled).toBe(true);
    expect(loaded.config.qa.evidence.retention_days).toBe(14);
  });

  it('requires all enabled candidates to have deeply equal parsed QA policy', async () => {
    const repository = configRepository();
    const first = commitConfig(repository, `version: 1
qa:
  enabled: true
  target:
    readiness_path: /ready-a
`, 'first enabled policy');
    const second = commitConfig(repository, `version: 1
qa:
  enabled: true
  target:
    readiness_path: /ready-b
`, 'second enabled policy');

    await expect(loadQaConfigConsensusFromBases(
      repository,
      [first, second],
      null,
    )).rejects.toThrow('disagree on parsed qa configuration');
  });

  it('loads every candidate and rejects invalid, non-mapping, and unsafe disabled policy', async () => {
    const repository = configRepository();
    const invalid = commitConfig(repository, 'version: 1\nqa: [\n', 'invalid YAML');
    const nonMapping = commitConfig(repository, '- version: 1\n', 'non-mapping YAML');
    const unsafeQa = commitConfig(repository, 'version: 1\nqa: disabled\n', 'unsafe QA');

    const error = await loadQaConfigConsensusFromBases(
      repository,
      [invalid, nonMapping, unsafeQa],
      null,
    ).then(
      () => null,
      (reason: unknown) => reason instanceof Error ? reason : new Error(String(reason)),
    );

    expect(error).not.toBeNull();
    expect(error?.message).toContain(`candidate base ${invalid.slice(0, 12)}`);
    expect(error?.message).toContain('is not valid YAML');
    expect(error?.message).toContain(`candidate base ${nonMapping.slice(0, 12)}`);
    expect(error?.message).toContain('must be a YAML mapping at the top level');
    expect(error?.message).toContain(`candidate base ${unsafeQa.slice(0, 12)}`);
    expect(error?.message).toContain('qa: expected a mapping');
  });

  it('rejects unavailable candidates and does not let another disabled default mask them', async () => {
    const repository = configRepository();
    const disabled = commitConfig(repository, 'version: 1\nqa:\n  enabled: false\n', 'disabled');
    const unavailable = 'f'.repeat(40);

    await expect(loadQaConfigConsensusFromBases(
      repository,
      [disabled, unavailable],
      null,
    )).rejects.toThrow(`candidate base ${unavailable.slice(0, 12)} is unavailable`);
  });

  it('rejects a missing explicit repository-owned config instead of defaulting to disabled', async () => {
    const repository = configRepository();
    const base = commitConfig(repository, 'version: 1\nqa:\n  enabled: false\n', 'base');

    await expect(loadQaConfigConsensusFromBases(
      repository,
      [base],
      join(repository, 'missing-policy.yml'),
    )).rejects.toThrow('cannot load the explicit trusted config');
  });

  it('rejects an empty topology candidate set', async () => {
    const repository = configRepository();

    await expect(loadQaConfigConsensusFromBases(repository, [], null))
      .rejects.toThrow('no candidate base revisions');
  });

  it('rejects malformed candidate identities even with an operator-owned override', async () => {
    const repository = configRepository();
    const override = join(tmpdir(), `juror-operator-${Date.now()}.yml`);
    cleanup.push(override);
    writeFileSync(override, 'version: 1\nqa:\n  enabled: true\n');

    await expect(loadQaConfigConsensusFromBases(repository, ['main'], override))
      .rejects.toThrow('full GitHub commit SHAs');
  });
});
