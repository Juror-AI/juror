import { describe, expect, it } from 'vitest';
import { anchorFindings } from '../src/diff/anchor.js';
import { parseUnifiedPatch } from '../src/diff/patch.js';
import type { DiffContext, RawFinding } from '../src/types.js';

const PATCH = [
  'diff --git a/src/app.ts b/src/app.ts',
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
  'diff --git a/assets/logo.png b/assets/logo.png',
  'Binary files a/assets/logo.png and b/assets/logo.png differ',
  '',
].join('\n');

function context(patch = PATCH): DiffContext {
  return {
    patch,
    files: parseUnifiedPatch(patch),
    baseSha: 'b'.repeat(40),
    headSha: 'h'.repeat(40),
    sinceSha: null,
    totalAdditions: 4,
    totalDeletions: 2,
    ignoredPaths: [],
    truncated: false,
  };
}

function finding(over: Partial<RawFinding> = {}): RawFinding {
  return {
    path: 'src/app.ts',
    line: 3,
    end_line: null,
    severity: 'P1',
    title: 'Off-by-one',
    body: 'The loop runs one iteration too many.',
    category: 'correctness',
    confidence: 0.8,
    convention: null,
    ...over,
  };
}

const anchor = (f: RawFinding[], tolerance = 3, diff = context()) =>
  anchorFindings(f, diff, 'claude-opus-5', 'Opus 5', tolerance);

describe('anchorFindings', () => {
  it('marks a line the diff adds as exact', () => {
    const [a] = anchor([finding({ line: 3 }), finding({ line: 24 })]);
    expect(a).toMatchObject({ anchor: 'exact', anchoredLine: 3, anchorDrift: 0, modelId: 'claude-opus-5', modelLabel: 'Opus 5' });
  });

  it('carries the original finding fields through untouched', () => {
    const src = finding({ line: 4, title: 'Keep me', end_line: 9, convention: 'no-any' });
    const [a] = anchor([src]);
    expect(a).toMatchObject({ title: 'Keep me', end_line: 9, convention: 'no-any', severity: 'P1', confidence: 0.8 });
  });

  it('snaps to the nearest changed line inside the tolerance', () => {
    const [a] = anchor([finding({ line: 6 })]); // changed: 3, 4, 23, 24
    expect(a).toMatchObject({ anchor: 'snapped', anchoredLine: 4, anchorDrift: 2 });
  });

  it('snaps upward as happily as downward', () => {
    const [a] = anchor([finding({ line: 21 })]);
    expect(a).toMatchObject({ anchor: 'snapped', anchoredLine: 23, anchorDrift: 2 });
  });

  it('breaks a tie toward the lower line so the result is deterministic', () => {
    const patch = [
      'diff --git a/t.ts b/t.ts',
      '--- a/t.ts',
      '+++ b/t.ts',
      '@@ -10 +10 @@',
      '-a',
      '+b',
      '@@ -20 +20 @@',
      '-c',
      '+d',
      '',
    ].join('\n');
    const diff = context(patch);
    expect(diff.files[0]!.changedLines).toEqual([10, 20]);
    const [a] = anchor([finding({ path: 't.ts', line: 15 })], 10, diff);
    expect(a).toMatchObject({ anchor: 'snapped', anchoredLine: 10, anchorDrift: 5 });
  });

  it('keeps a finding just outside the tolerance, without moving it', () => {
    const [a] = anchor([finding({ line: 8 })]); // nearest is 4, drift 4 > 3
    expect(a).toMatchObject({ anchor: 'outside-diff', anchoredLine: 8, anchorDrift: 4 });
  });

  it('honours the tolerance boundary exactly', () => {
    expect(anchor([finding({ line: 7 })])[0]).toMatchObject({ anchor: 'snapped', anchoredLine: 4 });
    expect(anchor([finding({ line: 7 })], 2)[0]).toMatchObject({ anchor: 'outside-diff', anchoredLine: 7 });
    expect(anchor([finding({ line: 4 })], 0)[0]).toMatchObject({ anchor: 'exact', anchoredLine: 4 });
  });

  it('reports a path the diff does not contain as unknown-file', () => {
    const [a] = anchor([finding({ path: 'src/never-touched.ts', line: 3 })]);
    expect(a).toMatchObject({ anchor: 'unknown-file', anchoredLine: 3, anchorDrift: 0 });
  });

  it('resolves a path the model emitted relative to a subdirectory', () => {
    const [a] = anchor([finding({ path: 'app.ts', line: 3 })]);
    expect(a).toMatchObject({ anchor: 'exact', anchoredLine: 3 });
  });

  it('resolves a path the model prefixed with a workspace root', () => {
    const [a] = anchor([finding({ path: '/home/runner/work/repo/src/app.ts', line: 24 })]);
    expect(a).toMatchObject({ anchor: 'exact', anchoredLine: 24 });
  });

  it('treats a file with no post-image changes as outside-diff, not unknown-file', () => {
    const [a] = anchor([finding({ path: 'assets/logo.png', line: 1 })]);
    expect(a).toMatchObject({ anchor: 'outside-diff', anchoredLine: 1, anchorDrift: 0 });
  });

  it('finds a renamed file under its old name', () => {
    const patch = [
      'diff --git a/src/old.ts b/src/new.ts',
      'rename from src/old.ts',
      'rename to src/new.ts',
      '--- a/src/old.ts',
      '+++ b/src/new.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '',
    ].join('\n');
    const [a] = anchor([finding({ path: 'src/old.ts', line: 1 })], 3, context(patch));
    expect(a).toMatchObject({ anchor: 'exact', anchoredLine: 1, path: 'src/old.ts' });
  });

  it('never drops a finding, whatever the anchor', () => {
    const input = [
      finding({ line: 3 }),
      finding({ line: 6 }),
      finding({ line: 900 }),
      finding({ path: 'nope.ts', line: 1 }),
    ];
    const out = anchor(input);
    expect(out).toHaveLength(4);
    expect(out.map((f) => f.anchor)).toEqual(['exact', 'snapped', 'outside-diff', 'unknown-file']);
  });

  it('survives a diff with no files at all', () => {
    const empty = context('');
    const out = anchorFindings([finding()], empty, 'm', 'M', 3);
    expect(out[0]).toMatchObject({ anchor: 'unknown-file', anchoredLine: 3 });
  });

  it('does not mutate the incoming findings', () => {
    const src = finding({ line: 6 });
    anchor([src]);
    expect(src).toEqual(finding({ line: 6 }));
    expect(src).not.toHaveProperty('anchor');
  });
});
