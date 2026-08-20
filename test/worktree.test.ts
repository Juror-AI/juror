import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';

import { gitStateDir } from '../src/util/workspace.js';
import { checkoutAt, parseChangedPathManifest } from '../src/util/worktree.js';

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

function commit(dir: string, message: string, body: string): string {
  writeFileSync(join(dir, 'file.txt'), body, 'utf8');
  git(dir, ['add', 'file.txt']);
  git(dir, ['commit', '-qm', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

describe('checkoutAt', () => {
  it('parses a near-limit path inventory in linear time while preserving order', () => {
    const records = Array.from({ length: 15_000 }, (_, index) =>
      `M\0f${index.toString().padStart(5, '0')}\0`);
    records.push('R100\0old name\0new name\0', 'M\0f00000\0');

    const changed = parseChangedPathManifest(records.join(''));

    expect(changed).toHaveLength(15_002);
    expect(changed.slice(0, 2)).toEqual(['f00000', 'f00001']);
    expect(changed.slice(-2)).toEqual(['old name', 'new name']);
  });

  it('returns a physical detached-worktree path and removes it on cleanup', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'juror-worktree-source-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'juror@example.com']);
    git(repo, ['config', 'user.name', 'Juror Test']);
    const first = commit(repo, 'first', 'one\n');
    commit(repo, 'second', 'two\n');

    let checkout: Awaited<ReturnType<typeof checkoutAt>> | null = null;
    try {
      checkout = await checkoutAt(repo, first);
      expect(checkout.ephemeral).toBe(true);
      expect(checkout.dir).toBe(realpathSync(checkout.dir));
      expect(git(checkout.dir, ['rev-parse', 'HEAD'])).toBe(first);
      // The checkout is linked to a controller-owned broker, never the credential-bearing
      // source repository's config and worktree administration.
      expect(await gitStateDir(checkout.dir)).not.toBe(await gitStateDir(repo));

      await checkout.seal();
      expect(existsSync(join(checkout.dir, '.git'))).toBe(false);

      const checkoutDir = checkout.dir;
      await checkout.cleanup();
      checkout = null;
      expect(existsSync(checkoutDir)).toBe(false);
      expect(git(repo, ['worktree', 'list', '--porcelain'])).not.toContain(checkoutDir);
    } finally {
      if (checkout) await checkout.cleanup();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('generates a complete bounded patch through the isolated broker before sealing', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'juror-worktree-diff-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'juror@example.com']);
    git(repo, ['config', 'user.name', 'Juror Test']);
    const base = commit(repo, 'base', 'base\n');
    const head = commit(repo, 'head', 'merged change\n');

    let checkout: Awaited<ReturnType<typeof checkoutAt>> | null = null;
    try {
      checkout = await checkoutAt(repo, head, { requiredCommits: [base] });
      const patch = await checkout.diffFrom(base, 1_000_000);
      const changedPaths = await checkout.changedPathsFrom(base, 1_000_000);
      expect(patch).toContain('-base');
      expect(patch).toContain('+merged change');
      expect(changedPaths).toEqual(['file.txt']);
      await expect(checkout.diffFrom(base, 10)).rejects.toThrow('incomplete change set');
      await expect(checkout.changedPathsFrom(base, 2)).rejects.toThrow('incomplete affected-file list');
      await checkout.seal();
      await expect(checkout.diffFrom(base, 1_000_000)).rejects.toThrow('not fully materialized');
      await expect(checkout.changedPathsFrom(base, 1_000_000)).rejects.toThrow('not fully materialized');
    } finally {
      if (checkout) await checkout.cleanup();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('records binary hashes and paths without embedding base85 payloads in the planner patch', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'juror-worktree-binary-diff-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'juror@example.com']);
    git(repo, ['config', 'user.name', 'Juror Test']);
    writeFileSync(join(repo, 'asset.bin'), Buffer.alloc(256_000, 0));
    git(repo, ['add', 'asset.bin']);
    git(repo, ['commit', '-qm', 'base binary']);
    const base = git(repo, ['rev-parse', 'HEAD']);
    writeFileSync(join(repo, 'asset.bin'), Buffer.alloc(256_000, 1));
    git(repo, ['add', 'asset.bin']);
    git(repo, ['commit', '-qm', 'head binary']);
    const head = git(repo, ['rev-parse', 'HEAD']);

    let checkout: Awaited<ReturnType<typeof checkoutAt>> | null = null;
    try {
      checkout = await checkoutAt(repo, head, { requiredCommits: [base] });
      const patch = await checkout.diffFrom(base, 10_000);
      expect(patch).toContain('Binary files a/asset.bin and b/asset.bin differ');
      expect(patch).toMatch(/index [0-9a-f]{40}\.\.[0-9a-f]{40}/);
      expect(await checkout.changedPathsFrom(base, 10_000)).toEqual(['asset.bin']);
      expect(Buffer.byteLength(patch)).toBeLessThan(10_000);
    } finally {
      if (checkout) await checkout.cleanup();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('preserves both sides of a rename with unusual path characters', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'juror-worktree-rename-diff-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'juror@example.com']);
    git(repo, ['config', 'user.name', 'Juror Test']);
    const oldPath = 'old name\nline.txt';
    const newPath = 'new name\nline.txt';
    writeFileSync(join(repo, oldPath), 'same contents\n', 'utf8');
    git(repo, ['add', oldPath]);
    git(repo, ['commit', '-qm', 'base path']);
    const base = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['mv', oldPath, newPath]);
    git(repo, ['commit', '-qm', 'rename path']);
    const head = git(repo, ['rev-parse', 'HEAD']);

    let checkout: Awaited<ReturnType<typeof checkoutAt>> | null = null;
    try {
      checkout = await checkoutAt(repo, head, { requiredCommits: [base] });
      expect(await checkout.changedPathsFrom(base, 10_000)).toEqual([oldPath, newPath]);
    } finally {
      if (checkout) await checkout.cleanup();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does not execute repository or ambient diff drivers while generating the patch', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'juror-worktree-diff-driver-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'juror@example.com']);
    git(repo, ['config', 'user.name', 'Juror Test']);
    writeFileSync(join(repo, 'file.txt'), 'base\n', 'utf8');
    writeFileSync(join(repo, '.gitattributes'), 'file.txt diff=hostile\n', 'utf8');
    git(repo, ['add', 'file.txt', '.gitattributes']);
    git(repo, ['commit', '-qm', 'base']);
    const base = git(repo, ['rev-parse', 'HEAD']);
    writeFileSync(join(repo, 'file.txt'), 'head\n', 'utf8');
    git(repo, ['add', 'file.txt']);
    git(repo, ['commit', '-qm', 'head']);
    const head = git(repo, ['rev-parse', 'HEAD']);

    const marker = join(repo, 'hostile-diff-ran');
    const driver = join(repo, 'hostile-diff');
    writeFileSync(driver, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\ncat\n`, 'utf8');
    chmodSync(driver, 0o755);
    git(repo, ['config', 'diff.hostile.command', driver]);
    git(repo, ['config', 'diff.hostile.textconv', driver]);

    const priorCount = process.env['GIT_CONFIG_COUNT'];
    const priorKey = process.env['GIT_CONFIG_KEY_0'];
    const priorValue = process.env['GIT_CONFIG_VALUE_0'];
    process.env['GIT_CONFIG_COUNT'] = '1';
    process.env['GIT_CONFIG_KEY_0'] = 'diff.hostile.command';
    process.env['GIT_CONFIG_VALUE_0'] = driver;

    let checkout: Awaited<ReturnType<typeof checkoutAt>> | null = null;
    try {
      checkout = await checkoutAt(repo, head, { requiredCommits: [base] });
      const patch = await checkout.diffFrom(base, 1_000_000);
      expect(patch).toContain('+head');
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (checkout) await checkout.cleanup();
      if (priorCount === undefined) delete process.env['GIT_CONFIG_COUNT'];
      else process.env['GIT_CONFIG_COUNT'] = priorCount;
      if (priorKey === undefined) delete process.env['GIT_CONFIG_KEY_0'];
      else process.env['GIT_CONFIG_KEY_0'] = priorKey;
      if (priorValue === undefined) delete process.env['GIT_CONFIG_VALUE_0'];
      else process.env['GIT_CONFIG_VALUE_0'] = priorValue;
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('cancels an in-flight isolated diff and still permits exact checkout cleanup', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'juror-worktree-diff-cancel-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'juror@example.com']);
    git(repo, ['config', 'user.name', 'Juror Test']);
    const base = commit(repo, 'base', 'base\n');
    const head = commit(repo, 'head', 'head\n');
    const wrapperDir = join(repo, 'bin');
    const marker = join(repo, 'diff-started');
    const realGit = execFileSync('/usr/bin/env', ['which', 'git'], { encoding: 'utf8' }).trim();
    mkdirSync(wrapperDir);
    writeFileSync(
      join(wrapperDir, 'git'),
      '#!/bin/sh\n' +
        'for juror_arg in "$@"; do\n' +
        '  if [ "$juror_arg" = diff ]; then\n' +
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
    let checkout: Awaited<ReturnType<typeof checkoutAt>> | null = null;
    try {
      checkout = await checkoutAt(repo, head, { requiredCommits: [base], signal: controller.signal });
      const checkoutRoot = dirname(checkout.dir);
      const pending = checkout.diffFrom(base, 1_000_000);
      // Wait until the wrapped Git process is actually in flight. A fixed short timer races
      // process startup under full-suite/CI contention and can abort before the marker exists.
      const markerDeadline = Date.now() + 5_000;
      while (!existsSync(marker) && Date.now() < markerDeadline) {
        await delay(20);
      }
      const diffStarted = existsSync(marker);
      controller.abort();
      await expect(pending).rejects.toThrow('Could not generate the isolated merged patch');
      expect(diffStarted).toBe(true);
      await checkout.cleanup();
      checkout = null;
      expect(existsSync(checkoutRoot)).toBe(false);
    } finally {
      if (checkout) await checkout.cleanup();
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('isolates a matching head, copies tracked edits, and excludes untracked secrets', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'juror-worktree-dirty-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'juror@example.com']);
    git(repo, ['config', 'user.name', 'Juror Test']);
    const head = commit(repo, 'base', 'committed\n');
    writeFileSync(join(repo, 'file.txt'), 'working change\n', 'utf8');
    writeFileSync(join(repo, '.env'), 'PROVIDER_KEY=do-not-copy\n', 'utf8');

    let checkout: Awaited<ReturnType<typeof checkoutAt>> | null = null;
    try {
      checkout = await checkoutAt(repo, head, { includeWorkingTree: true });
      expect(checkout.ephemeral).toBe(true);
      expect(checkout.dir).not.toBe(repo);
      expect(readFileSync(join(checkout.dir, 'file.txt'), 'utf8')).toBe('working change\n');
      expect(existsSync(join(checkout.dir, '.env'))).toBe(false);
    } finally {
      if (checkout) await checkout.cleanup();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does not prune unrelated worktree registrations that are invisible in its namespace', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'juror-worktree-namespace-'));
    const unrelated = mkdtempSync(join(tmpdir(), 'juror-worktree-unrelated-'));
    rmSync(unrelated, { recursive: true, force: true });
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'juror@example.com']);
    git(repo, ['config', 'user.name', 'Juror Test']);
    const head = commit(repo, 'base', 'committed\n');
    git(repo, ['worktree', 'add', '--detach', '--quiet', unrelated, head]);

    const pointer = readFileSync(join(unrelated, '.git'), 'utf8').trim();
    const adminDir = pointer.replace(/^gitdir:\s*/, '');
    writeFileSync(join(adminDir, 'gitdir'), '/host-only/unrelated/.git\n', 'utf8');

    let checkout: Awaited<ReturnType<typeof checkoutAt>> | null = null;
    try {
      checkout = await checkoutAt(repo, head);
      expect(existsSync(adminDir)).toBe(true);
    } finally {
      if (checkout) await checkout.cleanup();
      rmSync(unrelated, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does not execute repository checkout hooks while creating the detached worktree', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'juror-worktree-hooks-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'juror@example.com']);
    git(repo, ['config', 'user.name', 'Juror Test']);
    commit(repo, 'base', 'committed\n');
    const hookDir = join(repo, '.githooks');
    const marker = join(repo, 'post-checkout-ran');
    mkdirSync(hookDir);
    writeFileSync(
      join(hookDir, 'post-checkout'),
      `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\n`,
      'utf8',
    );
    chmodSync(join(hookDir, 'post-checkout'), 0o755);
    git(repo, ['add', '.githooks/post-checkout']);
    git(repo, ['commit', '-qm', 'add tracked checkout hook']);
    const head = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['config', 'core.hooksPath', '.githooks']);

    let checkout: Awaited<ReturnType<typeof checkoutAt>> | null = null;
    try {
      checkout = await checkoutAt(repo, head);
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (checkout) await checkout.cleanup();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does not execute source fsmonitor or clean/smudge filters while copying tracked edits', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'juror-worktree-config-exec-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'juror@example.com']);
    git(repo, ['config', 'user.name', 'Juror Test']);
    writeFileSync(join(repo, 'file.txt'), 'committed\n', 'utf8');
    writeFileSync(join(repo, '.gitattributes'), 'file.txt filter=hostile\n', 'utf8');
    git(repo, ['add', 'file.txt', '.gitattributes']);
    git(repo, ['commit', '-qm', 'add filtered file']);
    const head = git(repo, ['rev-parse', 'HEAD']);

    const command = join(repo, 'hostile-filter');
    const filterMarker = join(repo, 'filter-ran');
    const fsmonitor = join(repo, 'hostile-fsmonitor');
    const fsmonitorMarker = join(repo, 'fsmonitor-ran');
    writeFileSync(
      command,
      `#!/bin/sh\nprintf ran > ${JSON.stringify(filterMarker)}\ncat\n`,
      'utf8',
    );
    writeFileSync(
      fsmonitor,
      `#!/bin/sh\nprintf ran > ${JSON.stringify(fsmonitorMarker)}\nexit 0\n`,
      'utf8',
    );
    chmodSync(command, 0o755);
    chmodSync(fsmonitor, 0o755);
    git(repo, ['config', 'filter.hostile.clean', command]);
    git(repo, ['config', 'filter.hostile.smudge', command]);
    git(repo, ['config', 'filter.hostile.required', 'true']);
    git(repo, ['config', 'core.fsmonitor', fsmonitor]);
    writeFileSync(join(repo, 'file.txt'), 'working change\n', 'utf8');

    const priorCount = process.env['GIT_CONFIG_COUNT'];
    const priorKey = process.env['GIT_CONFIG_KEY_0'];
    const priorValue = process.env['GIT_CONFIG_VALUE_0'];
    process.env['GIT_CONFIG_COUNT'] = '1';
    process.env['GIT_CONFIG_KEY_0'] = 'filter.hostile.smudge';
    process.env['GIT_CONFIG_VALUE_0'] = command;

    let checkout: Awaited<ReturnType<typeof checkoutAt>> | null = null;
    try {
      checkout = await checkoutAt(repo, head, { includeWorkingTree: true });
      expect(readFileSync(join(checkout.dir, 'file.txt'), 'utf8')).toBe('working change\n');
      expect(existsSync(filterMarker)).toBe(false);
      expect(existsSync(fsmonitorMarker)).toBe(false);
    } finally {
      if (checkout) await checkout.cleanup();
      if (priorCount === undefined) delete process.env['GIT_CONFIG_COUNT'];
      else process.env['GIT_CONFIG_COUNT'] = priorCount;
      if (priorKey === undefined) delete process.env['GIT_CONFIG_KEY_0'];
      else process.env['GIT_CONFIG_KEY_0'] = priorKey;
      if (priorValue === undefined) delete process.env['GIT_CONFIG_VALUE_0'];
      else process.env['GIT_CONFIG_VALUE_0'] = priorValue;
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('bulk-fetches missing blobs through an isolated promisor broker', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'juror-worktree-partial-'));
    const origin = join(fixture, 'origin.git');
    const seed = join(fixture, 'seed');
    const partial = join(fixture, 'partial');
    git(fixture, ['init', '--bare', '--quiet', origin]);
    git(origin, ['config', 'uploadpack.allowFilter', 'true']);
    git(origin, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
    git(fixture, ['init', '--quiet', '--initial-branch=main', seed]);
    git(seed, ['config', 'user.email', 'juror@example.com']);
    git(seed, ['config', 'user.name', 'Juror Test']);
    const firstPath = join(seed, 'first.txt');
    writeFileSync(firstPath, 'first revision\n', 'utf8');
    git(seed, ['add', 'first.txt']);
    git(seed, ['commit', '-qm', 'first']);
    const first = git(seed, ['rev-parse', 'HEAD']);
    const firstBlob = git(seed, ['rev-parse', `${first}:first.txt`]);
    git(seed, ['remote', 'add', 'origin', origin]);
    git(seed, ['push', '--quiet', 'origin', 'main']);
    git(seed, ['push', '--quiet', 'origin', `${first}:refs/pull/37/head`]);
    rmSync(firstPath);
    writeFileSync(join(seed, 'second.txt'), 'second revision\n', 'utf8');
    git(seed, ['add', '--all']);
    git(seed, ['commit', '-qm', 'second']);
    const second = git(seed, ['rev-parse', 'HEAD']);
    git(seed, ['push', '--quiet', 'origin', 'main']);
    git(fixture, [
      '-c',
      'protocol.file.allow=always',
      'clone',
      '--quiet',
      '--depth=1',
      '--filter=blob:none',
      '--no-local',
      '--no-checkout',
      '--branch=main',
      `file://${origin}`,
      partial,
    ]);
    const hostileRemoteMarker = join(fixture, 'hostile-remote-ran');
    const hostileRemote = join(fixture, 'hostile-remote');
    writeFileSync(
      hostileRemote,
      `#!/bin/sh\nprintf ran > ${JSON.stringify(hostileRemoteMarker)}\nexit 1\n`,
      'utf8',
    );
    chmodSync(hostileRemote, 0o755);
    git(partial, ['config', 'remote.origin.url', `ext::${hostileRemote}`]);
    git(partial, ['config', 'core.sshCommand', hostileRemote]);
    git(partial, ['config', 'credential.helper', `!${hostileRemote}`]);

    const realGit = execFileSync('/usr/bin/env', ['which', 'git'], { encoding: 'utf8' }).trim();
    const wrapperDir = join(fixture, 'git-wrapper');
    const leakedCredentialMarker = join(fixture, 'git-saw-provider-credential');
    const leakedGitOverrideMarker = join(fixture, 'git-saw-ambient-override');
    const invalidPromisorConfigMarker = join(fixture, 'git-saw-invalid-promisor-config');
    const blockedRawFetchMarker = join(fixture, 'raw-fetch-blocked');
    const pullRefFetchMarker = join(fixture, 'pull-ref-fetched');
    mkdirSync(wrapperDir);
    writeFileSync(
      join(wrapperDir, 'git'),
      '#!/usr/bin/env node\n' +
        "const { spawnSync } = require('node:child_process');\n" +
        "const { existsSync, writeFileSync } = require('node:fs');\n" +
        'const args = process.argv.slice(2);\n' +
        `const leakedCredentialMarker = ${JSON.stringify(leakedCredentialMarker)};\n` +
        `const leakedGitOverrideMarker = ${JSON.stringify(leakedGitOverrideMarker)};\n` +
        `const invalidPromisorConfigMarker = ${JSON.stringify(invalidPromisorConfigMarker)};\n` +
        `const blockedRawFetchMarker = ${JSON.stringify(blockedRawFetchMarker)};\n` +
        `const pullRefFetchMarker = ${JSON.stringify(pullRefFetchMarker)};\n` +
        `const first = ${JSON.stringify(first)};\n` +
        "if (process.env.JUROR_OPENAI_API_KEY || process.env.JUROR_QA_SECRETS_B64) {\n" +
        "  writeFileSync(leakedCredentialMarker, 'leaked');\n" +
        '}\n' +
        'const forbidden = [\n' +
        "  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'GIT_TRACE',\n" +
        "  'GIT_JUROR_FUTURE_OVERRIDE', 'GIT_CONFIG_KEY_90', 'GIT_CONFIG_VALUE_90',\n" +
        '];\n' +
        'const leakedAmbientConfig =\n' +
        "  process.env.GIT_CONFIG_COUNT === '91' ||\n" +
        "  process.env.GIT_CONFIG_KEY_0 === 'core.sshCommand' ||\n" +
        "  process.env.GIT_CONFIG_VALUE_0 === 'ambient-config-value';\n" +
        'if (forbidden.some((name) => Object.hasOwn(process.env, name)) || leakedAmbientConfig) {\n' +
        "  writeFileSync(leakedGitOverrideMarker, 'leaked');\n" +
        '  process.exit(97);\n' +
        '}\n' +
        "const isFetch = args.includes('fetch');\n" +
        'if (isFetch) {\n' +
        '  const count = Number(process.env.GIT_CONFIG_COUNT);\n' +
        '  let valid = Number.isSafeInteger(count) && count > 0;\n' +
        '  const entries = [];\n' +
        '  if (valid) {\n' +
        '    for (let index = 0; index < count; index += 1) {\n' +
        '      const keyName = `GIT_CONFIG_KEY_${index}`;\n' +
        '      const valueName = `GIT_CONFIG_VALUE_${index}`;\n' +
        '      if (!Object.hasOwn(process.env, keyName) || !Object.hasOwn(process.env, valueName)) {\n' +
        '        valid = false;\n' +
        '        break;\n' +
        '      }\n' +
        '      entries.push([process.env[keyName], process.env[valueName]]);\n' +
        '    }\n' +
        '  }\n' +
        '  valid &&= !Object.hasOwn(process.env, `GIT_CONFIG_KEY_${count}`);\n' +
        '  valid &&= !Object.hasOwn(process.env, `GIT_CONFIG_VALUE_${count}`);\n' +
        "  valid &&= entries.some(([key, value]) => key === 'extensions.partialClone' && value === 'juror-promisor');\n" +
        "  valid &&= entries.some(([key, value]) => key?.startsWith('remote.juror-promisor.') && value);\n" +
        "  valid &&= entries.some(([key, value]) => key?.startsWith('http.') && key.endsWith('.extraHeader') && value);\n" +
        '  if (!valid) {\n' +
        "    writeFileSync(invalidPromisorConfigMarker, 'invalid');\n" +
        '    process.exit(98);\n' +
        '  }\n' +
        '  if (args.includes(first) && !existsSync(pullRefFetchMarker)) {\n' +
        "    writeFileSync(blockedRawFetchMarker, 'blocked');\n" +
        '    process.exit(1);\n' +
        '  }\n' +
        "  if (args.includes('refs/pull/37/head')) writeFileSync(pullRefFetchMarker, 'fetched');\n" +
        '}\n' +
        `const child = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit', env: process.env });\n` +
        'if (child.error) throw child.error;\n' +
        'process.exit(child.status ?? 1);\n',
      'utf8',
    );
    chmodSync(join(wrapperDir, 'git'), 0o755);

    let checkout: Awaited<ReturnType<typeof checkoutAt>> | null = null;
    try {
      expect(() => execFileSync('git', ['cat-file', '-e', `${first}^{commit}`], {
        cwd: partial,
        env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
        stdio: 'ignore',
      })).toThrow();
      expect(() => execFileSync('git', ['cat-file', '-e', firstBlob], {
        cwd: partial,
        env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
        stdio: 'ignore',
      })).toThrow();

      const priorPath = process.env.PATH;
      const priorProvider = process.env.JUROR_OPENAI_API_KEY;
      const priorBrowserSecrets = process.env.JUROR_QA_SECRETS_B64;
      const ambientGitOverrides = {
        GIT_DIR: join(fixture, 'ambient.git'),
        GIT_WORK_TREE: join(fixture, 'ambient-worktree'),
        GIT_CONFIG_COUNT: '91',
        GIT_CONFIG_KEY_0: 'core.sshCommand',
        GIT_CONFIG_VALUE_0: 'ambient-config-value',
        GIT_CONFIG_KEY_90: 'alias.fetch',
        GIT_CONFIG_VALUE_90: `!${hostileRemote}`,
        GIT_SSH_COMMAND: hostileRemote,
        GIT_ASKPASS: hostileRemote,
        GIT_TRACE: join(fixture, 'ambient-git-trace'),
        GIT_JUROR_FUTURE_OVERRIDE: 'ambient-arbitrary-value',
      } as const;
      const priorGitOverrides = new Map(
        Object.keys(ambientGitOverrides).map((name) => [name, process.env[name]]),
      );
      process.env.PATH = `${wrapperDir}:${priorPath ?? ''}`;
      process.env.JUROR_OPENAI_API_KEY = 'provider-secret-must-not-reach-git';
      process.env.JUROR_QA_SECRETS_B64 = 'browser-secret-must-not-reach-git';
      Object.assign(process.env, ambientGitOverrides);
      try {
        checkout = await checkoutAt(partial, first, {
          promisor: {
            url: `file://${origin}`,
            token: 'controller-owned-promisor-token',
            allowFile: true,
          },
          prNumber: 37,
          requiredCommits: [second],
        });
      } finally {
        if (priorPath === undefined) delete process.env.PATH;
        else process.env.PATH = priorPath;
        if (priorProvider === undefined) delete process.env.JUROR_OPENAI_API_KEY;
        else process.env.JUROR_OPENAI_API_KEY = priorProvider;
        if (priorBrowserSecrets === undefined) delete process.env.JUROR_QA_SECRETS_B64;
        else process.env.JUROR_QA_SECRETS_B64 = priorBrowserSecrets;
        for (const [name, value] of priorGitOverrides) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
      expect(readFileSync(join(checkout.dir, 'first.txt'), 'utf8')).toBe('first revision\n');
      expect(existsSync(join(checkout.dir, 'second.txt'))).toBe(false);
      expect(existsSync(hostileRemoteMarker)).toBe(false);
      expect(existsSync(leakedCredentialMarker)).toBe(false);
      expect(existsSync(leakedGitOverrideMarker)).toBe(false);
      expect(existsSync(invalidPromisorConfigMarker)).toBe(false);
      expect(existsSync(blockedRawFetchMarker)).toBe(true);
      expect(existsSync(pullRefFetchMarker)).toBe(true);
      expect(() => git(checkout!.dir, [
        'config',
        '--local',
        '--get-regexp',
        '^(remote\\.|extensions\\.partialclone|http\\..*\\.extraheader)',
      ])).toThrow();
      // The fetched commit and blob belong to the short-lived broker, not the operator checkout.
      expect(() => execFileSync('git', ['cat-file', '-e', `${first}^{commit}`], {
        cwd: partial,
        env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
        stdio: 'ignore',
      })).toThrow();
      expect(() => execFileSync('git', ['cat-file', '-e', firstBlob], {
        cwd: partial,
        env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
        stdio: 'ignore',
      })).toThrow();
    } finally {
      if (checkout) await checkout.cleanup();
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
