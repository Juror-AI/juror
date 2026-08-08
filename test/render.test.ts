/**
 * The rendered comment is the product surface, so the guards here are the ones that
 * protect it from the two things that can silently break it: model-authored text
 * (which can forge our sticky marker, split a table, or echo back a key it found in
 * the repo) and arithmetic that prints a number nobody can defend.
 */

import { describe, expect, it } from 'vitest';

import { formatDuration, formatTokens, formatUsd, renderReceipt } from '../src/render/receipt.js';
import {
  dots,
  renderSummaryComment,
  STICKY_MARKER,
  synthesizeSummary,
} from '../src/render/summary.js';
import { renderInlineComment, selectInlineComments } from '../src/render/inline.js';
import {
  renderFailedComment,
  renderWorkingComment,
  WORKING_SPINNER_HTML,
} from '../src/render/status.js';
import { renderTerminalReport } from '../src/render/terminal.js';
import type {
  Cluster,
  CostTotals,
  DiffContext,
  DiffFile,
  JurorConfig,
  ModelReport,
  ModelRun,
  ReviewResult,
} from '../src/types.js';

// A shape-matching key. The prefix is assembled rather than written out, because the CI
// secret scan greps the tree and cannot tell a fixture from a real leak.
const FAKE_KEY = `sk-${'ant'}-api03-${'AbCd0123_-'.repeat(4)}`;

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function config(over: Partial<JurorConfig['output']> = {}, review: Partial<JurorConfig['review']> = {}): JurorConfig {
  return {
    version: 1,
    preset: null,
    models: [],
    consensus: {
      min_agreement: 'majority',
      verify_solo_findings: true,
      verify_model: null,
      referee_model: null,
      jaccard_merge_threshold: 0.55,
      jaccard_distinct_threshold: 0.3,
      line_window: 8,
    },
    review: {
      publish_mode: 'all',
      severity_floor: 'P2',
      max_inline_comments: 15,
      paths_ignore: [],
      anchor_tolerance: 3,
      max_diff_bytes: 400_000,
      per_model_timeout_seconds: 600,
      max_turns: 30,
      ...review,
    },
    budget: { target_cost_usd_per_pr: 2, on_exceed: 'partial' },
    output: { sequence_diagram: true, cost_receipt: true, suppressed_findings: 'collapsed', ...over },
  };
}

function cluster(over: Partial<Cluster> = {}): Cluster {
  return {
    id: 'c1',
    path: 'src/a.ts',
    line: 12,
    endLine: null,
    severity: 'P1',
    category: 'correctness',
    title: 'Clipboard write loses transient activation',
    body: 'Awaiting two requests before the write makes Safari reject it.',
    convention: null,
    modelIds: ['m1'],
    modelLabels: ['Opus 5'],
    agreement: 1,
    members: [],
    anchor: 'exact',
    maxConfidence: 0.9,
    mergedBy: ['singleton'],
    verification: null,
    published: true,
    suppressedReason: null,
    ...over,
  };
}

function diffFile(path: string, lines: number[]): DiffFile {
  const positionByLine = new Map<number, number>();
  lines.forEach((l, i) => positionByLine.set(l, i + 1));
  return {
    path,
    previousPath: null,
    status: 'modified',
    additions: lines.length,
    deletions: 0,
    hunks: [],
    changedLines: [...lines],
    positionByLine,
    ignored: false,
  };
}

function diff(files: DiffFile[] = [diffFile('src/a.ts', [10, 12, 14])]): DiffContext {
  return {
    patch: '',
    files,
    baseSha: 'b'.repeat(40),
    headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    sinceSha: null,
    totalAdditions: 40,
    totalDeletions: 3,
    ignoredPaths: [],
    truncated: false,
  };
}

function report(over: Partial<ModelReport> = {}): ModelReport {
  return {
    merge_confidence: 3,
    confidence_reason: 'One reachable defect should be fixed first.',
    summary: 'Adds tenant-aware invite URLs.',
    highlights: ['Adds a Copy link mutation.'],
    file_overviews: [{ path: 'src/a.ts', overview: 'Adds the copy-link workflow.' }],
    async_contracts: [],
    sequence_diagram: null,
    findings: [],
    ...over,
  };
}

