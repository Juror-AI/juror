import { describe, expect, it } from 'vitest';
import { findingMarker, fingerprint, fingerprintsIn } from '../src/github/fingerprint.js';
import type { Cluster } from '../src/types.js';

function cluster(over: Partial<Cluster> = {}): Cluster {
  return {
    id: 'c1',
    path: 'src/app/invite.ts',
    line: 42,
    endLine: null,
    severity: 'P1',
    category: 'correctness',
    title: 'Clipboard write loses transient activation',
    body: 'Long body text that must not affect the fingerprint.',
    convention: null,
    modelIds: ['claude-opus-5'],
    modelLabels: ['Opus 5'],
    agreement: 1,
    members: [],
    anchor: 'exact',
    maxConfidence: 0.8,
    mergedBy: ['singleton'],
    verification: null,
    published: true,
    suppressedReason: null,
    ...over,
  };
}

describe('fingerprint', () => {
  it('is a 12-char lowercase hex digest', () => {
    expect(fingerprint(cluster())).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is stable across runs and across processes', () => {
    // Pinned literal, not a recomputation: a re-review must recognize findings written by
    // an older release, so changing the hash inputs is a breaking change that has to be
    // deliberate enough to update this line.
    expect(fingerprint(cluster())).toBe('2c30e281bf71');
    expect(fingerprint(cluster())).toBe(fingerprint(cluster()));
  });

  it('ignores case, punctuation and whitespace in the title', () => {
    const base = fingerprint(cluster());
    expect(fingerprint(cluster({ title: 'clipboard write loses transient activation' }))).toBe(base);
    expect(fingerprint(cluster({ title: 'Clipboard write loses transient activation!' }))).toBe(base);
    expect(fingerprint(cluster({ title: '  Clipboard  write, loses — transient activation.  ' }))).toBe(
      base,
    );
    expect(fingerprint(cluster({ title: '**Clipboard write** loses `transient activation`' }))).toBe(
      base,
    );
  });

  it('ignores the fields that drift between pushes', () => {
    const base = fingerprint(cluster());
    expect(fingerprint(cluster({ line: 4200, endLine: 4210 }))).toBe(base);
    expect(fingerprint(cluster({ body: 'rewritten explanation', agreement: 3 }))).toBe(base);
    expect(fingerprint(cluster({ modelIds: ['gpt-5.6-sol'], anchor: 'snapped' }))).toBe(base);
  });

  it('separates findings that differ in path, severity or meaning', () => {
    const base = fingerprint(cluster());
    expect(fingerprint(cluster({ path: 'src/app/other.ts' }))).not.toBe(base);
    expect(fingerprint(cluster({ severity: 'P0' }))).not.toBe(base);
    expect(fingerprint(cluster({ title: 'Clipboard write loses transient activations' }))).not.toBe(
      base,
    );
  });

  it('does not collide across the field separator', () => {
    // 'a\nP1\nb' must not equal 'a\nP1b' — otherwise a crafted title could impersonate
    // another finding's identity.
    expect(fingerprint(cluster({ path: 'a', severity: 'P1', title: 'b' }))).not.toBe(
      fingerprint(cluster({ path: 'a\nP1', severity: 'P1', title: 'b' })),
    );
  });

  it('round-trips hidden inline markers and ignores malformed ones', () => {
    const marker = findingMarker(cluster());
    expect(marker).toBe(`<!-- juror:finding:${fingerprint(cluster())} -->`);
    expect(fingerprintsIn(`${marker}\ntext\n<!-- juror:finding:not-a-hash -->`)).toEqual([
      fingerprint(cluster()),
    ]);
  });
});
