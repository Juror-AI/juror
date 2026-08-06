/**
 * The review pipeline.
 *
 * collect & anchor → fan out → cluster → referee → optional verify → score & render.
 *
 * Publishing deliberately lives outside this module. Everything here runs with model
 * processes in the loop and no GitHub token in the environment; `src/github/publish.ts`
 * is the only code that holds one. That split is the trust boundary from design §11, and
 * it is the reason prompt injection cannot escalate past a bad review comment.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  AttributedFinding,
  CostRow,
  DiffContext,
  JurorConfig,
  ModelConfig,
  ReviewResult,
} from './types.js';
import { ZERO_USAGE } from './types.js';
import { anchorFindings } from './diff/anchor.js';
import { buildCluster, clusterFindings } from './merge/cluster.js';
import { auditClusterMembership, buildFindingCoverage } from './merge/coverage.js';
import { refereeClusters } from './merge/referee.js';
import { verifyClusters } from './merge/verify.js';
import { applyPublishRules, scoreReview } from './merge/score.js';
import { loadPricing, totalCost } from './cost/compute.js';
import { fanOut } from './harness/runner.js';
import { synthesizeSummary } from './render/summary.js';
import { loadPromptTemplate, renderTemplate, resolveModelRuntime } from './config.js';
import { loadAgentInstructions } from './instructions.js';
import { log } from './util/log.js';
import { restoreWorkspace, snapshotWorkspace } from './util/workspace.js';

/** Scratch lives inside the repo: opencode auto-rejects any write outside its `--dir`. */
export const SCRATCH_DIRNAME = '.juror-run';

export interface ReviewOptions {
  repoDir: string;
  config: JurorConfig;
  diff: DiffContext;
  secrets: Record<string, string | undefined>;
  /** Models to run, overriding `config.models` selection by id. */
  onlyModels?: string[];
  /** Keep the scratch directory around for debugging. */
  keepScratch?: boolean;
  signal?: AbortSignal;
}

