/**
 * The publish rule and the merge score — §7 and §8.
 *
 * Both are pure and deterministic on purpose. The score in the summary comment is not a
 * model's opinion, it is arithmetic over what was published, and the votes are shown so a
 * surprising number is explainable rather than mystical.
 */

import type { Cluster, JurorConfig, ModelRun, Severity, Verdict } from '../types.js';

const SEVERITY_RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

const SUPPRESSED_OUTSIDE_DIFF = 'outside the diff';
const SUPPRESSED_REFUTED = 'refuted on verification';
const SUPPRESSED_BELOW_FLOOR = 'below severity floor';
const SUPPRESSED_BELOW_AGREEMENT = 'below agreement threshold';

// ─────────────────────────────────────────────────────────────────────────────
// Publish rule
// ─────────────────────────────────────────────────────────────────────────────

export function requiredAgreement(
  minAgreement: JurorConfig['consensus']['min_agreement'],
  modelsRun: number,
): number {
  // Majority means strictly more than half. `ceil(n / 2)` accidentally accepted a 2-2
  // split when four models ran.
  if (minAgreement === 'majority') return Math.floor(modelsRun / 2) + 1;
  if (minAgreement === 'all') return modelsRun;
  return Math.max(1, Math.round(minAgreement));
}

function isSerious(c: Cluster): boolean {
  return c.severity === 'P0' || c.severity === 'P1';
}

/** Consensus policy, kept separate from suppression reasons so it stays readable. */
function shouldPublish(
  c: Cluster,
  required: number,
  minAgreement: JurorConfig['consensus']['min_agreement'],
): boolean {
  if (c.agreement >= required) return true;
  // `all` is the simple low-recall setting exposed in the default config: it means literal
  // unanimity. The safety exceptions below remain available with majority/numeric policies.
  if (minAgreement === 'all') return false;
  if (c.agreement >= 2 && isSerious(c)) return true;
  // A solo serious finding has to have survived the refutation pass. Unverified is not
  // the same as confirmed — a verifier that never answered leaves `verification` null,
  // and that must not be enough to post.
  return c.agreement === 1 && isSerious(c) && c.verification !== null && !c.verification.refuted;
}

export function applyPublishRules(
  clusters: Cluster[],
  config: JurorConfig,
  modelsRun: number,
): Cluster[] {
  const required = requiredAgreement(config.consensus.min_agreement, modelsRun);
  const floor = SEVERITY_RANK[config.review.severity_floor];

  return clusters.map((c) => {
    // First match wins; the order is the order a reader would ask the questions in.
    let reason: string | null = null;
    if (c.anchor === 'unknown-file') reason = SUPPRESSED_OUTSIDE_DIFF;
    else if (config.review.publish_mode === 'consensus' && c.verification?.refuted) reason = SUPPRESSED_REFUTED;
    else if (SEVERITY_RANK[c.severity] > floor) reason = SUPPRESSED_BELOW_FLOOR;
    else if (
      config.review.publish_mode === 'consensus' &&
      !shouldPublish(c, required, config.consensus.min_agreement)
    ) {
      reason = SUPPRESSED_BELOW_AGREEMENT;
    }

    return { ...c, published: reason === null, suppressedReason: reason };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Merge score
// ─────────────────────────────────────────────────────────────────────────────

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length === 0) return 0;
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function scoreReview(clusters: Cluster[], runs: ModelRun[]): Verdict {
  const votes: { modelLabel: string; vote: number }[] = [];
  for (const r of runs) {
    const report = r.result?.report;
    if (!report) continue; // A model that produced nothing does not get a vote.
    votes.push({ modelLabel: r.modelLabel, vote: report.merge_confidence });
  }

  const published = clusters.filter((c) => c.published);
  const confirmed: Record<Severity, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const c of published) confirmed[c.severity]++;

  // P2s cap at −1 in total; P3s never move the score on their own.
  const penalty = 2 * confirmed.P0 + 1 * confirmed.P1 + Math.min(1, 0.5 * confirmed.P2);

  // `min(base, 5 - penalty)` is the load-bearing bit: models cannot vote away a confirmed
  // blocker, and a clean diff still cannot reach 5 if the models were individually unsure.
  const base = votes.length > 0 ? median(votes.map((v) => v.vote)) : 3;
  const capped = votes.length > 0 ? Math.min(base, 5 - penalty) : 5 - penalty;

  return {
    base,
    penalty,
    score: clamp(Math.round(capped), 1, 5),
    votes,
    confirmed,
  };
}
