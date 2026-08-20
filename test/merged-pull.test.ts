import { describe, expect, it, vi } from 'vitest';

import type { PullMeta } from '../src/github/client.js';
import { resolveMergedPull } from '../src/github/merged-pull.js';

const SHA = {
  staleBase: 'a'.repeat(40),
  actualBase: 'b'.repeat(40),
  head: 'c'.repeat(40),
  merge: 'd'.repeat(40),
  secondParent: 'e'.repeat(40),
  rebasedFirst: 'f'.repeat(40),
  rebasedSecond: '1'.repeat(40),
};

function pull(): PullMeta {
  return {
    number: 42,
    title: 'merged',
    body: '',
    baseSha: SHA.staleBase,
    headSha: SHA.head,
    baseRef: 'main',
    headRef: 'feature',
    draft: false,
    state: 'closed',
    merged: true,
    mergedAt: '2026-08-18T00:00:00Z',
    mergeCommitSha: SHA.merge,
    commitCount: 1,
    htmlUrl: 'https://github.test/owner/repo/pull/42',
    baseRepo: 'owner/repo',
    headRepo: 'owner/repo',
  };
}

function apiWithTopology(
  getCommitParents: (sha: string) => Promise<string[]>,
  relationship: 'ahead' | 'behind' | 'diverged' | 'identical' = 'diverged',
) {
  return {
    getCommitParents: vi.fn(getCommitParents),
    getCommitRelationship: vi.fn(async () => relationship),
  };
}

