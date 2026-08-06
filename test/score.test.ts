import { describe, expect, it } from 'vitest';
import { applyPublishRules, requiredAgreement, scoreReview } from '../src/merge/score.js';
import { needsVerification, readJudgement } from '../src/merge/verify.js';
import { defaultConfig } from '../src/config.js';
import type { Cluster, JurorConfig, ModelReport, ModelRun, PublishMode, Severity } from '../src/types.js';

function config(
  over: Partial<JurorConfig['consensus']> = {},
  floor: Severity = 'P3',
  publishMode: PublishMode = 'consensus',
): JurorConfig {
  const base = defaultConfig();
  return {
    ...base,
    consensus: { ...base.consensus, min_agreement: 'majority', ...over },
    review: { ...base.review, publish_mode: publishMode, severity_floor: floor },
  };
}

function cluster(over: Partial<Cluster> = {}): Cluster {
  return {
    id: 'abc1234567',
    path: 'src/app.ts',
    line: 42,
    endLine: null,
    severity: 'P1',
    category: 'correctness',
    title: 'Unawaited promise in shutdown handler',
    body: 'Buffered writes are lost on exit.',
    convention: null,
    modelIds: ['model-a'],
    modelLabels: ['Model A'],
    agreement: 1,
    members: [],
    anchor: 'exact',
    maxConfidence: 0.8,
    mergedBy: ['singleton'],
    verification: null,
    published: false,
    suppressedReason: null,
    ...over,
  };
}

function verification(refuted: boolean) {
  return {
    refuted,
    reason: refuted ? 'guarded at app.ts:12' : 'reachable from handler at app.ts:40',
    byModel: 'DeepSeek V4 Flash',
    cost: { usd: 0.001, source: 'estimated' as const, longContext: false },
  };
}

function run(modelLabel: string, mergeConfidence: number | null): ModelRun {
  const report: ModelReport | null =
    mergeConfidence === null
      ? null
      : {
          merge_confidence: mergeConfidence,
          confidence_reason: 'because',
          summary: 'does a thing',
          highlights: [],
          file_overviews: [],
          sequence_diagram: null,
          async_contracts: [],
          findings: [],
        };
  return {
    modelId: modelLabel.toLowerCase(),
    modelLabel,
    harness: 'claude-code',
    harnessLabel: 'Claude Code',
    pricingKey: modelLabel.toLowerCase(),
    ok: report !== null,
    skipped: false,
    skipReason: null,
    result: report === null
      ? null
      : {
          report,
          usage: null,
          reportedCostUsd: null,
          turns: 1,
          truncated: false,
          rawText: '',
          diagnostics: [],
        },
    cost: { usd: 0, source: 'estimated', longContext: false },
    durationMs: 1000,
    error: null,
  };
}

describe('requiredAgreement', () => {
  it('resolves majority, all, and explicit counts', () => {
    expect(requiredAgreement('majority', 4)).toBe(3);
    expect(requiredAgreement('majority', 3)).toBe(2);
    expect(requiredAgreement('majority', 1)).toBe(1);
    expect(requiredAgreement('all', 4)).toBe(4);
    expect(requiredAgreement(3, 4)).toBe(3);
  });

  it('never demands fewer than one model', () => {
    expect(requiredAgreement(0, 4)).toBe(1);
    expect(requiredAgreement(-2, 4)).toBe(1);
  });
});

describe('needsVerification', () => {
  it('does not spend verification calls on findings below a strict agreement bar', () => {
    expect(needsVerification(cluster({ severity: 'P0', agreement: 2 }), true, 4)).toBe(false);
    expect(needsVerification(cluster({ severity: 'P0', agreement: 4 }), true, 4)).toBe(true);
    expect(needsVerification(cluster({ severity: 'P2', agreement: 1 }), true, 1)).toBe(true);
  });

  it('keeps serious exceptions without verifying below-threshold P2/P3 findings', () => {
    expect(needsVerification(cluster({ severity: 'P1', agreement: 1 }), true, 3, true)).toBe(true);
    expect(needsVerification(cluster({ severity: 'P2', agreement: 1 }), true, 3, true)).toBe(false);
    expect(needsVerification(cluster({ severity: 'P3', agreement: 1 }), true, 3, true)).toBe(false);
  });
});

