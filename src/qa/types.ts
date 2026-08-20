import type { CanonicalUsage, Severity } from '../types.js';

/** Version written into every persisted QA plan and run result. */
export const QA_SCHEMA_VERSION = 1 as const;
export type QaSchemaVersion = typeof QA_SCHEMA_VERSION;

export const QA_OUTCOMES = [
  'passed',
  'no_testable_surface',
  'flaky',
  'advisory',
  'product_issue',
  'blocked',
  'infrastructure_error',
  'cancelled',
] as const;
export type QaOutcome = (typeof QA_OUTCOMES)[number];

export type QaJobConclusion = 'success' | 'failure' | 'cancelled';

// ─────────────────────────────────────────────────────────────────────────────
// Trusted configuration
// ─────────────────────────────────────────────────────────────────────────────

export const QA_REASONING_EFFORTS = ['low', 'medium', 'high', 'max'] as const;
export type QaReasoningEffort = (typeof QA_REASONING_EFFORTS)[number];

export interface QaModelConfig {
  id: string;
  reasoning_effort: QaReasoningEffort;
}

export interface QaCommitProbeConfig {
  /** Same-origin path resolved against the selected target URL. */
  path: string;
  /** RFC 6901 JSON Pointer selecting the deployed commit SHA. */
  json_pointer: string;
}

export interface QaTargetConfig {
  strategy: 'staging-first';
  /** Security tier used by authenticated QA policy. */
  environment: string;
  /** Exact GitHub deployment environment to query; null falls back to `environment`. */
  deployment_environment: string | null;
  static_url: string | null;
  readiness_path: string;
  /** Exact statuses accepted by readiness probes; null uses the normal 2xx/3xx policy. */
  readiness_statuses: number[] | null;
  commit_probe: QaCommitProbeConfig | null;
  preview_fallback: boolean;
  wait_seconds: number;
}

export type QaLocator =
  | { by: 'role'; role: string; name: string }
  | { by: 'label' | 'placeholder' | 'text' | 'test-id'; value: string };

export interface QaAuthGotoStep {
  type: 'goto';
  /** Relative, same-origin path. Absolute URLs are rejected by configuration validation. */
  path: string;
}

export interface QaAuthFillStep {
  type: 'fill';
  locator: QaLocator;
  /** Logical key in the decoded JUROR_QA_SECRETS_B64 map; never a literal credential. */
  secret_ref: string;
}

export interface QaAuthClickStep {
  type: 'click';
  locator: QaLocator;
}

export interface QaAuthWaitStep {
  type: 'wait';
  locator: QaLocator;
  state: 'visible' | 'hidden';
  timeout_seconds?: number;
}

export type QaAuthStep = QaAuthGotoStep | QaAuthFillStep | QaAuthClickStep | QaAuthWaitStep;

export interface QaAuthSessionBootstrapConfig {
  /** Trusted controller endpoint that returns a one-time staging login redirect. */
  url: string;
  /** Logical key in the decoded JUROR_QA_SECRETS_B64 map; never a literal token. */
  secret_ref: string;
  /** Exact canonical staging origin to which the one-time login may redirect. */
  target_origin: string;
  /** Web Storage key whose non-empty value proves client-side redemption completed. */
  ready_storage_key: string;
}

export interface QaAuthSecretHeader {
  /** Allowlisted X-* or Cloudflare Access request header injected only for exact origins. */
  name: string;
  /** Logical key in the decoded JUROR_QA_SECRETS_B64 map; never a literal token. */
  secret_ref: string;
  /** Exact staging origins eligible to receive the secret header. */
  origins: string[];
}

export interface QaAuthConfig {
  session_bootstrap: QaAuthSessionBootstrapConfig | null;
  browser_secret_headers: QaAuthSecretHeader[];
  steps: QaAuthStep[];
}

export interface QaResetSecretHeader {
  name: string;
  secret_ref: string;
  /** `bearer` renders `Bearer <secret>`; `raw` sends the exact secret value. */
  format: 'bearer' | 'raw';
}

export interface QaResetConfig {
  /** Absolute allowlisted URL or a path resolved against the selected target. */
  url: string;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  secret_headers: QaResetSecretHeader[];
  expected_statuses: number[];
  timeout_seconds?: number;
}

