import { describe, expect, it } from 'vitest';
import { filterPatch, matchesGlob, parseUnifiedPatch, truncatePatch } from '../src/diff/patch.js';

/**
 * Hand-computed reference patch. Positions are annotated per GitHub's rule: position 1
 * is the line after the FIRST `@@`, and everything after that counts — including the
 * second `@@` header (position 9).
 *
 *   pos  1 ` import fs from 'fs';`        → new 1
 *   pos  2 ` `                            → new 2
 *   pos  3 `-const a = 1;`                → (deleted, unmapped)
 *   pos  4 `+const a = 2;`                → new 3
 *   pos  5 `+const b = 3;`                → new 4
 *   pos  6 ` `                            → new 5
 *   pos  7 ` export function main() {`    → new 6
 *   pos  8 `   return a;`                 → new 7
 *   pos  9 `@@ -20,4 +21,5 @@ ...`        → (header, unmapped)
 *   pos 10 ` // tail`                     → new 21
 *   pos 11 ` function helper() {`         → new 22
 *   pos 12 `-  return 0;`                 → (deleted, unmapped)
 *   pos 13 `+  return 1;`                 → new 23
 *   pos 14 `+}`                           → new 24
 *   pos 15 ` // end`                      → new 25
 */
const TWO_HUNK = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,6 +1,7 @@',
  " import fs from 'fs';",
  ' ',
  '-const a = 1;',
  '+const a = 2;',
  '+const b = 3;',
  ' ',
  ' export function main() {',
  '   return a;',
  '@@ -20,4 +21,5 @@ export function main() {',
  ' // tail',
  ' function helper() {',
  '-  return 0;',
  '+  return 1;',
  '+}',
  ' // end',
  '',
].join('\n');

describe('parseUnifiedPatch — GitHub position map', () => {
  const files = parseUnifiedPatch(TWO_HUNK);
  const file = files[0]!;

  it('parses one file with two hunks', () => {
    expect(files).toHaveLength(1);
    expect(file.path).toBe('src/app.ts');
    expect(file.previousPath).toBeNull();
    expect(file.status).toBe('modified');
    expect(file.additions).toBe(4);
    expect(file.deletions).toBe(2);
    expect(file.hunks).toEqual([
      { oldStart: 1, oldLines: 6, newStart: 1, newLines: 7 },
      { oldStart: 20, oldLines: 4, newStart: 21, newLines: 5 },
    ]);
  });

  it('records every added post-image line as changed', () => {
    expect(file.changedLines).toEqual([3, 4, 23, 24]);
  });

  it('maps post-image lines to the exact hand-computed positions', () => {
    expect([...file.positionByLine.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [1, 1],
      [2, 2],
      [3, 4],
      [4, 5],
      [5, 6],
      [6, 7],
      [7, 8],
      [21, 10],
      [22, 11],
      [23, 13],
      [24, 14],
      [25, 15],
    ]);
  });

  it('never maps a deleted line, and counts the second @@ header as a position', () => {
    const positions = [...file.positionByLine.values()];
    expect(positions).not.toContain(3); // the `-const a = 1;` line
    expect(positions).not.toContain(9); // the second `@@` header
    expect(positions).not.toContain(12); // the `-  return 0;` line
  });
});

