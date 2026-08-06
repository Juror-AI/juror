/**
 * The consensus regression that matters most.
 *
 * These five findings are verbatim output from a real fan-out — Opus 5, GPT-5.6 Sol and
 * DeepSeek V4 Flash reviewing the same seven-line diff on 2026-08-06. Three of them found
 * the same clipboard defect and described it in three different ways.
 *
 * The first implementation scored those three pairs at 0.23–0.33 on prose Jaccard, below
 * the "distinct" threshold, and published one unanimous bug as three separate 1-of-3
 * findings — the exact inversion of the product's premise. This file exists so that
 * cannot regress silently.
 */

import { describe, expect, it } from 'vitest';

import { clusterFindings, jaccard, similarity } from '../src/merge/cluster.js';
import type { AttributedFinding } from '../src/types.js';

const CLIPBOARD_OPUS = {
  title: 'Clipboard write deferred behind two awaits',
  body:
    "navigator.clipboard.writeText runs only after awaiting createInvite and refetchInvitations, so the click's " +
    'transient user activation has expired by the time the write is attempted and Safari rejects it with NotAllowedError.',
};

const CLIPBOARD_DEEPSEEK = {
  title: 'Clipboard write not synchronous in click handler',
  body:
    'navigator.clipboard.writeText fires only after awaiting createInvite and refetchInvitations, so it is no longer ' +
    'inside the user gesture that AGENTS.md requires for clipboard access.',
};

const CLIPBOARD_GPT = {
  title: 'Clipboard write loses user activation',
  body:
    '`createInvite` or `refetchInvitations` yields long enough for the click transient user activation to expire ' +
    'before navigator.clipboard.writeText is called, so nothing reaches the clipboard.',
};

const GUARD_OPUS = {
  title: 'Unguarded invite.token read',
  body:
    'invite.token is indexed off the createInvite response with no guard, so a response that is null or undefined ' +
    'throws a TypeError instead of surfacing an error to the caller.',
};

const GUARD_GPT = {
  title: 'Object inputs are dereferenced unguarded',
  body:
    'The handler dereferences `api`, `tenant`, and the `createInvite` result without guards; handleCopyLink throws ' +
    'a TypeError when tenant is undefined.',
};

function finding(
  modelId: string,
  line: number,
  f: { title: string; body: string },
  severity: AttributedFinding['severity'] = 'P1',
): AttributedFinding {
  return {
    path: 'src/invite.js',
    line,
    end_line: null,
    severity,
    title: f.title,
    body: f.body,
    category: 'correctness',
    confidence: 0.8,
    convention: null,
    modelId,
    modelLabel: modelId,
    anchoredLine: line,
    anchor: 'exact',
    anchorDrift: 0,
  };
}

const OPTS = { lineWindow: 8, mergeThreshold: 0.55, distinctThreshold: 0.3 };
const text = (f: { title: string; body: string }) => `${f.title} ${f.body}`;

describe('similarity on real multi-model findings', () => {
  it('scores the same defect far above unrelated defects', () => {
    const same = [
      similarity(text(CLIPBOARD_OPUS), text(CLIPBOARD_DEEPSEEK)),
      similarity(text(CLIPBOARD_OPUS), text(CLIPBOARD_GPT)),
      similarity(text(CLIPBOARD_DEEPSEEK), text(CLIPBOARD_GPT)),
    ];
    const different = [
      similarity(text(CLIPBOARD_OPUS), text(GUARD_OPUS)),
      similarity(text(CLIPBOARD_DEEPSEEK), text(GUARD_GPT)),
      similarity(text(CLIPBOARD_GPT), text(GUARD_GPT)),
    ];

    // The separation is the whole point: every same-defect pair must outrank every
    // unrelated pair, with room to spare.
    expect(Math.min(...same)).toBeGreaterThan(Math.max(...different) + 0.2);
  });

  it('keeps every same-defect pair above the referee floor', () => {
    // Below distinctThreshold they are declared distinct and never reach the referee,
    // which is exactly how the unanimous bug got split three ways.
    for (const s of [
      similarity(text(CLIPBOARD_OPUS), text(CLIPBOARD_DEEPSEEK)),
      similarity(text(CLIPBOARD_OPUS), text(CLIPBOARD_GPT)),
      similarity(text(CLIPBOARD_DEEPSEEK), text(CLIPBOARD_GPT)),
    ]) {
      expect(s).toBeGreaterThan(OPTS.distinctThreshold);
    }
  });

  it('beats prose-only Jaccard, which cannot separate these at all', () => {
    // Documents *why* the blend exists: on this data prose alone puts a same-defect pair
    // below the distinct threshold, so no amount of threshold tuning would fix it.
    expect(jaccard(text(CLIPBOARD_OPUS), text(CLIPBOARD_GPT))).toBeLessThan(
      OPTS.distinctThreshold,
    );
    expect(similarity(text(CLIPBOARD_OPUS), text(CLIPBOARD_GPT))).toBeGreaterThan(
      OPTS.distinctThreshold,
    );
  });
});

describe('clusterFindings on the real fan-out', () => {
  const findings = [
    finding('opus', 8, CLIPBOARD_OPUS),
    finding('opus', 8, GUARD_OPUS, 'P2'),
    finding('deepseek', 8, CLIPBOARD_DEEPSEEK, 'P2'),
    finding('gpt', 8, CLIPBOARD_GPT),
    finding('gpt', 6, GUARD_GPT, 'P2'),
  ];

  it('merges at least two models on the clipboard defect for free', () => {
    const { clusters } = clusterFindings(findings, OPTS);
    const clipboard = clusters.filter((c) => /clipboard/i.test(c.title));
    expect(Math.max(...clipboard.map((c) => c.agreement))).toBeGreaterThanOrEqual(2);
  });

  it('routes the remaining clipboard pairs to the referee rather than calling them distinct', () => {
    const { clusters, ambiguousPairs } = clusterFindings(findings, OPTS);
    const clipboardClusters = clusters.filter((c) => /clipboard/i.test(c.title));

    // Either everything merged for free, or whatever did not is queued for the referee.
    if (clipboardClusters.length > 1) {
      const queued = ambiguousPairs.filter(
        (p) => /clipboard/i.test(p.a.title) && /clipboard/i.test(p.b.title),
      );
      expect(queued.length).toBeGreaterThan(0);
    }
  });

  it('never merges the clipboard defect with the unguarded-dereference defect', () => {
    const { clusters } = clusterFindings(findings, OPTS);
    for (const c of clusters) {
      const titles = c.members.map((m) => m.title).join(' | ');
      const hasClipboard = /clipboard/i.test(titles);
      const hasGuard = /unguarded|dereferenced/i.test(titles);
      expect(hasClipboard && hasGuard).toBe(false);
    }
  });

  it('does not let one model reporting twice inflate agreement', () => {
    const twice = [
      finding('opus', 8, CLIPBOARD_OPUS),
      finding('opus', 8, CLIPBOARD_DEEPSEEK),
      finding('opus', 8, CLIPBOARD_GPT),
    ];
    const { clusters } = clusterFindings(twice, OPTS);
    for (const c of clusters) expect(c.agreement).toBe(1);
  });
});
