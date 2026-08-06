import { describe, expect, it } from 'vitest';

import { buildCluster } from '../src/merge/cluster.js';
import { applyMerges, readRefereeVerdict } from '../src/merge/referee.js';
import type { AttributedFinding } from '../src/types.js';

const merge = {
  ids: ['f1', 'f2'],
  same_trigger: true,
  same_mechanism: true,
  same_consequence: true,
  same_fix: true,
  canonical: {
    title: 'Save promise is discarded',
    body: 'The wrapper returns void, so callers cannot await persistence; return the promise.',
  },
};

describe('referee verdict coverage', () => {
  it('accepts a complete lossless partition', () => {
    expect(
      readRefereeVerdict({ merges: [merge], distinct: ['f3'] }, ['f1', 'f2', 'f3']),
    ).toEqual({
      merges: [
        {
          ids: ['f1', 'f2'],
          canonical: merge.canonical,
        },
      ],
      distinct: ['f3'],
    });
  });

  it('accepts an all-distinct verdict', () => {
    expect(readRefereeVerdict({ merges: [], distinct: ['f1', 'f2'] }, ['f1', 'f2'])).toEqual({
      merges: [],
      distinct: ['f1', 'f2'],
    });
  });

  it.each([
    ['missing id', { merges: [], distinct: ['f1'] }],
    ['repeated id', { merges: [merge], distinct: ['f2', 'f3'] }],
    ['invented id', { merges: [], distinct: ['f1', 'f2', 'f9'] }],
    [
      'unproven mechanism',
      { merges: [{ ...merge, same_mechanism: false }], distinct: ['f3'] },
    ],
    ['legacy partial shape', { merges: [['f1', 'f2']], canonical: {} }],
  ])('rejects a %s verdict instead of risking an over-merge', (_name, verdict) => {
    expect(readRefereeVerdict(verdict, ['f1', 'f2', 'f3'])).toBeNull();
  });

  it('applies only the proven duplicate group and preserves a nearby async defect', () => {
    const finding = (sourceId: string, title: string): AttributedFinding => ({
      sourceId,
      path: 'src/editor.ts',
      line: 287,
      end_line: null,
      severity: 'P1',
      title,
      body: title,
      category: 'correctness',
      confidence: 0.8,
      convention: null,
      modelId: sourceId.split(':')[0] ?? 'model',
      modelLabel: sourceId.split(':')[0] ?? 'model',
      anchoredLine: 287,
      anchor: 'exact',
      anchorDrift: 0,
    });
    const promiseA = finding('kimi:1', 'Behavior save promise is discarded');
    const promiseB = finding('grok:1', 'Await cannot observe Behavior failure');
    const retry = finding('kimi:2', 'Failed autosave retries forever');
    const initial = [promiseA, promiseB, retry].map((item) =>
      buildCluster([item], ['singleton']),
    );

    const clusters = applyMerges(initial, [
      {
        verdict: {
          merges: [{ ids: ['f1', 'f2'], canonical: merge.canonical }],
          distinct: ['f3'],
        },
        ids: new Map([
          ['kimi:1', 'f1'],
          ['grok:1', 'f2'],
          ['kimi:2', 'f3'],
        ]),
      },
    ]);

    expect(clusters).toHaveLength(2);
    expect(clusters.find((item) => item.members.length === 2)?.agreement).toBe(2);
    expect(clusters.find((item) => item.members.length === 1)?.title).toBe(
      'Failed autosave retries forever',
    );
  });
});