export async function runReview(o: ReviewOptions): Promise<ReviewResult> {
  const started = Date.now();
  const warnings: string[] = [];
  const pricing = loadPricing();

  const config = o.onlyModels?.length ? restrictModels(o.config, o.onlyModels, warnings) : o.config;

  const scratchRoot = path.join(o.repoDir, SCRATCH_DIRNAME);
  await rm(scratchRoot, { recursive: true, force: true });
  await mkdir(scratchRoot, { recursive: true });

  const guard = await snapshotWorkspace(o.repoDir, SCRATCH_DIRNAME);

  try {
    // ── 1. Prompt ────────────────────────────────────────────────────────────
    const promptTemplate = loadPromptTemplate('review');
    const instructions = await loadAgentInstructions(
      o.repoDir,
      o.diff.baseSha,
      o.diff.files.filter((f) => !f.ignored).map((f) => f.path),
    );
    for (const problem of instructions.problems) warnings.push(`instructions: ${problem}`);
    if (instructions.paths.length) {
      log.debug(`repository instructions: ${instructions.paths.join(', ')}`);
    }
    const promptVars = reviewPromptVars(o.diff, o.repoDir, instructions.rendered);

    // ── 2. Budget precheck ───────────────────────────────────────────────────
    const enabled = config.models.filter((m) => m.enabled);
    const estimate = estimateReviewCost(o.diff, enabled, pricing);
    if (estimate > config.budget.max_cost_usd_per_pr) {
      const msg =
        `Estimated cost $${estimate.toFixed(2)} exceeds budget ` +
        `$${config.budget.max_cost_usd_per_pr.toFixed(2)} (${config.budget.on_exceed}).`;
      warnings.push(msg);
      log.warn(msg);
      if (config.budget.on_exceed === 'skip') {
        return emptyResult(o.diff, started, [...warnings, 'Review skipped: over budget.']);
      }
    }

    // ── 3. Fan out ───────────────────────────────────────────────────────────
    log.step(`Fanning out to ${enabled.length} model${enabled.length === 1 ? '' : 's'}`);
    const runs = await fanOut({
      config,
      diff: o.diff,
      repoDir: o.repoDir,
      scratchRoot,
      promptTemplate,
      promptVars,
      pricing,
      secrets: o.secrets,
      ...(o.signal ? { signal: o.signal } : {}),
    });

    for (const r of runs) {
      if (r.skipped) warnings.push(`${r.modelLabel} skipped — ${r.skipReason}`);
      else if (!r.ok) warnings.push(`${r.modelLabel} failed — ${r.error ?? 'unknown error'}`);
      else if (r.result?.truncated) {
        warnings.push(`${r.modelLabel} returned a partial report — the run ended before completion`);
      }
    }

    const produced = runs.filter((r) => r.result?.report);
    if (produced.length === 0) {
      warnings.push('No model produced a usable report.');
      return { ...emptyResult(o.diff, started, warnings), runs, totals: totalCost(runs, []) };
    }

    // ── 4. Anchor ────────────────────────────────────────────────────────────
    const anchored: AttributedFinding[] = [];
    for (const r of produced) {
      const findings = r.result?.report?.findings ?? [];
      anchored.push(
        ...anchorFindings(findings, o.diff, r.modelId, r.modelLabel, config.review.anchor_tolerance),
      );
    }
    log.step(`${anchored.length} raw findings from ${produced.length} models`);

    // ── 5. Cluster ───────────────────────────────────────────────────────────
    const { clusters: initial, ambiguousPairs } = clusterFindings(anchored, {
      lineWindow: config.consensus.line_window,
      mergeThreshold: config.consensus.jaccard_merge_threshold,
      distinctThreshold: config.consensus.jaccard_distinct_threshold,
    });
    log.step(`${initial.length} clusters · ${ambiguousPairs.length} ambiguous pairs`);

    // ── 6. Referee the ambiguous band ────────────────────────────────────────
    const refereeModel = findModel(config, config.consensus.referee_model);
    const refereed = await refereeClusters(ambiguousPairs, initial, {
      modelRun: refereeModel,
      pricing,
      secrets: o.secrets,
      repoDir: o.repoDir,
      scratchRoot,
      promptTemplate: loadPromptTemplate('referee'),
      enabled: ambiguousPairs.length > 0 && refereeModel !== null,
    });

    // ── 7. Lossless coverage audit ───────────────────────────────────────────
    // The final unit of recall is a raw atomic finding, not a cluster. If a future
    // clustering/referee change ever loses or double-assigns one, discard all merge
    // decisions and fall back to singletons. Duplicate comments are recoverable; a hidden
    // defect is not.
    const membership = auditClusterMembership(anchored, refereed.clusters);
    let losslessClusters = refereed.clusters;
    if (!membership.complete) {
      const detail = membership.problems.join('; ');
      warnings.push(`coverage audit failed — using lossless singleton findings: ${detail}`);
      log.warn(`coverage audit failed; reverting deduplication (${detail})`);
      losslessClusters = anchored.map((finding) => buildCluster([finding], ['singleton']));
    }

    // ── 8. Adversarial verification ──────────────────────────────────────────
    // High-recall mode publishes every eligible deduplicated cluster, so a refutation pass
    // cannot affect the result. Skip it instead of charging for evidence we will not use.
    const consensusMode = config.review.publish_mode === 'consensus';
    const verifyModel = consensusMode ? findModel(config, config.consensus.verify_model) : null;
    const verified = await verifyClusters(losslessClusters, {
      modelRun: verifyModel,
      pricing,
      secrets: o.secrets,
      repoDir: o.repoDir,
      scratchRoot,
      promptTemplate: consensusMode ? loadPromptTemplate('verify') : '',
      diff: o.diff,
      verifySolo: config.consensus.verify_solo_findings,
      minimumAgreement: config.consensus.min_agreement === 'all' ? produced.length : 1,
      ...(o.signal ? { signal: o.signal } : {}),
    });
    if (consensusMode) {
      log.step(`${verified.calls} verification${verified.calls === 1 ? '' : 's'} run`);
    } else {
      log.debug('verification skipped in all-findings mode');
    }

    // ── 9. Publish rules, disposition audit & score ──────────────────────────
    const modelsRun = produced.length;
    const clusters = applyPublishRules(verified.clusters, config, modelsRun);
    const published = clusters.filter((c) => c.published);
    const suppressed = clusters.filter((c) => !c.published);
    const coverage = buildFindingCoverage(anchored, clusters);
    if (!coverage.complete) {
      // This should be unreachable after the singleton fallback. Keep it visible in both
      // JSON and the sticky comment instead of claiming full recall.
      warnings.push(`final coverage audit incomplete: ${coverage.problems.join('; ')}`);
    }
    const verdict = scoreReview(clusters, runs);

    // ── 10. Roll up ──────────────────────────────────────────────────────────
    const extras: CostRow[] = [];
    if (refereed.calls > 0) {
      extras.push({
        label: `referee (${refereed.calls} call${refereed.calls === 1 ? '' : 's'})`,
        harnessLabel: refereeModel ? harnessLabelOf(refereeModel) : '—',
        usage: null,
        cost: refereed.cost,
      });
    }
    if (verified.calls > 0) {
      extras.push({
        label: `verify (${verified.calls} call${verified.calls === 1 ? '' : 's'})`,
        harnessLabel: verifyModel ? harnessLabelOf(verifyModel) : '—',
        usage: null,
        cost: verified.cost,
      });
    }

    const totals = totalCost(runs, extras);
    const summary = synthesizeSummary(runs, o.diff);

    log.step(
      `${published.length} published · ${suppressed.length} suppressed · verdict ${verdict.score}/5`,
    );

    return {
      diff: o.diff,
      runs,
      clusters,
      published,
      suppressed,
      coverage,
      verdict,
      summary,
      totals,
      durationMs: Date.now() - started,
      warnings,
    };
  } finally {
    const drift = await restoreWorkspace(guard);
    if (drift.restored.length || drift.removed.length) {
      log.warn(
        `Workspace guard reverted agent edits: ${[...drift.restored, ...drift.removed].join(', ')}`,
      );
    }
    for (const l of drift.left) log.debug(`workspace guard left ${l.path}: ${l.reason}`);
    if (!o.keepScratch) await removeScratch(scratchRoot);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A killed agent can still be flushing files while we tear its scratch dir down, which
 * surfaces as ENOTEMPTY. Retry a couple of times, then leave it: a completed review must
 * never be lost to a failed `rm` of a directory nothing depends on.
 */
async function removeScratch(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (e) {
      if (attempt === 2) {
        log.debug(`could not remove scratch dir ${dir}: ${e instanceof Error ? e.message : e}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

/**
 * Everything the review prompt needs except the two per-model values.
 *
 * The template is rendered exactly once, in the runner, after it adds `FINDINGS_PATH` and
 * `SCRATCH` for that model. Rendering in two passes would be worse than untidy: the diff is
 * attacker-controlled, so a PR containing the literal text `{{FINDINGS_PATH}}` would get it
 * substituted by the second pass. One left-to-right pass never rescans what it just wrote.
 */
function reviewPromptVars(
  diff: DiffContext,
  repoDir: string,
  repoInstructions: string,
): Record<string, string> {
  const changed = diff.files
    .filter((f) => !f.ignored)
    .map((f) => `- ${f.path} (+${f.additions}/-${f.deletions})`)
    .join('\n');

  return {
    REPO_DIR: repoDir,
    BASE_SHA: diff.baseSha,
    HEAD_SHA: diff.headSha,
    CHANGED_FILES: changed || '(none)',
    REPO_INSTRUCTIONS: repoInstructions,
    DIFF: diff.patch,
  };
}

/**
 * A pre-flight guess, used only to decide whether to start. It is intentionally crude and
 * never shown as a cost — the receipt only ever prints measured or provider-reported numbers.
 */
function estimateReviewCost(
  diff: DiffContext,
  models: ModelConfig[],
  pricing: ReturnType<typeof loadPricing>,
): number {
  const promptTokens = Math.ceil(diff.patch.length / 3.5) + 8_000; // patch + system + tool traffic
  const outTokens = 6_000;
  let total = 0;
  for (const m of models) {
    const { pricingKey } = resolveModelRuntime(m);
    const p = pricing[pricingKey];
    if (!p) {
      total += 0.5; // unknown model: assume mid-tier rather than free
      continue;
    }
    const tier =
      p.long_context && promptTokens >= p.long_context.threshold_input_tokens ? p.long_context : p;
    total += (promptTokens / 1e6) * tier.input_per_mtok + (outTokens / 1e6) * tier.output_per_mtok;
  }
  return total;
}

function restrictModels(config: JurorConfig, only: string[], warnings: string[]): JurorConfig {
  const wanted = new Set(only.map((s) => s.trim()).filter(Boolean));
  const models = config.models.map((m) => ({ ...m, enabled: wanted.has(m.id) }));
  for (const id of wanted) {
    if (!models.some((m) => m.id === id)) warnings.push(`--models: no model configured as "${id}"`);
  }
  return { ...config, models };
}

function findModel(config: JurorConfig, id: string | null): ModelConfig | null {
  if (!id) return null;
  return config.models.find((m) => m.id === id) ?? null;
}

function harnessLabelOf(m: ModelConfig): string {
  return m.harness;
}

function emptyResult(diff: DiffContext, started: number, warnings: string[]): ReviewResult {
  return {
    diff,
    runs: [],
    clusters: [],
    published: [],
    suppressed: [],
    coverage: {
      complete: true,
      rawFindings: 0,
      accountedFor: 0,
      uniqueFindings: 0,
      dispositions: [],
      problems: [],
    },
    verdict: { base: 3, penalty: 0, score: 3, votes: [], confirmed: { P0: 0, P1: 0, P2: 0, P3: 0 } },
    summary: {
      summary: 'No model produced a review for this diff.',
      highlights: [],
      fileOverviews: [],
      sequenceDiagram: null,
      confidenceReason: 'No model reports were available, so no confidence can be asserted.',
    },
    totals: { rows: [], usage: { ...ZERO_USAGE }, usd: 0, partial: false, modelsRun: 0 },
    durationMs: Date.now() - started,
    warnings,
  };
}