describe('readJudgement', () => {
  it('accepts only evidence-backed, unhedged confirmations', () => {
    expect(
      readJudgement({ refuted: false, reason: 'reachable from the handler at src/app.ts:40' }),
    ).toMatchObject({ refuted: false });
    expect(readJudgement({ refuted: false, reason: '' })).toMatchObject({ refuted: true });
    expect(readJudgement({ refuted: false, reason: 'the failure is reachable' })).toMatchObject({
      refuted: true,
    });
    expect(
      readJudgement({ refuted: false, reason: 'possibly reachable at src/app.ts:40' }),
    ).toMatchObject({ refuted: true });
  });
});

describe('applyPublishRules', () => {
  const c = config();

  it('publishes every eligible deduplicated cluster by default', () => {
    const defaults = defaultConfig();
    const [solo, refuted] = applyPublishRules(
      [
        cluster({ severity: 'P2', agreement: 1 }),
        cluster({ id: 'refuted', severity: 'P1', agreement: 1, verification: verification(true) }),
      ],
      defaults,
      4,
    );
    expect(defaults.review.publish_mode).toBe('all');
    expect(solo?.published).toBe(true);
    expect(refuted?.published).toBe(true);
  });

  it('still applies anchoring and severity controls in all-findings mode', () => {
    const all = config({}, 'P2', 'all');
    const [unknown, belowFloor, summaryOnly] = applyPublishRules(
      [
        cluster({ id: 'unknown', anchor: 'unknown-file', severity: 'P1' }),
        cluster({ id: 'low', severity: 'P3' }),
        cluster({ id: 'outside', anchor: 'outside-diff', severity: 'P2' }),
      ],
      all,
      4,
    );
    expect(unknown).toMatchObject({ published: false, suppressedReason: 'outside the diff' });
    expect(belowFloor).toMatchObject({ published: false, suppressedReason: 'below severity floor' });
    expect(summaryOnly).toMatchObject({ published: true, suppressedReason: null });
  });

  it('publishes at or above the required agreement', () => {
    const [out] = applyPublishRules([cluster({ severity: 'P2', agreement: 3 })], c, 4);
    expect(out?.published).toBe(true);
    expect(out?.suppressedReason).toBeNull();
  });

  it('publishes a corroborated serious finding below majority', () => {
    const [out] = applyPublishRules([cluster({ severity: 'P0', agreement: 2 })], c, 5);
    expect(out?.published).toBe(true);
  });

  it('publishes a solo serious finding only once it survives refutation', () => {
    const solo = cluster({ severity: 'P1', agreement: 1 });

    const [unverified] = applyPublishRules([solo], c, 4);
    expect(unverified?.published).toBe(false);
    expect(unverified?.suppressedReason).toBe('below agreement threshold');

    const [survived] = applyPublishRules(
      [cluster({ ...solo, verification: verification(false) })],
      c,
      4,
    );
    expect(survived?.published).toBe(true);
  });

  it('never publishes a solo P2, verified or not', () => {
    const [out] = applyPublishRules(
      [cluster({ severity: 'P2', agreement: 1, verification: verification(false) })],
      c,
      4,
    );
    expect(out?.published).toBe(false);
    expect(out?.suppressedReason).toBe('below agreement threshold');
  });

  it('suppresses a refuted finding no matter how many models agreed', () => {
    const [out] = applyPublishRules(
      [cluster({ severity: 'P0', agreement: 4, verification: verification(true) })],
      c,
      4,
    );
    expect(out?.published).toBe(false);
    expect(out?.suppressedReason).toBe('refuted on verification');
  });

  it('applies the first matching reason in order', () => {
    // unknown-file outranks a refutation, which outranks the severity floor.
    const [outside] = applyPublishRules(
      [cluster({ anchor: 'unknown-file', severity: 'P3', verification: verification(true) })],
      config({}, 'P2'),
      4,
    );
    expect(outside?.suppressedReason).toBe('outside the diff');

    const [refuted] = applyPublishRules(
      [cluster({ severity: 'P3', verification: verification(true) })],
      config({}, 'P2'),
      4,
    );
    expect(refuted?.suppressedReason).toBe('refuted on verification');

    const [belowFloor] = applyPublishRules([cluster({ severity: 'P3', agreement: 4 })], config({}, 'P2'), 4);
    expect(belowFloor?.suppressedReason).toBe('below severity floor');
  });

  it('honors an explicit all-model agreement threshold', () => {
    const strict = config({ min_agreement: 'all' });
    const [out] = applyPublishRules([cluster({ severity: 'P2', agreement: 3 })], strict, 4);
    expect(out?.published).toBe(false);
    expect(out?.suppressedReason).toBe('below agreement threshold');
  });

  it('treats min_agreement all as literal unanimity without serious-finding exceptions', () => {
    const strict = config({ min_agreement: 'all' });
    const [pair, unanimous] = applyPublishRules(
      [
        cluster({ id: 'pair', severity: 'P0', agreement: 2, verification: verification(false) }),
        cluster({ id: 'all', severity: 'P0', agreement: 4, verification: verification(false) }),
      ],
      strict,
      4,
    );
    expect(pair).toMatchObject({ published: false, suppressedReason: 'below agreement threshold' });
    expect(unanimous).toMatchObject({ published: true, suppressedReason: null });
  });

  it('returns new objects and mutates nothing', () => {
    const input = cluster({ severity: 'P0', agreement: 3 });
    const [out] = applyPublishRules([input], c, 4);
    expect(input.published).toBe(false);
    expect(input.suppressedReason).toBeNull();
    expect(out).not.toBe(input);
  });
});