describe('resolveMergedPull', () => {
  it('resolves an ordinary merge exactly from topology without fetching a diff', async () => {
    const api = apiWithTopology(async () => [SHA.actualBase, SHA.head]);

    await expect(resolveMergedPull(api, pull())).resolves.toEqual({
      mergeSha: SHA.merge,
      policyBaseShas: [SHA.actualBase],
      sourceBaseSha: SHA.actualBase,
      baseResolution: 'exact',
    });
    expect(api.getCommitParents).toHaveBeenCalledOnce();
    expect(api.getCommitParents).toHaveBeenCalledWith(SHA.merge);
  });

  it('rejects an indirect two-parent merge whose second parent is not the captured PR head', async () => {
    const api = apiWithTopology(async () => [SHA.head, SHA.secondParent]);

    await expect(resolveMergedPull(api, pull())).rejects.toThrow(
      'requires the captured PR head as the second parent',
    );
  });

  it('resolves a one-commit squash or rebase exactly without fetching a diff', async () => {
    const api = apiWithTopology(async () => [SHA.actualBase]);

    await expect(resolveMergedPull(api, pull())).resolves.toEqual({
      mergeSha: SHA.merge,
      policyBaseShas: [SHA.actualBase],
      sourceBaseSha: SHA.actualBase,
      baseResolution: 'exact',
    });
    expect(api.getCommitParents).toHaveBeenCalledOnce();
    expect(api.getCommitRelationship).toHaveBeenCalledWith(SHA.head, SHA.merge);
  });

  it.each(['identical', 'ahead', 'behind'] as const)(
    'rejects a one-parent merge whose captured head relationship is %s',
    async (relationship) => {
      const api = apiWithTopology(async () => [SHA.actualBase], relationship);

      await expect(resolveMergedPull(api, pull())).rejects.toThrow(
        'indirect or unrecognized one-parent merge',
      );
      expect(api.getCommitRelationship).toHaveBeenCalledWith(SHA.head, SHA.merge);
    },
  );

  it('rejects a one-parent merge with an invalid captured head', async () => {
    const api = apiWithTopology(async () => [SHA.actualBase]);

    await expect(resolveMergedPull(api, { ...pull(), headSha: 'missing' })).rejects.toThrow(
      'no valid captured head commit',
    );
    expect(api.getCommitRelationship).not.toHaveBeenCalled();
  });

  it('enumerates every plausible base for an ambiguous one-parent merge', async () => {
    const api = apiWithTopology(async (sha: string) => {
      if (sha === SHA.merge) return [SHA.rebasedSecond];
      if (sha === SHA.rebasedSecond) return [SHA.rebasedFirst];
      if (sha === SHA.rebasedFirst) return [SHA.actualBase];
      return [];
    });

    await expect(resolveMergedPull(api, { ...pull(), commitCount: 3 })).resolves.toEqual({
      mergeSha: SHA.merge,
      policyBaseShas: [SHA.rebasedSecond, SHA.rebasedFirst, SHA.actualBase],
      sourceBaseSha: SHA.actualBase,
      baseResolution: 'conservative',
    });
    expect(api.getCommitParents).toHaveBeenCalledTimes(3);
  });

  it('stops after a candidate whose own topology cannot be another rebased commit', async () => {
    const api = apiWithTopology(async (sha: string) => {
      if (sha === SHA.merge) return [SHA.rebasedSecond];
      if (sha === SHA.rebasedSecond) return [SHA.rebasedFirst];
      if (sha === SHA.rebasedFirst) return [SHA.actualBase, SHA.secondParent];
      throw new Error(`walk continued past topology boundary ${sha}`);
    });

    await expect(resolveMergedPull(api, { ...pull(), commitCount: 4 })).resolves.toEqual({
      mergeSha: SHA.merge,
      policyBaseShas: [SHA.rebasedSecond, SHA.rebasedFirst],
      sourceBaseSha: SHA.rebasedFirst,
      baseResolution: 'conservative',
    });
    expect(api.getCommitParents).toHaveBeenCalledTimes(3);
  });

  it('marks a topology boundary at the first candidate as exact', async () => {
    const api = apiWithTopology(async (sha: string) =>
      sha === SHA.merge
        ? [SHA.actualBase]
        : [SHA.staleBase, SHA.secondParent]);

    await expect(resolveMergedPull(api, { ...pull(), commitCount: 3 })).resolves.toEqual({
      mergeSha: SHA.merge,
      policyBaseShas: [SHA.actualBase],
      sourceBaseSha: SHA.actualBase,
      baseResolution: 'exact',
    });
    expect(api.getCommitParents).toHaveBeenCalledTimes(2);
  });

  it('bounds an ambiguous first-parent walk to one hundred candidates', async () => {
    const chain = Array.from(
      { length: 100 },
      (_, index) => (index + 2).toString(16).padStart(40, '0'),
    );
    const api = apiWithTopology(async (sha: string) => {
      if (sha === SHA.merge) return [chain[0]!];
      const index = chain.indexOf(sha);
      return index >= 0 && index + 1 < chain.length ? [chain[index + 1]!] : [];
    });

    const resolved = await resolveMergedPull(api, { ...pull(), commitCount: 100 });

    expect(resolved.policyBaseShas).toEqual(chain);
    expect(resolved.sourceBaseSha).toBe(chain[99]);
    expect(resolved.baseResolution).toBe('conservative');
    expect(api.getCommitParents).toHaveBeenCalledTimes(100);
  });

  it.each([0, 101, 1.5])('fails closed for an invalid one-parent commit count %s', async (commitCount) => {
    const api = apiWithTopology(async () => [SHA.actualBase]);

    await expect(resolveMergedPull(api, { ...pull(), commitCount })).rejects.toThrow(
      'invalid or unbounded one-parent history',
    );
    expect(api.getCommitParents).toHaveBeenCalledOnce();
  });

  it('fails closed for an unexpected octopus merge without fetching a diff', async () => {
    const api = apiWithTopology(async () => [SHA.actualBase, SHA.secondParent, SHA.head]);

    await expect(resolveMergedPull(api, pull())).rejects.toThrow('unsupported merge commit');
  });

  it('fails closed when the reported merge commit has no parent', async () => {
    const api = apiWithTopology(async () => []);

    await expect(resolveMergedPull(api, pull())).rejects.toThrow('has no first parent');
    expect(api.getCommitParents).toHaveBeenCalledOnce();
  });
});