export interface QaSandboxConfig {
  /** Exact HTTP(S) origins admitted by both the browser broker and egress proxy. */
  allowed_origins: string[];
  reset: QaResetConfig | null;
}

export interface QaLimits {
  max_scenarios: number;
  max_browser_operations: number;
  timeout_seconds: number;
  mobile_when_relevant: boolean;
}

export type QaEvidenceMode = 'all' | 'failure' | 'off';

export interface QaEvidenceConfig {
  video: QaEvidenceMode;
  trace: QaEvidenceMode;
  screenshot: QaEvidenceMode;
  retention_days: number;
}

export interface QaTestabilityConfig {
  /**
   * Trusted repository-relative globs that identify changes which never need browser QA.
   * The controller exits only when every path in the complete changed-file manifest matches.
   */
  early_exit_paths: string[];
}

export interface QaConfig {
  enabled: boolean;
  model: QaModelConfig;
  testability: QaTestabilityConfig;
  target: QaTargetConfig;
  auth: QaAuthConfig;
  sandbox: QaSandboxConfig;
  limits: QaLimits;
  evidence: QaEvidenceConfig;
}

// ─────────────────────────────────────────────────────────────────────────────
// Model-authored plan (untrusted until parseQaPlan succeeds)
// ─────────────────────────────────────────────────────────────────────────────

export interface QaPlanHardLimits {
  max_scenarios: number;
  /** Optional controller cap; the parser otherwise uses its conservative built-in cap. */
  max_checkpoints_per_scenario?: number;
}

export type QaTestability = 'testable' | 'no_testable_surface';
export type QaViewportKind = 'desktop' | 'mobile';

export interface QaViewport {
  kind: QaViewportKind;
  width: number;
  height: number;
  justification: string;
}

export const QA_CHECKPOINT_ASSERTION_KINDS = [
  'visible',
  'hidden',
  'text',
  'url',
  'value',
  'status',
] as const;
export type QaCheckpointAssertionKind = (typeof QA_CHECKPOINT_ASSERTION_KINDS)[number];

export const QA_CHECKPOINT_LOCATOR_KINDS = [
  'role',
  'label',
  'text',
  'placeholder',
  'test_id',
  'css',
] as const;
export type QaCheckpointLocatorKind = (typeof QA_CHECKPOINT_LOCATOR_KINDS)[number];

/** Canonical, serializable locator sealed into the accepted plan. */
export interface QaCheckpointLocator {
  by: QaCheckpointLocatorKind;
  /** Role name for `role`; selector/query text for all other locator kinds. */
  value: string;
  /** Optional accessible name, valid only for `role`. */
  name: string | null;
  exact: boolean;
  nth: number | null;
}

/**
 * Executable assertion semantics accepted before the browser is unlocked.
 * Every field is explicit so an execution agent cannot swap the tested
 * element or comparator after seeing browser state.
 */
export interface QaCheckpointAssertion {
  kind: QaCheckpointAssertionKind;
  locator: QaCheckpointLocator | null;
  url_contains: string | null;
}

export interface QaCheckpoint {
  id: string;
  description: string;
  expected: string;
  assertion: QaCheckpointAssertion;
}

/** High-level mutation classes the broker may admit inside the dedicated QA tenant. */
export const QA_MUTATION_CATEGORIES = ['none', 'create', 'update', 'delete', 'upload'] as const;
export type QaMutationCategory = (typeof QA_MUTATION_CATEGORIES)[number];

export interface QaScenario {
  id: string;
  title: string;
  rationale: string;
  viewport: QaViewport;
  preconditions: string[];
  seeded_state: string[];
  checkpoints: QaCheckpoint[];
  allowed_mutations: QaMutationCategory[];
  cleanup_expectations: string[];
}