describe('scoreReview', () => {
  const published = (severity: Severity) => cluster({ severity, published: true });

  it('takes the median vote when nothing is published', () => {
    const verdict = scoreReview([], [run('A', 5), run('B', 3), run('C', 4)]);
    expect(verdict.base).toBe(4);
    expect(verdict.penalty).toBe(0);
    expect(verdict.score).toBe(4);
    expect(verdict.votes).toHaveLength(3);
  });

  it('averages the two middle votes on an even count', () => {
    const verdict = scoreReview([], [run('A', 5), run('B', 4), run('C', 3), run('D', 2)]);
    expect(verdict.base).toBe(3.5);
    expect(verdict.score).toBe(4); // caller rounds
  });

  it('caps at 3 for a confirmed P0 even when every model voted 5', () => {
    const verdict = scoreReview(
      [published('P0')],
      [run('A', 5), run('B', 5), run('C', 5), run('D', 5)],
    );
    expect(verdict.base).toBe(5);
    expect(verdict.penalty).toBe(2);
    expect(verdict.score).toBe(3);
    expect(verdict.confirmed.P0).toBe(1);
  });

  it('caps P2 penalty at 1 in total and ignores P3s', () => {
    const clusters = [published('P2'), published('P2'), published('P2'), published('P3')];
    const verdict = scoreReview(clusters, [run('A', 5)]);
    expect(verdict.penalty).toBe(1);
    expect(verdict.score).toBe(4);
    expect(verdict.confirmed).toEqual({ P0: 0, P1: 0, P2: 3, P3: 1 });
  });

  it('counts only published clusters', () => {
    const verdict = scoreReview(
      [cluster({ severity: 'P0', published: false, suppressedReason: 'refuted on verification' })],
      [run('A', 5)],
    );
    expect(verdict.penalty).toBe(0);
    expect(verdict.confirmed.P0).toBe(0);
    expect(verdict.score).toBe(5);
  });

  it('never falls below 1 however many blockers land', () => {
    const clusters = [published('P0'), published('P0'), published('P0')];
    const verdict = scoreReview(clusters, [run('A', 4)]);
    expect(verdict.penalty).toBe(6);
    expect(verdict.score).toBe(1);
  });

  it('ignores models that produced no report', () => {
    const verdict = scoreReview([], [run('A', 2), run('B', null)]);
    expect(verdict.votes).toEqual([{ modelLabel: 'A', vote: 2 }]);
    expect(verdict.base).toBe(2);
    expect(verdict.score).toBe(2);
  });

  it('falls back to the penalty alone when no model voted', () => {
    const none = scoreReview([], [run('A', null)]);
    expect(none.base).toBe(3);
    expect(none.score).toBe(5);

    const blocked = scoreReview([published('P1')], [run('A', null)]);
    expect(blocked.base).toBe(3);
    expect(blocked.score).toBe(4);
  });
});
