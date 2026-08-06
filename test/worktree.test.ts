import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { gitStateDir } from '../src/util/workspace.js';
import { checkoutAt } from '../src/util/worktree.js';

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
      expect(await gitStateDir(checkout.dir)).toBe(await gitStateDir(repo));

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
});