export interface QaPlan {
  schema_version: QaSchemaVersion;
  impact_assessment: string;
  testability: QaTestability;
  no_testable_surface_reason: string | null;
  surfaces: string[];
  scenarios: QaScenario[];
  risk_notes: string[];
  blind_spots: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolved deployment target
// ─────────────────────────────────────────────────────────────────────────────

export type QaTargetKind = 'staging-deployment' | 'staging-static' | 'preview-deployment';
export type QaRevisionRelation = 'exact' | 'descendant' | 'unverified';
export type QaRevisionMethod = 'github-compare' | 'deployment-sha' | 'static-probe' | 'none';

export interface QaRevisionProof {
  /** Preview deployments are verified against the PR head; staging targets against the merge. */
  verified_against: 'merge' | 'head' | 'none';
  expected_sha: string | null;
  observed_sha: string | null;
  relation: QaRevisionRelation;
  method: QaRevisionMethod;
  contains_merge_sha: boolean | null;
  additional_commits: string[];
  additional_commits_truncated: boolean;
}

export interface QaTarget {
  kind: QaTargetKind;
  url: string;
  allowed_origin: string;
  environment: string | null;
  deployment_id: number | null;
  deployment_status_id: number | null;
  revision: QaRevisionProof;
  stability: 'unchecked' | 'stable' | 'drifted';
  verdict_eligible: boolean;
  resolved_at: string;
  ready_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Attempts, evidence, and final persisted result
// ─────────────────────────────────────────────────────────────────────────────

export const QA_BROWSER_ACTIONS = [
  'navigate',
  'locate',
  'click',
  'fill',
  'select',
  'press',
  'wait',
  'inspect_text',
  'inspect_url',
  'checkpoint',
] as const;
export type QaBrowserAction = (typeof QA_BROWSER_ACTIONS)[number];

export interface QaBrokerOperation {
  sequence: number;
  action: QaBrowserAction;
  summary: string;
  status: 'succeeded' | 'failed' | 'denied';
  started_at: string;
  duration_ms: number;
  error: string | null;
}

export interface QaCheckpointResult {
  checkpoint_id: string;
  status: 'passed' | 'failed' | 'blocked';
  expected: string;
  observed: string;
}

export interface QaObservation {
  kind: 'browser' | 'checkpoint' | 'console' | 'network' | 'policy';
  summary: string;
  observed_at: string;
}

export interface QaAttempt {
  scenario_id: string;
  attempt: 1 | 2;
  status: 'passed' | 'failed' | 'blocked' | 'infrastructure_error';
  started_at: string;
  duration_ms: number;
  operations: QaBrokerOperation[];
  checkpoints: QaCheckpointResult[];
  observations: QaObservation[];
  evidence_artifact_ids: string[];
}

export interface QaIssue {
  id: string;
  scenario_id: string;
  checkpoint_id: string;
  severity: Severity;
  classification: 'verified' | 'advisory';
  reproducible: boolean;
  title: string;
  expected: string;
  actual: string;
  attempt_numbers: (1 | 2)[];
}

export type QaArtifactKind =
  | 'video'
  | 'trace'
  | 'screenshot'
  | 'console'
  | 'network'
  | 'ledger'
  | 'plan'
  | 'report';

export interface QaArtifactUpload {
  name: string;
  url: string;
}

export interface QaArtifact {
  id: string;
  kind: QaArtifactKind;
  path: string;
  sanitized: boolean;
  sha256: string;
  retention_days: number;
  upload: QaArtifactUpload | null;
}

export interface QaCleanupResult {
  status: 'passed' | 'failed' | 'not_required';
  summary: string;
  error: string | null;
}

export interface QaRuntimeIdentity {
  model_id: string;
  model_version: string | null;
  browser_name: 'chromium';
  browser_version: string;
}

export interface QaRunCost {
  usage: CanonicalUsage | null;
  usd: number | null;
  source: 'reported' | 'estimated' | 'unknown';
}

export type QaBaseResolution = 'exact' | 'conservative';

export interface QaRunResult {
  schema_version: QaSchemaVersion;
  run_id: string;
  repository: string;
  pr_number: number;
  merge_sha: string;
  base_resolution: QaBaseResolution;
  source_base_sha: string;
  policy_base_shas: string[];
  started_at: string;
  completed_at: string;
  duration_ms: number;
  outcome: QaOutcome;
  conclusion: QaJobConclusion;
  target: QaTarget | null;
  plan: QaPlan | null;
  attempts: QaAttempt[];
  issues: QaIssue[];
  cleanup: QaCleanupResult;
  artifacts: QaArtifact[];
  runtime: QaRuntimeIdentity;
  cost: QaRunCost;
  warnings: string[];
}