describe('parseUnifiedPatch — file statuses', () => {
  it('handles a new file', () => {
    const patch = [
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      'index 0000000..abcdef1',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,3 @@',
      '+export const a = 1;',
      '+export const b = 2;',
      '+export const c = 3;',
      '',
    ].join('\n');
    const f = parseUnifiedPatch(patch)[0]!;
    expect(f.status).toBe('added');
    expect(f.path).toBe('src/new.ts');
    expect(f.additions).toBe(3);
    expect(f.deletions).toBe(0);
    expect(f.changedLines).toEqual([1, 2, 3]);
    expect(f.positionByLine.get(1)).toBe(1);
    expect(f.positionByLine.get(3)).toBe(3);
  });

  it('handles a deleted file', () => {
    const patch = [
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      'index abcdef1..0000000',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-const a = 1;',
      '-const b = 2;',
      '',
    ].join('\n');
    const f = parseUnifiedPatch(patch)[0]!;
    expect(f.status).toBe('removed');
    expect(f.path).toBe('gone.ts');
    expect(f.deletions).toBe(2);
    expect(f.changedLines).toEqual([]);
    expect(f.positionByLine.size).toBe(0);
  });

  it('handles a rename with edits', () => {
    const patch = [
      'diff --git a/src/old-name.ts b/src/new-name.ts',
      'similarity index 87%',
      'rename from src/old-name.ts',
      'rename to src/new-name.ts',
      'index 1111111..2222222 100644',
      '--- a/src/old-name.ts',
      '+++ b/src/new-name.ts',
      '@@ -10,3 +10,3 @@ class Thing {',
      ' const keep = 1;',
      '-const drop = 2;',
      '+const added = 2;',
      ' const tail = 3;',
      '',
    ].join('\n');
    const f = parseUnifiedPatch(patch)[0]!;
    expect(f.status).toBe('renamed');
    expect(f.path).toBe('src/new-name.ts');
    expect(f.previousPath).toBe('src/old-name.ts');
    expect(f.changedLines).toEqual([11]);
    expect(f.positionByLine.get(10)).toBe(1);
    expect(f.positionByLine.get(11)).toBe(3);
    expect(f.positionByLine.get(12)).toBe(4);
  });

  it('handles a pure rename with no hunks', () => {
    const patch = [
      'diff --git a/a.txt b/b.txt',
      'similarity index 100%',
      'rename from a.txt',
      'rename to b.txt',
      '',
    ].join('\n');
    const f = parseUnifiedPatch(patch)[0]!;
    expect(f.status).toBe('renamed');
    expect(f.path).toBe('b.txt');
    expect(f.previousPath).toBe('a.txt');
    expect(f.hunks).toEqual([]);
    expect(f.changedLines).toEqual([]);
  });

  it('handles a binary file as zero changed lines', () => {
    const patch = [
      'diff --git a/assets/logo.png b/assets/logo.png',
      'index 1111111..2222222 100644',
      'Binary files a/assets/logo.png and b/assets/logo.png differ',
      '',
    ].join('\n');
    const f = parseUnifiedPatch(patch)[0]!;
    expect(f.path).toBe('assets/logo.png');
    expect(f.status).toBe('modified');
    expect(f.changedLines).toEqual([]);
    expect(f.positionByLine.size).toBe(0);
    expect(f.additions).toBe(0);
    expect(f.deletions).toBe(0);
  });

  it('unquotes quote-escaped paths in the git header', () => {
    const patch = [
      'diff --git "a/src/with space.ts" "b/src/with space.ts"',
      'index 1111111..2222222 100644',
      '--- "a/src/with space.ts"',
      '+++ "b/src/with space.ts"',
      '@@ -1 +1 @@',
      '-const a = 1;',
      '+const a = 2;',
      '',
    ].join('\n');
    const f = parseUnifiedPatch(patch)[0]!;
    expect(f.path).toBe('src/with space.ts');
    expect(f.changedLines).toEqual([1]);
    expect(f.positionByLine.get(1)).toBe(2);
  });

  it('decodes octal escapes in quoted paths', () => {
    const patch = [
      'diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"',
      '--- "a/src/caf\\303\\251.ts"',
      '+++ "b/src/caf\\303\\251.ts"',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '',
    ].join('\n');
    expect(parseUnifiedPatch(patch)[0]!.path).toBe('src/café.ts');
  });

  it('counts "\\ No newline at end of file" as a position but never maps it', () => {
    const patch = [
      'diff --git a/n.txt b/n.txt',
      '--- a/n.txt',
      '+++ b/n.txt',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    const f = parseUnifiedPatch(patch)[0]!;
    expect(f.changedLines).toEqual([2]);
    // ' keep'=1, '-old'=2, '\'=3, '+new'=4, '\'=5
    expect(f.positionByLine.get(1)).toBe(1);
    expect(f.positionByLine.get(2)).toBe(4);
  });

  it('parses several files in one patch and restarts positions per file', () => {
    const patch = `${TWO_HUNK}${[
      'diff --git a/src/other.ts b/src/other.ts',
      '--- a/src/other.ts',
      '+++ b/src/other.ts',
      '@@ -5,2 +5,3 @@',
      ' ctx',
      '+added',
      ' ctx2',
      '',
    ].join('\n')}`;
    const files = parseUnifiedPatch(patch);
    expect(files.map((f) => f.path)).toEqual(['src/app.ts', 'src/other.ts']);
    const other = files[1]!;
    expect(other.changedLines).toEqual([6]);
    expect(other.positionByLine.get(5)).toBe(1);
    expect(other.positionByLine.get(6)).toBe(2);
  });

  it('tolerates a context line that lost its leading space', () => {
    const patch = ['diff --git a/s.ts b/s.ts', '--- a/s.ts', '+++ b/s.ts', '@@ -1,3 +1,4 @@', ' a', '', '+c', ' d', ''].join(
      '\n',
    );
    const f = parseUnifiedPatch(patch)[0]!;
    expect(f.changedLines).toEqual([3]);
    expect(f.positionByLine.get(4)).toBe(4);
  });

  it('does not treat diff-like content inside a hunk as a new file', () => {
    const patch = [
      'diff --git a/fixtures/sample.patch b/fixtures/sample.patch',
      '--- a/fixtures/sample.patch',
      '+++ b/fixtures/sample.patch',
      '@@ -1,3 +1,3 @@',
      ' diff --git a/x b/x',
      '-@@ -1 +1 @@',
      '+@@ -1 +2 @@',
      ' tail',
      '',
    ].join('\n');
    const files = parseUnifiedPatch(patch);
    expect(files).toHaveLength(1);
    expect(files[0]!.changedLines).toEqual([2]);
  });

  it('returns nothing for an empty patch', () => {
    expect(parseUnifiedPatch('')).toEqual([]);
  });
});

describe('matchesGlob', () => {
  it('matches ** across directory separators', () => {
    expect(matchesGlob('a/b/c/pnpm-lock.yaml', '**/*.yaml')).toBe(true);
    expect(matchesGlob('pnpm-lock.yaml', '**/*.yaml')).toBe(true); // `**/` may match zero segments
    expect(matchesGlob('dist/a/b/c.js', 'dist/**')).toBe(true);
    expect(matchesGlob('src/dist/c.js', 'dist/**')).toBe(false);
  });

  it('does not let * cross a separator', () => {
    expect(matchesGlob('src/a.ts', 'src/*.ts')).toBe(true);
    expect(matchesGlob('src/deep/a.ts', 'src/*.ts')).toBe(false);
    expect(matchesGlob('a.lock', '*.lock')).toBe(true);
    expect(matchesGlob('sub/a.lock', '*.lock')).toBe(false);
  });

  it('supports ? and character classes', () => {
    expect(matchesGlob('a1.ts', 'a?.ts')).toBe(true);
    expect(matchesGlob('a12.ts', 'a?.ts')).toBe(false);
    expect(matchesGlob('a/b.ts', 'a?b.ts')).toBe(false);
    expect(matchesGlob('file1.ts', 'file[0-9].ts')).toBe(true);
    expect(matchesGlob('filex.ts', 'file[0-9].ts')).toBe(false);
    expect(matchesGlob('filex.ts', 'file[!0-9].ts')).toBe(true);
  });

  it('treats a leading ! as inversion', () => {
    expect(matchesGlob('src/a.ts', '!src/**')).toBe(false);
    expect(matchesGlob('docs/a.md', '!src/**')).toBe(true);
  });

  it('handles the shipped defaults', () => {
    for (const p of ['**/*.lock', 'dist/**', '**/*.generated.*']) {
      expect(matchesGlob('src/index.ts', p)).toBe(false);
    }
    expect(matchesGlob('yarn.lock', '**/*.lock')).toBe(true);
    expect(matchesGlob('packages/x/yarn.lock', '**/*.lock')).toBe(true);
    expect(matchesGlob('src/api.generated.ts', '**/*.generated.*')).toBe(true);
  });

  it('escapes regex metacharacters in literal segments', () => {
    expect(matchesGlob('a+b.ts', 'a+b.ts')).toBe(true);
    expect(matchesGlob('axb.ts', 'a+b.ts')).toBe(false);
    expect(matchesGlob('a.ts', 'a.ts')).toBe(true);
    expect(matchesGlob('axts', 'a.ts')).toBe(false);
  });

  it('ignores a leading ./ on either side', () => {
    expect(matchesGlob('./src/a.ts', 'src/*.ts')).toBe(true);
  });

  it('degrades a malformed character range to a non-match', () => {
    expect(() => matchesGlob('src/a.ts', '[z-a]')).not.toThrow();
    expect(matchesGlob('src/a.ts', '[z-a]')).toBe(false);
  });
});

describe('filterPatch', () => {
  const patch = [
    'diff --git a/src/app.ts b/src/app.ts',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
    '--- a/pnpm-lock.yaml',
    '+++ b/pnpm-lock.yaml',
    '@@ -1 +1 @@',
    '-x',
    '+y',
    'diff --git a/dist/bundle.js b/dist/bundle.js',
    '--- a/dist/bundle.js',
    '+++ b/dist/bundle.js',
    '@@ -1 +1 @@',
    '-p',
    '+q',
    '',
  ].join('\n');

  it('drops ignored chunks and reports their paths', () => {
    const out = filterPatch(patch, ['**/*.yaml', 'dist/**']);
    expect(out.ignored).toEqual(['pnpm-lock.yaml', 'dist/bundle.js']);
    expect(out.patch).toContain('src/app.ts');
    expect(out.patch).not.toContain('pnpm-lock.yaml');
    expect(out.patch).not.toContain('dist/bundle.js');
    expect(parseUnifiedPatch(out.patch).map((f) => f.path)).toEqual(['src/app.ts']);
  });

  it('is a no-op when nothing matches', () => {
    expect(filterPatch(patch, ['**/*.png'])).toEqual({ patch, ignored: [] });
    expect(filterPatch(patch, [])).toEqual({ patch, ignored: [] });
  });

  it('keeps the reassembled patch parseable and newline-terminated', () => {
    const out = filterPatch(patch, ['dist/**']);
    expect(out.patch.endsWith('\n')).toBe(true);
    expect(parseUnifiedPatch(out.patch)).toHaveLength(2);
  });
});

describe('truncatePatch', () => {
  const chunk = (path: string): string =>
    [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, '@@ -1 +1 @@', '-a', '+b'].join('\n');
  const patch = `${chunk('one.ts')}\n${chunk('two.ts')}\n${chunk('three.ts')}\n`;

  it('leaves a patch under the limit alone', () => {
    expect(truncatePatch(patch, 10_000)).toEqual({ patch, truncated: false });
    expect(truncatePatch(patch, 0)).toEqual({ patch, truncated: false });
  });

  it('drops whole files off the end, never mid-hunk', () => {
    const oneChunkBytes = Buffer.byteLength(`${chunk('one.ts')}\n`, 'utf8');
    const out = truncatePatch(patch, oneChunkBytes + 5);
    expect(out.truncated).toBe(true);
    const files = parseUnifiedPatch(out.patch);
    expect(files.map((f) => f.path)).toEqual(['one.ts']);
    expect(files[0]!.changedLines).toEqual([1]);
  });

  it('keeps at least the first hunk when a single file busts the budget', () => {
    const big = [
      'diff --git a/big.ts b/big.ts',
      '--- a/big.ts',
      '+++ b/big.ts',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+b',
      '@@ -50,1 +50,1 @@',
      '-c',
      '+d',
      '',
    ].join('\n');
    const out = truncatePatch(big, 10);
    expect(out.truncated).toBe(true);
    const f = parseUnifiedPatch(out.patch)[0]!;
    expect(f.path).toBe('big.ts');
    expect(f.hunks).toHaveLength(1);
    expect(f.changedLines).toEqual([1]);
  });
});
