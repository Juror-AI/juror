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

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
import { applyPublishRules, requiredAgreement, scoreReview } from './merge/score.js';
import { loadPricing, totalCost } from './cost/compute.js';
import { fanOut } from './harness/runner.js';
import { getHarness } from './harness/registry.js';
import { synthesizeSummary } from './render/summary.js';
import { loadPromptTemplate, readSecret, renderTemplate, resolveModelRuntime } from './config.js';
import { loadAgentInstructions } from './instructions.js';
import type { LoadedAgentInstructions } from './instructions.js';
import { log } from './util/log.js';
import { restoreWorkspace, snapshotWorkspace } from './util/workspace.js';

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
  /** Preloaded before an ephemeral model checkout has its `.git` pointer removed. */
  instructions?: LoadedAgentInstructions;
  /** GitHub-authored context for distinguishing intentional scope from accidental omission. */
  pullRequest?: { title: string; body: string };
}

export async function runReview(o: ReviewOptions): Promise<ReviewResult> {
  const started = Date.now();
  const warnings: string[] = [];
  if (!o.diff.files.some((file) => !file.ignored)) {
    return emptyResult(
      o.diff,
      started,
      ['Nothing to review: the diff is empty after path filters.'],
      {
        summary: 'No reviewable changes were present after path filters.',
        confidenceReason: 'No model run was needed for an empty reviewable diff.',
      },
    );
  }
  const pricing = loadPricing();

  const requestedConfig = o.onlyModels?.length
    ? restrictModels(o.config, o.onlyModels, warnings)
    : o.config;

  // Never reuse or delete a consumer-owned path. A unique OS temp directory also keeps
  // agent startup discovery away from PR-controlled settings in the repository.
  const scratchRoot = await mkdtemp(path.join(tmpdir(), 'juror-review-'));
  const guard = await snapshotWorkspace(o.repoDir, null);

  try {
    // ── 1. Prompt ────────────────────────────────────────────────────────────
    const promptTemplate = loadPromptTemplate('review');
    const instructions =
      o.instructions ??
      (await loadAgentInstructions(
        o.repoDir,
        o.diff.baseSha,
        o.diff.files.filter((f) => !f.ignored).map((f) => f.path),
      ));
    for (const problem of instructions.problems) warnings.push(`instructions: ${problem}`);
    if (instructions.paths.length) {
      log.debug(`repository instructions: ${instructions.paths.join(', ')}`);
    }
    const promptVars = reviewPromptVars(
      o.diff,
      o.repoDir,
      instructions.rendered,
      o.pullRequest,
    );

    // ── 2. Budget precheck ───────────────────────────────────────────────────
    const plan = planModelsWithinTarget(requestedConfig, o.diff, o.secrets, pricing, warnings);
    if (!plan) {
      return emptyResult(o.diff, started, [...warnings, 'Review skipped: estimated spend is over target.']);
    }
    const config = plan.config;
    const enabled = config.models.filter((m) => m.enabled);
    if (plan.estimate > config.budget.target_cost_usd_per_pr) {
      const msg =
        `Estimated cost $${plan.estimate.toFixed(2)} exceeds planning target ` +
        `$${config.budget.target_cost_usd_per_pr.toFixed(2)} (${config.budget.on_exceed}).`;
      warnings.push(msg);
      log.warn(msg);
    }

    if (!enabled.some((model) => hasSecret(readSecret(o.secrets, model.secret).value))) {
      return emptyResult(o.diff, started, [...warnings, 'No runnable model fits the spend target.']);
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
    const refereeModel = findModel(config, config.consensus.referee_model, o.secrets, warnings);
    const refereed = await refereeClusters(ambiguousPairs, initial, {
      modelRun: refereeModel,
      pricing,
      secrets: o.secrets,
      repoDir: o.repoDir,
      scratchRoot,
      promptTemplate: loadPromptTemplate('referee'),
      enabled: ambiguousPairs.length > 0 && refereeModel !== null,
      ...(o.signal ? { signal: o.signal } : {}),
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
    const verifyModel = consensusMode
      ? findModel(config, config.consensus.verify_model, o.secrets, warnings)
      : null;
    const verificationThreshold = requiredAgreement(
      config.consensus.min_agreement,
      produced.length,
    );
    const verified = await verifyClusters(losslessClusters, {
      modelRun: verifyModel,
      pricing,
      secrets: o.secrets,
      repoDir: o.repoDir,
      scratchRoot,
      promptTemplate: consensusMode ? loadPromptTemplate('verify') : '',
      diff: o.diff,
      verifySolo: config.consensus.verify_solo_findings,
      minimumAgreement: verificationThreshold,
      allowSeriousBelowThreshold: config.consensus.min_agreement !== 'all',
      repoInstructions: instructions.rendered,
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
    if (totals.usd !== null && totals.usd > config.budget.target_cost_usd_per_pr) {
      warnings.push(
        `Actual spend ${totals.usd.toFixed(4)} USD exceeded the ` +
          `${config.budget.target_cost_usd_per_pr.toFixed(2)} USD planning target; ` +
          'this provider does not expose a hard per-request spend limit.',
      );
    }
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
    else log.info(`scratch artifacts kept at ${scratchRoot}`);
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
const MAX_PR_BODY_CHARS = 20_000;

export function reviewPromptVars(
  diff: DiffContext,
  repoDir: string,
  repoInstructions: string,
  pullRequest?: { title: string; body: string },
): Record<string, string> {
  const changed = diff.files
    .filter((f) => !f.ignored)
    .map((f) => `- ${f.path} (+${f.additions}/-${f.deletions})`)
    .join('\n');

  const body = pullRequest?.body ?? '';
  const boundedBody =
    body.length > MAX_PR_BODY_CHARS
      ? `${body.slice(0, MAX_PR_BODY_CHARS)}\n\n[PR body truncated by Juror]`
      : body;
  const prContext = pullRequest
    ? JSON.stringify({ title: pullRequest.title, body: boundedBody }, null, 2)
    : '(No pull request title or description was supplied for this local review.)';

  return {
    REPO_DIR: repoDir,
    BASE_SHA: diff.baseSha,
    HEAD_SHA: diff.headSha,
    CHANGED_FILES: changed || '(none)',
    PR_CONTEXT: prContext,
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

function hasSecret(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function planModelsWithinTarget(
  config: JurorConfig,
  diff: DiffContext,
  secrets: Record<string, string | undefined>,
  pricing: ReturnType<typeof loadPricing>,
  warnings: string[],
): { config: JurorConfig; estimate: number } | null {
  const runnable = config.models.filter((m) => m.enabled && hasSecret(readSecret(secrets, m.secret).value));
  const estimate = estimateReviewCost(diff, runnable, pricing);
  const target = config.budget.target_cost_usd_per_pr;
  if (estimate <= target) return { config, estimate };
  if (config.budget.on_exceed === 'skip') {
    warnings.push(
      `Estimated runnable-model spend $${estimate.toFixed(2)} exceeds the $${target.toFixed(2)} planning target.`,
    );
    return null;
  }

  let planned = 0;
  const selected = new Set<string>();
  for (const model of runnable) {
    const modelEstimate = estimateReviewCost(diff, [model], pricing);
    if (planned + modelEstimate > target) continue;
    selected.add(model.id);
    planned += modelEstimate;
  }

  const models = config.models.map((model) => {
    if (!model.enabled || !hasSecret(readSecret(secrets, model.secret).value) || selected.has(model.id)) return model;
    warnings.push(`${model.label ?? model.id} omitted because its estimate does not fit the spend target.`);
    return { ...model, enabled: false };
  });
  return { config: { ...config, models }, estimate };
}

function restrictModels(config: JurorConfig, only: string[], warnings: string[]): JurorConfig {
  const wanted = new Set(only.map((s) => s.trim()).filter(Boolean));
  const models = config.models.map((m) => ({ ...m, enabled: wanted.has(m.id) }));
  for (const id of wanted) {
    if (!models.some((m) => m.id === id)) warnings.push(`--models: no model configured as "${id}"`);
  }
  return { ...config, models };
}

/**
 * Resolve the model used for referee / verify.
 *
 * Prefer the configured id when it is enabled and has a readable secret.
 * Otherwise fall back to the first enabled model whose secret can be read,
 * and push a warning so the silent degradation is visible. Returns null when
 * `id` is null (feature disabled) or no keyed enabled model exists.
 */
export function findModel(
  config: JurorConfig,
  id: string | null,
  secrets: Record<string, string | undefined>,
  warnings: string[],
): ModelConfig | null {
  if (!id) return null;

  const preferred = config.models.find((m) => m.id === id && m.enabled) ?? null;
  if (preferred && hasSecret(readSecret(secrets, preferred.secret).value)) {
    return preferred;
  }

  const fallback =
    config.models.find((m) => m.enabled && hasSecret(readSecret(secrets, m.secret).value)) ?? null;
  if (fallback) {
    const reason = preferred
      ? `has no readable secret (${preferred.secret})`
      : 'is missing or disabled';
    warnings.push(
      `Configured model "${id}" ${reason}; falling back to "${fallback.id}" for referee/verify.`,
    );
    return fallback;
  }

  return null;
}

function harnessLabelOf(m: ModelConfig): string {
  return getHarness(m.harness).label;
}

function emptyResult(
  diff: DiffContext,
  started: number,
  warnings: string[],
  copy: { summary?: string; confidenceReason?: string } = {},
): ReviewResult {
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
      summary: copy.summary ?? 'No model produced a review for this diff.',
      highlights: [],
      fileOverviews: [],
      sequenceDiagram: null,
      confidenceReason:
        copy.confidenceReason ?? 'No model reports were available, so no confidence can be asserted.',
    },
    totals: { rows: [], usage: { ...ZERO_USAGE }, usd: 0, partial: false, modelsRun: 0 },
    durationMs: Date.now() - started,
    warnings,
  };
}