function run(over: Partial<ModelRun> = {}, rep: ModelReport | null = report()): ModelRun {
  return {
    modelId: 'claude-opus-5',
    modelLabel: 'Opus 5',
    harness: 'claude-code',
    harnessLabel: 'Claude Code',
    pricingKey: 'claude-opus-5',
    ok: true,
    skipped: false,
    skipReason: null,
    result: rep
      ? {
          report: rep,
          usage: { uncachedIn: 41_200, cacheRead: 38_000, cacheWrite: 0, out: 6_100 },
          reportedCostUsd: 0.18,
          turns: 6,
          truncated: false,
          rawText: '',
          diagnostics: [],
        }
      : null,
    cost: { usd: 0.18, source: 'reported', longContext: false },
    durationMs: 60_000,
    error: null,
    ...over,
  };
}

function totals(over: Partial<CostTotals> = {}): CostTotals {
  return {
    rows: [
      {
        label: 'Opus 5',
        harnessLabel: 'Claude Code',
        usage: { uncachedIn: 41_200, cacheRead: 38_000, cacheWrite: 0, out: 6_100 },
        cost: { usd: 0.18, source: 'reported', longContext: false },
      },
    ],
    usage: { uncachedIn: 41_200, cacheRead: 38_000, cacheWrite: 0, out: 6_100 },
    usd: 0.18,
    partial: false,
    modelsRun: 4,
    ...over,
  };
}

function result(over: Partial<ReviewResult> = {}): ReviewResult {
  const published = over.published ?? [cluster()];
  return {
    diff: diff(),
    runs: [run()],
    clusters: published,
    published,
    suppressed: [],
    coverage: {
      complete: true,
      rawFindings: published.reduce((sum, item) => sum + item.members.length, 0),
      accountedFor: published.reduce((sum, item) => sum + item.members.length, 0),
      uniqueFindings: published.length,
      dispositions: [],
      problems: [],
    },
    verdict: {
      base: 3,
      penalty: 1,
      score: 3,
      votes: [
        { modelLabel: 'Opus 5', vote: 3 },
        { modelLabel: 'GPT-5.6 Sol', vote: 2 },
      ],
      confirmed: { P0: 0, P1: 1, P2: 0, P3: 0 },
    },
    summary: {
      summary: 'Adds tenant-aware invite URLs.',
      highlights: ['Adds a Copy link mutation.'],
      fileOverviews: [{ path: 'src/a.ts', overview: 'Adds the copy-link workflow.' }],
      sequenceDiagram: null,
      confidenceReason: 'Fix the clipboard write before merging.',
    },
    totals: totals(),
    durationMs: 134_000,
    warnings: [],
    ...over,
  };
}

const opts = { version: '0.4.1', headSha: 'a1b2c3d4e5f6', config: config() };

// ─────────────────────────────────────────────────────────────────────────────
// Live status comment
// ─────────────────────────────────────────────────────────────────────────────

