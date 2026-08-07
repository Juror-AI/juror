import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectFromPatch, collectLocalDiff } from '../src/diff/collect.js';

// Real git, no network: the plumbing (merge-base fallback, rename detection, incremental
// marking) is the part worth exercising, and mocking git would only test the mock.
function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

function newRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'juror-collect-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'juror@example.com']);
  git(dir, ['config', 'user.name', 'Juror Test']);
  return dir;
}

function commit(dir: string, message: string, files: Record<string, string>): string {
  for (const [path, body] of Object.entries(files)) writeFileSync(join(dir, path), body);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

describe('collectLocalDiff', () => {
  it('fills every DiffContext field, drops ignored paths, and marks incremental files', async () => {
    const dir = newRepo();
    const base = commit(dir, 'base', { 'a.ts': 'one\ntwo\nthree\n', 'b.lock': 'lock\n', 'c.ts': 'c1\n' });
    const since = commit(dir, 'first', { 'a.ts': 'one\nTWO\nthree\n', 'b.lock': 'lock2\n' });
    const head = commit(dir, 'second', { 'c.ts': 'c1\nc2\n' });

    const ctx = await collectLocalDiff({
      repoDir: dir,
      base,
      sinceSha: since,
      pathsIgnore: ['**/*.lock'],
      maxDiffBytes: 1_000_000,
    });

    expect(ctx.baseSha).toBe(base);
    expect(ctx.headSha).toBe(head);
    expect(ctx.sinceSha).toBe(since);
    expect(ctx.ignoredPaths).toEqual(['b.lock']);
    expect(ctx.patch).not.toContain('b.lock');
    expect(ctx.files.map((f) => f.path)).toEqual(['a.ts', 'c.ts']);
    expect(ctx.totalAdditions).toBe(2);
    expect(ctx.totalDeletions).toBe(1);
    expect(ctx.truncated).toBe(false);

    // `a.ts` changed before `since`, so it stays in the patch for context but is muted.
    expect(ctx.files.find((f) => f.path === 'a.ts')?.ignored).toBe(true);
    expect(ctx.files.find((f) => f.path === 'c.ts')?.ignored).toBe(false);
    expect(ctx.files[0]?.changedLines).toEqual([2]);
  });

  it('defaults the base to a merge-base with the default branch', async () => {
    const dir = newRepo();
    commit(dir, 'base', { 'a.ts': 'one\n' });
    const forkPoint = git(dir, ['rev-parse', 'HEAD']);
    git(dir, ['checkout', '-qb', 'feature']);
    commit(dir, 'work', { 'a.ts': 'one\ntwo\n', 'z.ts': 'z\n' });

    const ctx = await collectLocalDiff({ repoDir: dir, pathsIgnore: [], maxDiffBytes: 1_000_000 });
    expect(ctx.baseSha).toBe(forkPoint);
    expect(ctx.files.map((f) => f.path)).toEqual(['a.ts', 'z.ts']);
  });

  it('includes staged and unstaged working-tree edits when --head is omitted', async () => {
    const dir = newRepo();
    const base = commit(dir, 'base', { 'a.ts': 'one\ntwo\n', 'b.ts': 'old\n' });
    writeFileSync(join(dir, 'a.ts'), 'one\nTWO\n');
    git(dir, ['add', 'a.ts']);
    writeFileSync(join(dir, 'b.ts'), 'new\n');

    const ctx = await collectLocalDiff({
      repoDir: dir,
      base,
      pathsIgnore: [],
      maxDiffBytes: 1_000_000,
    });

    expect(ctx.files.map((file) => file.path)).toEqual(['a.ts', 'b.ts']);
    expect(ctx.patch).toContain('+TWO');
    expect(ctx.patch).toContain('+new');
  });

  it('truncates on whole-file boundaries', async () => {
    const dir = newRepo();
    const base = commit(dir, 'base', { 'a.ts': 'one\n', 'z.ts': 'z\n' });
    commit(dir, 'work', { 'a.ts': 'one\ntwo\n', 'z.ts': 'z\nzz\n' });

    const ctx = await collectLocalDiff({ repoDir: dir, base, pathsIgnore: [], maxDiffBytes: 150 });
    expect(ctx.truncated).toBe(true);
    expect(ctx.files.map((f) => f.path)).toEqual(['a.ts']);
  });

  it('degrades to a full review when sinceSha is unreachable', async () => {
    const dir = newRepo();
    const base = commit(dir, 'base', { 'a.ts': 'one\n' });
    commit(dir, 'work', { 'a.ts': 'one\ntwo\n' });

    const ctx = await collectLocalDiff({
      repoDir: dir,
      base,
      sinceSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      pathsIgnore: [],
      maxDiffBytes: 1_000_000,
    });
    expect(ctx.files[0]?.ignored).toBe(false);
  });
});

describe('collectFromPatch', () => {
  it('normalizes an API patch exactly like a local one', () => {
    const patch = [
      'diff --git a/src/app.ts b/src/app.ts',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1 +1,2 @@',
      ' a',
      '+b',
      'diff --git a/x.lock b/x.lock',
      '--- a/x.lock',
      '+++ b/x.lock',
      '@@ -1 +1 @@',
      '-p',
      '+q',
      '',
    ].join('\n');

    const ctx = collectFromPatch(patch, {
      baseSha: 'b'.repeat(40),
      headSha: 'h'.repeat(40),
      sinceSha: 'x'.repeat(40),
      pathsIgnore: ['**/*.lock'],
      maxDiffBytes: 1_000_000,
    });

    expect(ctx.ignoredPaths).toEqual(['x.lock']);
    expect(ctx.files.map((f) => f.path)).toEqual(['src/app.ts']);
    expect(ctx.files[0]?.changedLines).toEqual([2]);
    expect(ctx.files[0]?.positionByLine.get(2)).toBe(2);
    expect(ctx.totalAdditions).toBe(1);
    expect(ctx.totalDeletions).toBe(0);
    expect(ctx.sinceSha).toBe('x'.repeat(40));
    expect(ctx.baseSha).toBe('b'.repeat(40));
    expect(ctx.truncated).toBe(false);
  });
});
