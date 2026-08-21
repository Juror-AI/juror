import { fingerprint } from '../github/fingerprint.js';
import type {
  CanonicalUsage,
  Cluster,
  CostBreakdown,
  CostTotals,
  DiffFile,
  FindingCoverage,
  HarnessId,
  ModelReport,
  ReviewResult,
  ReviewSummary,
  Verdict,
} from '../types.js';

export const HOSTED_REVIEW_SCHEMA_VERSION = 1 as const;
export type HostedReviewSchemaVersion = typeof HOSTED_REVIEW_SCHEMA_VERSION;

export const RUN_EVENT_SCHEMA_VERSION = 1 as const;
export type RunEventSchemaVersion = typeof RUN_EVENT_SCHEMA_VERSION;

export const RUN_PHASES = [
  'queued',
  'preparing',
  'checkout',
  'reviewing',
  'clustering',
  'verifying',
  'publishing',
  'waiting_for_deployment',
  'planning_qa',
  'running_qa',
  'retaining_evidence',
  'billing',
  'completed',
  'cancelled',
  'failed',
] as const;
export type RunPhase = (typeof RUN_PHASES)[number];

export type RunEventStatus = 'pending' | 'running' | 'succeeded' | 'warning' | 'failed' | 'cancelled';

/**
 * A deliberately small event contract for live progress. Messages are bounded by
 * the hosted controller before persistence and must never contain model scratch text.
 */
export interface RunEventV1 {
  schemaVersion: RunEventSchemaVersion;
  runId: string;
  sequence: number;
  timestamp: string;
  phase: RunPhase;
  status: RunEventStatus;
  message: string;
  metrics?: {
    durationMs?: number;
    completedModels?: number;
    totalModels?: number;
    findings?: number;
    costMicroUsd?: number;
  };
}

export interface HostedDiffFileV1 {
  path: string;
  previousPath: string | null;
  status: DiffFile['status'];
  additions: number;
  deletions: number;
  hunks: DiffFile['hunks'];
  changedLines: number[];
  ignored: boolean;
}

export interface HostedReviewModelV1 {
  modelId: string;
  modelLabel: string;
  harness: HarnessId;
  harnessLabel: string;
  pricingKey: string;
  ok: boolean;
  skipped: boolean;
  skipReason: string | null;
  report: ModelReport | null;
  usage: CanonicalUsage | null;
  usageSource: 'provider' | 'harness' | null;
  resolvedModel: string | null;
  turns: number | null;
  truncated: boolean;
  diagnostics: string[];
  cost: CostBreakdown;
  durationMs: number;
  error: string | null;
}

export interface HostedClusterV1 extends Cluster {
  fingerprint: string;
}

/**
 * Safe, versioned report stored in R2. It intentionally has no `diff.patch`, raw
 * model response, process output, scratch path, environment, or repository source.
 */
export interface HostedReviewReportV1 {
  schemaVersion: HostedReviewSchemaVersion;
  diff: {
    files: HostedDiffFileV1[];
    baseSha: string;
    headSha: string;
    sinceSha: string | null;
    totalAdditions: number;
    totalDeletions: number;
    ignoredPaths: string[];
    truncated: boolean;
  };
  models: HostedReviewModelV1[];
  clusters: HostedClusterV1[];
  publishedFingerprints: string[];
  suppressedFingerprints: string[];
  coverage: FindingCoverage;
  verdict: Verdict;
  summary: ReviewSummary;
  totals: CostTotals;
  durationMs: number;
  warnings: string[];
}

function safeHostedOperationalMessage(message: string): string {
  return boundRunEventMessage(message
    .replace(/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/gi, '[credential redacted]')
    .replace(/\bBearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/\/(?:tmp|workspace)\/[^\s]+/g, '[runtime path]'));
}

export function sanitizeHostedReviewResult(result: ReviewResult): HostedReviewReportV1 {
  const hostedClusters = result.clusters.map((cluster) => ({
    ...cluster,
    fingerprint: fingerprint(cluster),
  }));
  const byId = new Map(hostedClusters.map((cluster) => [cluster.id, cluster]));

  return {
    schemaVersion: HOSTED_REVIEW_SCHEMA_VERSION,
    diff: {
      files: result.diff.files.map(({ positionByLine: _positions, ...file }) => ({ ...file })),
      baseSha: result.diff.baseSha,
      headSha: result.diff.headSha,
      sinceSha: result.diff.sinceSha,
      totalAdditions: result.diff.totalAdditions,
      totalDeletions: result.diff.totalDeletions,
      ignoredPaths: [...result.diff.ignoredPaths],
      truncated: result.diff.truncated,
    },
    models: result.runs.map((run) => ({
      modelId: run.modelId,
      modelLabel: run.modelLabel,
      harness: run.harness,
      harnessLabel: run.harnessLabel,
      pricingKey: run.pricingKey,
      ok: run.ok,
      skipped: run.skipped,
      skipReason: run.skipReason,
      report: run.result?.report ?? null,
      usage: run.result?.usage ?? null,
      usageSource: run.result?.usageSource ?? null,
      resolvedModel: run.result?.resolvedModel ?? null,
      turns: run.result?.turns ?? null,
      truncated: run.result?.truncated ?? false,
      diagnostics: run.result?.diagnostics?.length ? ['Operational reviewer diagnostics were not retained.'] : [],
      cost: run.cost,
      durationMs: run.durationMs,
      error: run.error ? 'Reviewer did not return a usable structured result.' : null,
    })),
    clusters: hostedClusters,
    publishedFingerprints: result.published.map((cluster) => byId.get(cluster.id)?.fingerprint ?? fingerprint(cluster)),
    suppressedFingerprints: result.suppressed.map((cluster) => byId.get(cluster.id)?.fingerprint ?? fingerprint(cluster)),
    coverage: result.coverage,
    verdict: result.verdict,
    summary: result.summary,
    totals: result.totals,
    durationMs: result.durationMs,
    warnings: result.warnings.map(safeHostedOperationalMessage),
  };
}

export const MAX_RUN_EVENT_MESSAGE_LENGTH = 240;

export function boundRunEventMessage(message: string): string {
  const normalized = message.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (normalized.length <= MAX_RUN_EVENT_MESSAGE_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_RUN_EVENT_MESSAGE_LENGTH - 1)}…`;
}