describe('live status comment', () => {
  const status = {
    repo: 'textcortex/platform',
    prNumber: 10356,
    headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    version: '0.4.1',
  };

  it('renders the animated working state with models and full target links', () => {
    const md = renderWorkingComment({
      ...status,
      modelLabels: ['DeepSeek V4 Flash', 'Sonnet `5`'],
      jobUrl: 'https://github.com/textcortex/platform/actions/runs/42',
    });

    expect(md.split(STICKY_MARKER)).toHaveLength(2);
    expect(md).toContain(`### Juror is reviewing… ${WORKING_SPINNER_HTML}`);
    expect(md).toContain('2 independent jurors are reading');
    expect(md).toContain('`DeepSeek V4 Flash` · `Sonnet \\`5\\``');
    expect(md).toContain('[PR #10356](https://github.com/textcortex/platform/pull/10356)');
    expect(md).toContain('[`a1b2c3d`](https://github.com/textcortex/platform/commit/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678)');
    expect(md).toContain('[view run](https://github.com/textcortex/platform/actions/runs/42)');
  });

  it('omits unsafe run links and redacts failure details', () => {
    const working = renderWorkingComment({
      ...status,
      modelLabels: [],
      jobUrl: 'javascript:alert(1)',
    });
    expect(working).not.toContain('javascript:');

    const failed = renderFailedComment({
      ...status,
      reason: `provider echoed ${FAKE_KEY}`,
      jobUrl: null,
    });
    expect(failed).toContain('### Juror review stopped');
    expect(failed).not.toContain(WORKING_SPINNER_HTML);
    expect(failed).not.toContain(FAKE_KEY);
    expect(failed).toContain('[redacted]');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary comment
// ─────────────────────────────────────────────────────────────────────────────

describe('renderSummaryComment', () => {
  it('carries the sticky marker exactly once, even when a model forges one', () => {
    const r = result();
    r.summary.summary = `Innocent prose ${STICKY_MARKER} and more.`;
    const md = renderSummaryComment(r, opts);

    expect(md.split(STICKY_MARKER)).toHaveLength(2); // one marker ⇒ two fragments
    expect(md.startsWith(STICKY_MARKER)).toBe(true);
    expect(md).toContain('&lt;!-- juror:summary:v1 -->');
  });

  it('bolds P0 and P1 severities in the findings table but not P2', () => {
    const md = renderSummaryComment(
      result({ published: [cluster({ severity: 'P0' }), cluster({ id: 'c2', severity: 'P2', line: 14 })] }),
      opts,
    );
    expect(md).toContain('| 1 | **P0** |');
    expect(md).toContain('| 2 | P2 |');
  });

  it('renders agreement dots as filled-then-empty against the models that ran', () => {
    expect(dots(2, 4)).toBe('●●○○');
    expect(dots(3, 4)).toBe('●●●○');
    expect(dots(4, 4)).toBe('●●●●');

    const r = result({ published: [cluster({ agreement: 2, modelLabels: ['Opus 5', 'Grok 4.5'] })] });
    r.totals = totals({ modelsRun: 4 });
    expect(renderSummaryComment(r, opts)).toContain('`●●○○` 2/4');
  });

  it('keeps complete finding bodies in the sticky summary when inline delivery fails', () => {
    const md = renderSummaryComment(
      result({ published: [cluster({ body: 'The complete failure mechanism and remediation.' })] }),
      opts,
    );
    expect(md).toContain('<details><summary>Finding details</summary>');
    expect(md).toContain('The complete failure mechanism and remediation.');
  });

  it('shows the lossless raw-finding coverage audit', () => {
    const r = result({
      coverage: {
        complete: true,
        rawFindings: 6,
        accountedFor: 6,
        uniqueFindings: 5,
        dispositions: [],
        problems: [],
      },
    });
    const md = renderSummaryComment(r, opts);
    const terminal = renderTerminalReport(r, { version: '0.4.1' });

    expect(md).toContain('Coverage audit: 6/6 raw model findings accounted for → 5 unique findings; none dropped.');
    expect(terminal).toContain('6/6 raw → 5 unique');
  });

  it('makes an incomplete coverage audit prominent', () => {
    const md = renderSummaryComment(
      result({
        coverage: {
          complete: false,
          rawFindings: 6,
          accountedFor: 5,
          uniqueFindings: 4,
          dispositions: [],
          problems: ['raw finding kimi:2 is missing'],
        },
      }),
      opts,
    );
    expect(md).toContain('⚠ Coverage audit incomplete');
    expect(md).toContain('5/6 raw model findings accounted for');
  });

  it('redacts a provider key a model echoed back into its prose', () => {
    const r = result();
    r.summary.summary = `The fixture hardcodes ${FAKE_KEY} at the top.`;
    const md = renderSummaryComment(r, opts);

    expect(md).not.toContain(FAKE_KEY);
    expect(md).toContain('[redacted]');
  });

  it('cannot have its findings table split by a pipe in a model-written title', () => {
    const md = renderSummaryComment(
      result({ published: [cluster({ title: 'Bad guard | drops rows | silently' })] }),
      opts,
    );
    const row = md.split('\n').find((l) => l.startsWith('| 1 |'));
    expect(row).toBeDefined();
    expect(row).toContain('Bad guard \\| drops rows \\| silently');
    // Five columns ⇒ six cell delimiters; the escaped pipes must not add any.
    expect((row ?? '').match(/(?<!\\)\|/g)).toHaveLength(6);
  });

  it('does not let an unbalanced fence in model prose swallow the comment', () => {
    const r = result();
    r.summary.summary = 'Adds a helper:\n```ts\nconst x = 1;';
    const md = renderSummaryComment(r, opts);
    expect(md).not.toContain('```ts');
    expect(md).toContain('### Findings');
  });

  it('honors the suppressed-findings mode', () => {
    const suppressed = [cluster({ published: false, suppressedReason: 'below severity floor', severity: 'P3' })];
    const collapsed = renderSummaryComment(result({ suppressed }), { ...opts, config: config() });
    expect(collapsed).toContain('<details><summary>1 finding suppressed — below severity floor</summary>');

    const hidden = renderSummaryComment(result({ suppressed }), {
      ...opts,
      config: config({ suppressed_findings: 'hidden' }),
    });
    expect(hidden).not.toContain('suppressed');

    const inline = renderSummaryComment(result({ suppressed }), {
      ...opts,
      config: config({ suppressed_findings: 'inline' }),
    });
    expect(inline).toContain('**1 finding suppressed');
    expect(inline).not.toContain('<details><summary>1 finding');
  });

  it('fences the sequence diagram only when configured, and neuters a nested fence', () => {
    const r = result();
    r.summary.sequenceDiagram = 'sequenceDiagram\n  A->>B: go\n```\nnot markdown anymore';
    expect(renderSummaryComment(r, opts)).toContain('```mermaid\nsequenceDiagram');
    expect(renderSummaryComment(r, opts).match(/```/g)).toHaveLength(2);

    const off = renderSummaryComment(r, { ...opts, config: config({ sequence_diagram: false }) });
    expect(off).not.toContain('```mermaid');
  });

  it('shows the vote arithmetic and the version footer', () => {
    const md = renderSummaryComment(result(), opts);
    expect(md).toContain('<sub>Model votes: Opus 5 `3` · GPT-5.6 Sol `2` → median **3**, capped at **4** by 1 confirmed P1.</sub>');
    expect(md).toContain('### Merge Confidence: 3/5');
    expect(md).toContain('Juror v0.4.1 · reviewed `a1b2c3d`');
    expect(md).not.toContain('@juror ignore');
  });

  it('makes truncated diff coverage visible and never calls it complete', () => {
    const truncated = diff();
    truncated.truncated = true;
    const md = renderSummaryComment(result({ diff: truncated }), opts);

    expect(md).toContain('Review coverage incomplete');
    expect(md).toContain('diff was truncated');
    expect(md).not.toContain('none dropped');
  });

  it('names skipped models even when the receipt is switched off', () => {
    const r = result({
      runs: [run({ modelLabel: 'Grok 4.5', skipped: true, skipReason: 'XAI_API_KEY is not set', result: null })],
    });
    const withReceipt = renderSummaryComment(r, opts);
    expect(withReceipt).toContain('Skipped: `Grok 4.5` (XAI_API_KEY is not set)');

    const withoutReceipt = renderSummaryComment(r, { ...opts, config: config({ cost_receipt: false }) });
    expect(withoutReceipt).toContain('Skipped: `Grok 4.5` (XAI_API_KEY is not set)');
  });

  it('labels an interrupted run whose early report was retained as partial', () => {
    const partial = run({ modelLabel: 'Kimi K3' });
    if (partial.result) {
      partial.result.truncated = true;
      partial.result.diagnostics = ['loop.max_steps_exceeded'];
    }
    const r = result({ runs: [partial] });

    const withReceipt = renderSummaryComment(r, opts);
    expect(withReceipt).toContain('Partial: `Kimi K3` (loop.max_steps_exceeded)');

    const withoutReceipt = renderSummaryComment(r, { ...opts, config: config({ cost_receipt: false }) });
    expect(withoutReceipt).toContain('Partial: `Kimi K3` (loop.max_steps_exceeded)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary synthesis
// ─────────────────────────────────────────────────────────────────────────────

describe('synthesizeSummary', () => {
  it('takes the prose from the median voter and unions the rest', () => {
    const runs = [
      run({ modelLabel: 'A' }, report({ merge_confidence: 5, summary: 'five', highlights: ['H one'] })),
      run({ modelLabel: 'B' }, report({ merge_confidence: 1, summary: 'one', highlights: ['h one!'] })),
      run(
        { modelLabel: 'C' },
        report({
          merge_confidence: 3,
          summary: 'three',
          confidence_reason: 'because three',
          highlights: ['H three'],
          file_overviews: [{ path: 'src/a.ts', overview: 'a much longer overview of the same file' }],
          sequence_diagram: 'sequenceDiagram\n  A->>B: x',
        }),
      ),
    ];

    const s = synthesizeSummary(runs, diff());
    expect(s.summary).toBe('three');
    expect(s.confidenceReason).toBe('because three');
    expect(s.highlights).toEqual(['H three', 'H one']); // "h one!" is the same highlight
    expect(s.fileOverviews).toEqual([
      { path: 'src/a.ts', overview: 'a much longer overview of the same file' },
    ]);
    expect(s.sequenceDiagram).toBe('sequenceDiagram\n  A->>B: x');
  });

  it('caps highlights at three', () => {
    const runs = [
      run({}, report({ highlights: ['a', 'b'] })),
      run({}, report({ highlights: ['c', 'd', 'e'] })),
    ];
    expect(synthesizeSummary(runs, diff()).highlights).toEqual(['a', 'b', 'c']);
  });

  it('uses complete-juror prose instead of an interrupted early placeholder', () => {
    const partial = run(
      { modelLabel: 'Kimi K3' },
      report({
        merge_confidence: 3,
        summary: 'partial summary',
        confidence_reason: 'Review in progress; initial placeholder.',
        highlights: ['partial highlight'],
      }),
    );
    if (partial.result) partial.result.truncated = true;
    const complete = run(
      { modelLabel: 'DeepSeek V4 Flash' },
      report({
        merge_confidence: 4,
        summary: 'complete summary',
        confidence_reason: 'One concrete convention violation remains.',
        highlights: ['complete highlight'],
      }),
    );

    const s = synthesizeSummary([partial, complete], diff());
    expect(s.summary).toBe('complete summary');
    expect(s.confidenceReason).toBe('One concrete convention violation remains.');
    expect(s.highlights).toEqual(['complete highlight']);
  });

  it('degrades to a stated non-review when no model reported', () => {
    const s = synthesizeSummary([run({ ok: false, error: 'timeout' }, null)], diff());
    expect(s.summary).toContain('No model returned a usable report');
    expect(s.highlights).toEqual([]);
    expect(s.sequenceDiagram).toBeNull();
    expect(() => renderSummaryComment(result({ summary: s }), opts)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Inline comments
// ─────────────────────────────────────────────────────────────────────────────

describe('renderInlineComment', () => {
  it('pins the badge to the running version and states the agreement', () => {
    const body = renderInlineComment(
      cluster({
        severity: 'P1',
        agreement: 3,
        modelLabels: ['Opus 5', 'GPT-5.6 Sol', 'Kimi K3'],
        verification: { refuted: false, reason: 'held', byModel: 'grok-4.5', cost: { usd: 0, source: 'reported', longContext: false } },
        convention: 'apps/AGENTS.md',
      }),
      { version: '0.4.1', modelsRun: 4 },
    );

    expect(body).toContain(
      '<img alt="P1" src="https://raw.githubusercontent.com/juror-ai/juror/v0.4.1/assets/badges/p1.svg" align="top">',
    );
    expect(body).toContain('**Clipboard write loses transient activation**');
    expect(body).toContain('`●●●○` **3/4 models** — Opus 5, GPT-5.6 Sol, Kimi K3 · verified · convention: `apps/AGENTS.md`');
  });

  it('omits "verified" when the verifier refuted the finding', () => {
    const body = renderInlineComment(
      cluster({
        verification: { refuted: true, reason: 'guarded above', byModel: 'grok-4.5', cost: { usd: 0, source: 'reported', longContext: false } },
      }),
      { version: '0.4.1' },
    );
    expect(body).not.toContain('· verified');
  });

  it('keeps a fenced fix suggestion but closes an unbalanced fence', () => {
    const body = renderInlineComment(cluster({ body: 'Do this:\n```ts\nawait x();' }), {
      version: '1.0.0',
    });
    expect(body).toContain('```ts\nawait x();');
    expect(body.match(/```/g)).toHaveLength(2);
  });

  it('redacts a key a model quoted into the finding body', () => {
    const body = renderInlineComment(cluster({ body: `The default is ${FAKE_KEY}.` }), { version: '1.0.0' });
    expect(body).not.toContain(FAKE_KEY);
    expect(body).toContain('[redacted]');
  });
});

describe('selectInlineComments', () => {
  it('sorts by severity then agreement, and caps the rest into overflow', () => {
    const published = [
      cluster({ id: 'p2', severity: 'P2', line: 10 }),
      cluster({ id: 'p1-solo', severity: 'P1', line: 12, agreement: 1 }),
      cluster({ id: 'p1-pair', severity: 'P1', line: 14, agreement: 2 }),
    ];
    const all = selectInlineComments(published, config(), diff());
    expect(all.comments.map((c) => c.cluster.id)).toEqual(['p1-pair', 'p1-solo', 'p2']);
    expect(all.comments[0]?.side).toBe('RIGHT');
    expect(all.overflow).toEqual([]);

    const capped = selectInlineComments(published, config({}, { max_inline_comments: 1 }), diff());
    expect(capped.comments.map((c) => c.cluster.id)).toEqual(['p1-pair']);
    expect(capped.overflow.map((c) => c.id)).toEqual(['p1-solo', 'p2']);
  });

  it('overflows anything below the floor or off a commentable line', () => {
    const published = [
      cluster({ id: 'nit', severity: 'P3', line: 12 }),
      cluster({ id: 'off-diff', line: 99 }),
      cluster({ id: 'other-file', path: 'src/untouched.ts', line: 12 }),
      cluster({ id: 'good', line: 14 }),
    ];
    const { comments, overflow } = selectInlineComments(published, config(), diff());
    expect(comments.map((c) => c.cluster.id)).toEqual(['good']);
    expect(overflow.map((c) => c.id).sort()).toEqual(['nit', 'off-diff', 'other-file']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Receipt
// ─────────────────────────────────────────────────────────────────────────────

describe('formatUsd', () => {
  it('formats to the precision the figure deserves', () => {
    expect(formatUsd(0.97)).toBe('$0.97');
    expect(formatUsd(0.9749)).toBe('$0.97');
    expect(formatUsd(12)).toBe('$12.00');
    expect(formatUsd(0.0043)).toBe('$0.0043');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.00000012)).toBe('<$0.0001');
    expect(formatUsd(null)).toBe('unknown');
  });
});

describe('formatTokens', () => {
  it('scales the unit with the magnitude', () => {
    expect(formatTokens(938)).toBe('938');
    expect(formatTokens(41_200)).toBe('41.2k');
    expect(formatTokens(172_000)).toBe('172k');
    expect(formatTokens(1_240_000)).toBe('1.2M');
    expect(formatTokens(0)).toBe('0');
  });

  it('formats durations the way the receipt headline reads', () => {
    expect(formatDuration(134_000)).toBe('2m14s');
    expect(formatDuration(9_000)).toBe('9s');
  });
});

describe('renderReceipt', () => {
  it('renders the per-model table with a bold total', () => {
    const md = renderReceipt(totals(), { durationMs: 134_000, version: '0.4.1' });
    expect(md).toContain('<details><summary><b>💸 This review cost $0.18</b> · 4 models · 2m14s</summary>');
    expect(md).toContain('| `Opus 5` | Claude Code | 41.2k | 38.0k | 6.1k | $0.18 | reported |');
    expect(md).toContain('| **Total** |');
    expect(md.trimEnd().endsWith('</details>')).toBe(true);
  });

  it('calls a partial total a lower bound and names the unknown rows', () => {
    const t = totals({
      rows: [
        ...totals().rows,
        {
          label: 'Kimi K3',
          harnessLabel: 'OpenCode',
          usage: null,
          cost: { usd: null, source: 'unknown', longContext: false },
        },
      ],
      partial: true,
    });
    const md = renderReceipt(t, { durationMs: 1_000 });
    expect(md).toContain('This review cost at least $0.18');
    expect(md).toContain('**The total is a lower bound** — no cost or usage was reported for `Kimi K3`.');
    expect(md).toContain('| `Kimi K3` | OpenCode | — | — | — | unknown | *unknown* |');
  });

  it('never invents a figure when nothing was priced', () => {
    const md = renderReceipt(totals({ usd: null, partial: true }), { durationMs: 1_000 });
    expect(md).toContain('an unknown amount');
    expect(md).not.toContain('$0.00</b>');
  });

  it('shows the rolling window when one is supplied', () => {
    const md = renderReceipt(totals(), {
      durationMs: 1_000,
      rolling: { totalUsd: 41.2, prCount: 47, windowDays: 30, since: '2026-07-07' },
    });
    expect(md).toContain('Rolling 30d for this repo: **$41.20** across 47 PRs (avg $0.88/PR)');
  });

  it('surfaces partial model reports separately from failures', () => {
    const md = renderReceipt(totals(), {
      durationMs: 1_000,
      partial: [{ label: 'Kimi K3', reason: 'loop.max_steps_exceeded' }],
    });
    expect(md).toContain('Partial: `Kimi K3` (loop.max_steps_exceeded)');
    expect(md).not.toContain('Failed: `Kimi K3`');
  });

  // Referee/verify rows use harnessLabelOf → getHarness(...).label. Receipt must show the
  // display label (Codex), not the raw harness id (codex), so cost rows match model rows.
  it('prints the harness display label on extra cost rows, not the raw id', () => {
    const t = totals({
      rows: [
        ...totals().rows,
        {
          label: 'referee (1 call)',
          harnessLabel: 'Codex',
          usage: null,
          cost: { usd: 0.0043, source: 'estimated', longContext: false },
        },
        {
          label: 'verify (2 calls)',
          harnessLabel: 'Kimi Code CLI',
          usage: null,
          cost: { usd: 0.01, source: 'estimated', longContext: false },
        },
      ],
      usd: 0.1943,
    });
    const md = renderReceipt(t, { durationMs: 1_000 });
    expect(md).toContain('| `referee (1 call)` | Codex |');
    expect(md).toContain('| `verify (2 calls)` | Kimi Code CLI |');
    // Raw harness ids must not appear in the harness column.
    expect(md).not.toContain('| `referee (1 call)` | codex |');
    expect(md).not.toContain('| kimi-code |');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Terminal
// ─────────────────────────────────────────────────────────────────────────────

describe('renderTerminalReport', () => {
  it('stays plain and narrow when stdout is not a tty', () => {
    const text = renderTerminalReport(result(), { version: '0.4.1' });
    expect(text).not.toContain('[');
    expect(text).toContain('3/5');
    expect(text).toContain('src/a.ts:12');
    expect(text).toContain('$0.18');
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(80);
  });

  it('reports skipped models rather than pretending they ran', () => {
    const text = renderTerminalReport(
      result({ runs: [run({ modelLabel: 'Grok 4.5', skipped: true, skipReason: 'XAI_API_KEY is not set', result: null })] }),
      { version: '0.4.1' },
    );
    expect(text).toContain('1 skipped');
    expect(text).toContain('Grok 4.5 skipped — XAI_API_KEY is not set');
  });
});
