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
    sourceId: `${modelId}:${line}:${f.title}`,
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

  it('routes the semantic duplicate to the referee without weakening severity', () => {
    const { clusters, ambiguousPairs } = clusterFindings(
      [
        finding('gpt', 1351, GPT, 'P1'),
        finding('deepseek', 1351, DEEPSEEK, 'P2'),
        finding('gpt', 1384, UNRELATED, 'P2'),
      ],
      OPTS,
    );
    const candidates = clusters.filter((c) => c.line === 1351);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.severity).sort()).toEqual(['P1', 'P2']);
    expect(ambiguousPairs.some((p) => p.a.line === 1351 && p.b.line === 1351)).toBe(true);
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
    expect(ambiguousPairs[0]?.similarity).toBe(OPTS.mergeThreshold);
  });
});

describe('atomic async contracts (textcortex/platform#10359)', () => {
  const promiseClaim = {
    trigger: 'Behavior autosave or navigation calls pending.run()',
    mechanism: 'stableSubmit invokes onSubmitRef.current() with void and returns no promise',
    consequence: 'the caller proceeds and its catch cannot observe a rejected save',
    fix: 'return the onSubmit promise from stableSubmit and its public submit contract',
  };
  const retryClaim = {
    trigger: 'an Appearance or Access autosave request rejects',
    mechanism: 'isPending returning false makes canSave true and re-arms the autosave effect',
    consequence: 'the editor retries forever and emits repeated destructive toasts',
    fix: 'require a new edit or explicit retry before scheduling another save',
  };
  const normalizationClaim = {
    trigger: 'Appearance input contains whitespace or empty suggestions that are normalized on save',
    mechanism: 'the server seed changes but the local draft keeps the pre-normalized value',
    consequence: 'isDirty never clears and autosave sends the same successful PATCH forever',
    fix: 'reconcile the local draft with the normalized saved value',
  };

  it('deduplicates promise reports but preserves different retry and normalization triggers', () => {
    const promiseA = {
      ...finding(
        'kimi',
        287,
        {
          title: 'Behavior save promise is discarded',
          body:
            'stableSubmit uses void onSubmitRef.current(), so awaiting pending.run() completes immediately and rejected saves bypass the catch; return the promise.',
        },
      ),
      path: 'apps/web/src/features/AgentApp/editor/AgentAppEditorPage.tsx',
      claim: promiseClaim,
    };
    const promiseB = {
      ...finding(
        'grok',
        288,
        {
          title: 'Await cannot observe Behavior failure',
          body:
            'The embedded submit wrapper returns void instead of the builder request, allowing navigation before persistence and hiding rejections; preserve the promise.',
        },
      ),
      path: promiseA.path,
      claim: promiseClaim,
    };
    const retry = {
      ...finding(
        'kimi',
        292,
        {
          title: 'Failed autosave retries forever',
          body:
            'When updateApp.isPending falls back to false, canSave becomes true and schedules another timer, producing an unbounded PATCH and toast loop; wait for a new edit.',
        },
      ),
      path: promiseA.path,
      claim: retryClaim,
    };
    const normalization = {
      ...finding(
        'deepseek',
        287,
        {
          title: 'Normalized values loop autosave forever',
          body:
            'Appearance persists trimmed values but retains the untrimmed local draft, so isDirty remains true after success and repeats the PATCH; reconcile local state.',
        },
      ),
      path: promiseA.path,
      claim: normalizationClaim,
    };

    const { clusters } = clusterFindings([promiseA, retry, normalization, promiseB], OPTS);
    const promise = clusters.find((cluster) => /promise|await/i.test(cluster.title));
    const retryCluster = clusters.find((cluster) => /retries/i.test(cluster.title));

    const normalizationCluster = clusters.find((cluster) => /normalized/i.test(cluster.title));

    expect(clusters).toHaveLength(3);
    expect(promise?.agreement).toBe(2);
    expect(promise?.members).toHaveLength(2);
    expect(retryCluster?.agreement).toBe(1);
    expect(retryCluster?.members).toHaveLength(1);
    expect(normalizationCluster?.agreement).toBe(1);
    expect(normalizationCluster?.members).toHaveLength(1);
  });

  it('routes the same failure when models anchor the effect and catch 13 lines apart', () => {
    const effect = {
      ...finding(
        'deepseek',
        274,
        {
          title: 'Failed autosave re-arms itself into an unbounded retry loop',
          body:
            "The effect's deps are `[pendingIsDirty, pendingCanSave]`, and the tabs derive `canSave` from `isDirty && !isSaving` (AppearanceTab/AccessTab). When an autosave `run()` is in flight, `updateApp.isPending` makes `canSave` drop to false and then back to true after the promise settles, so the effect re-runs (deps [true,false]→[true,true]) and re-arms the 1200ms timer even though the user made no new edit. On a persistent failure the still-dirty descriptor passes the fire-time re-check again, so each cycle issues a new PATCH and a new destructive 'Could not update published agent' toast (~every 1.2s + RTT) until the user navigates away.",
        },
      ),
      path: 'apps/web/src/features/AgentApp/editor/AgentAppEditorPage.tsx',
      claim: {
        trigger:
          "An autosave PATCH rejects with a persistent error (e.g. 5xx or the mapped 'default_model is required' 4xx) while the user stays on the step.",
        mechanism:
          "run() failure makes updateApp.isPending toggle, which flips the tab's canSave false→true and re-runs this effect via its [pendingIsDirty, pendingCanSave] deps, re-arming the debounce; the fire-time re-check sees the still-dirty descriptor and calls run() again.",
        consequence:
          'Unbounded automatic retry of the failing PATCH with a destructive toast on every cycle until the user leaves the step.',
        fix:
          'Add an explicit last-attempt guard/backoff (e.g. a ref marking the failed attempt plus a retry cap) so a failed autosave does not immediately reschedule itself, mirroring the intended user-initiated retry.',
      },
    };
    const caught = {
      ...finding(
        'kimi',
        287,
        {
          title: 'Failed autosave retries forever with unbounded error toasts',
          body:
            "When run() rejects, the catch toasts and leaves the step dirty; settling the mutation flips updateApp.isPending (or the builder's isSubmitting) back, so the tab re-registers canSave=true, the effect's [pendingIsDirty, pendingCanSave] deps change, and a fresh 1200ms timer is armed. A persistent failure (offline, 422 validation rejection) therefore re-fires the save every ~1.2s+RTT for as long as the editor stays open, queuing an endless stream of destructive toasts and PATCH requests. The comment says 'leave the edits dirty so the user can retry', but the retry is automatic and unbounded. Fix: after a failed run, do not re-arm the autosave until a new edit arrives (e.g. remember the failed descriptor in a ref and skip scheduling), or add capped/backed-off retries.",
        },
      ),
      path: effect.path,
      claim: {
        trigger:
          'Any persistent save failure while a step is dirty, e.g. the backend 422s the payload or the network is down',
        mechanism:
          "catch leaves isDirty true; the mutation's pending-state toggle re-registers the descriptor with canSave true, which re-runs the autosave effect and arms a new timer",
        consequence:
          'Unbounded loop of failing PATCH requests and destructive error toasts until the user leaves the editor',
        fix:
          'Suppress re-arming after a failed attempt (require a new edit/descriptor before scheduling again) or cap retries with backoff',
      },
    };

    const { clusters, ambiguousPairs } = clusterFindings([effect, caught], OPTS);
    expect(clusters).toHaveLength(2);
    expect(ambiguousPairs).toHaveLength(1);
    expect(ambiguousPairs[0]?.similarity).toBeGreaterThan(0.45);
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

  it('keeps semantic clipboard duplicates separate until the referee decides', () => {
    const { clusters, ambiguousPairs } = clusterFindings(findings, OPTS);
    const clipboard = clusters.filter((c) => /clipboard/i.test(c.title));
    expect(clipboard.every((c) => c.agreement === 1)).toBe(true);
    expect(
      ambiguousPairs.some((p) => /clipboard/i.test(p.a.title) && /clipboard/i.test(p.b.title)),
    ).toBe(true);
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
