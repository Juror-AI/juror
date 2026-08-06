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

describe('length-asymmetric agreement (textcortex/platform#10333)', () => {
  // Also verbatim. GPT-5.6 Sol and DeepSeek V4 Flash both found this defect on the same
  // line of the same file; DeepSeek wrote about three times as much prose about it. Jaccard
  // divides by the union, so the longer finding's extra vocabulary dragged the pair to
  // 0.26 — under the referee floor — and the ensemble published one agreed defect twice,
  // once as P1 and once as P2. Containment fixed it; this pins that it stays fixed.
  const GPT = {
    title: 'Supersession bypasses terminal cleanup',
    body:
      'When a throttled write sees a new task token, this sets `lost_task_ownership`; ' +
      '`_finalize_stream_result` checks that flag before its superseded branch and returns as ' +
      'skipped. The old automation run is therefore never cancelled and any pending ' +
      'completion-email subscription for that run stays pending; represent supersession ' +
      'separately, or handle it before owner loss, so writes remain fenced while the existing ' +
      'superseded cleanup still runs.',
  };

  const DEEPSEEK = {
    title: 'Superseded fence drops terminal end event',
    body:
      'When the fence fires on token supersession it sets ctx.lost_task_ownership=True, so ' +
      "_finalize_stream_result exits at line 5196 before the superseded branch (line 5208) that " +
      "appends the end event (reason='superseded') and calls " +
      "_sync_automation_run_terminal_status('cancelled'). Because the fence re-checks only every " +
      '1.5s, any supersession detected on a stream longer than that suppresses that terminal ' +
      'marker and the automation sync that the retained code still attempts, whereas pre-PR a ' +
      "token-superseded zombie (token mismatch is _still_owns_task_run's 'not my concern' path) " +
      'always produced it.',
  };

  const UNRELATED = {
    title: 'Fallback events bypass ownership fence',
    body:
      'The fallback path appends its events through a different helper that never consults the ' +
      'fence, so a worker that has already lost the lease can still emit fallback content.',
  };

  it('merges the pair for free despite one finding being 3x longer', () => {
    expect(similarity(text(GPT), text(DEEPSEEK))).toBeGreaterThan(OPTS.mergeThreshold);
  });

  it('still separates it from an unrelated finding in the same file', () => {
    expect(similarity(text(GPT), text(UNRELATED))).toBeLessThan(OPTS.mergeThreshold);
  });

  it('collapses to a single P1 cluster with both models on it', () => {
    const { clusters } = clusterFindings(
      [
        finding('gpt', 1351, GPT, 'P1'),
        finding('deepseek', 1351, DEEPSEEK, 'P2'),
        finding('gpt', 1384, UNRELATED, 'P2'),
      ],
      OPTS,
    );
    const merged = clusters.find((c) => c.line === 1351);
    expect(merged?.agreement).toBe(2);
    // The most severe member sets the cluster severity — a P1 must not be softened to P2.
    expect(merged?.severity).toBe('P1');
    expect(clusters).toHaveLength(2);
  });
});

describe('title-preserved agreement (textcortex/platform#10356)', () => {
  // Verbatim Sonnet and DeepSeek output from the posted two-model E2E. Both describe the
  // same unconditional `chunks_emitted=True` flag, but one focuses on the observable and
  // the other on the empty-first-event path. The combined score was 0.291 — just below the
  // 0.30 referee floor — while the titles scored 0.755, so Juror printed the bug twice.
  const SONNET = {
    title: 'chunks_emitted hardcoded True for SSE error events',
    body:
      '`_raise_for_sse_error_event` always constructs `ModelStreamInterruptedError(..., chunks_emitted=True)`, ' +
      'even when the `event: error` block is the very first chunk received (no prior visible/reasoning bytes). ' +
      'This value is surfaced verbatim in error-webhook/task-error-payload observability ' +
      '(`core/services/error_webhook.py`, `core/services/conversation/task_error_payload.py`), so on-call ' +
      "engineers could see a misleading 'Chunks Emitted: true' for a failure that actually happened before any " +
      'stream content arrived.',
  };

  const DEEPSEEK = {
    title: 'chunks_emitted set unconditionally on error event',
    body:
      'ModelStreamInterruptedError(chunks_emitted=True) is raised whenever the SSE error-event payload is ' +
      "unparseable or not recognizable as a provider error, even in the case where the error event arrives " +
      "before a single streamed byte (e.g. an immediate 'event: error' with empty data). The flag feeds " +
      "task_error_payload/error_webhook, so ops reports can claim 'Chunks Emitted: true' for a failure that " +
      'emitted nothing; derive it from whether chunks were actually yielded this attempt.',
  };

  it('routes the duplicate reports to the referee instead of declaring them distinct', () => {
    const sonnet = {
      ...finding('sonnet', 382, SONNET, 'P3'),
      path: 'backend/core/generation/openai_reasoning.py',
    };
    const deepseek = {
      ...finding('deepseek', 387, DEEPSEEK, 'P3'),
      path: 'backend/core/generation/openai_reasoning.py',
    };

    expect(similarity(text(SONNET), text(DEEPSEEK))).toBeLessThan(OPTS.distinctThreshold);
    expect(similarity(SONNET.title, DEEPSEEK.title)).toBeGreaterThan(OPTS.mergeThreshold);

    const { clusters, ambiguousPairs } = clusterFindings([sonnet, deepseek], OPTS);
    expect(clusters).toHaveLength(2);
    expect(ambiguousPairs).toHaveLength(1);
    expect(ambiguousPairs[0]?.jaccard).toBe(OPTS.mergeThreshold);
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
