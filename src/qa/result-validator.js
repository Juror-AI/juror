/** Strict, dependency-free validation for persisted QA results at artifact boundaries. */

const OUTCOMES = new Set([
  'passed',
  'no_testable_surface',
  'flaky',
  'advisory',
  'product_issue',
  'blocked',
  'infrastructure_error',
  'cancelled',
]);
const SUCCESS_OUTCOMES = new Set(['passed', 'no_testable_surface', 'flaky', 'advisory']);
const FAILURE_OUTCOMES = new Set(['product_issue', 'blocked', 'infrastructure_error']);
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const SHA40 = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

/** @param {unknown} value */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @param {readonly string[]} keys */
function exact(value, keys) {
  if (!record(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

/** @param {unknown} value @param {number} max */
function text(value, max) {
  return typeof value === 'string' && value.length >= 1 && value.length <= max;
}

/** @param {unknown} value */
function integer(value) {
  return Number.isSafeInteger(value);
}

/** @param {unknown} value */
function dateTime(value) {
  return typeof value === 'string' && value.includes('T') && Number.isFinite(Date.parse(value));
}

/** @param {unknown} value */
function httpUrl(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/** @param {unknown} value @param {number} maxItems @param {number} maxText */
function textList(value, maxItems = Number.POSITIVE_INFINITY, maxText = 500) {
  return Array.isArray(value) && value.length <= maxItems && value.every((item) => text(item, maxText));
}

/** @param {unknown[]} value */
function unique(value) {
  return new Set(value.map((item) => JSON.stringify(item))).size === value.length;
}

/** @param {unknown} value */
function planLocator(value) {
  if (!exact(value, ['by', 'value', 'name', 'exact', 'nth'])) return false;
  const locator = /** @type {Record<string, unknown>} */ (value);
  const by = locator.by;
  if (!['role', 'label', 'text', 'placeholder', 'test_id', 'css'].includes(
    /** @type {string} */ (by),
  )) return false;
  if (!text(locator.value, 4_000)) return false;
  if (!(locator.name === null || text(locator.name, 500))) return false;
  if (by !== 'role' && locator.name !== null) return false;
  if (typeof locator.exact !== 'boolean') return false;
  if ((by === 'css' || by === 'test_id') && locator.exact) return false;
  return locator.nth === null || (
    integer(locator.nth) && Number(locator.nth) >= 0 && Number(locator.nth) <= 10_000
  );
}

/** @param {unknown} value */
function planAssertion(value) {
  if (!exact(value, ['kind', 'locator', 'url_contains'])) return false;
  const assertion = /** @type {Record<string, unknown>} */ (value);
  const kind = assertion.kind;
  if (!['visible', 'hidden', 'text', 'url', 'value', 'status'].includes(
    /** @type {string} */ (kind),
  )) return false;
  if (kind === 'url') {
    return assertion.locator === null && text(assertion.url_contains, 4_000);
  }
  if (kind === 'status') {
    return assertion.locator === null && assertion.url_contains === null;
  }
  return planLocator(assertion.locator) && assertion.url_contains === null;
}

/** @param {unknown} value */
function plan(value) {
  if (!exact(value, [
    'schema_version',
    'impact_assessment',
    'testability',
    'no_testable_surface_reason',
    'surfaces',
    'scenarios',
    'risk_notes',
    'blind_spots',
  ])) return false;
  const p = /** @type {Record<string, unknown>} */ (value);
  if (
    p.schema_version !== 1 ||
    !text(p.impact_assessment, 4_000) ||
    !['testable', 'no_testable_surface'].includes(/** @type {string} */ (p.testability)) ||
    !textList(p.surfaces, 30) ||
    !textList(p.risk_notes, 30) ||
    !textList(p.blind_spots, 30) ||
    !Array.isArray(p.scenarios) ||
    p.scenarios.length > 6
  ) return false;
  if (p.testability === 'no_testable_surface') {
    if (!text(p.no_testable_surface_reason, 4_000) || p.scenarios.length !== 0) return false;
  } else if (p.no_testable_surface_reason !== null || p.scenarios.length < 1) {
    return false;
  }
  // Guard structural access before collecting IDs: persisted inputs are untrusted
  // and malformed array entries must simply fail validation, never throw.
  if (!p.scenarios.every(record) ||
    !unique(p.scenarios.map((scenario) => /** @type {Record<string, unknown>} */ (scenario).id))) return false;
  return p.scenarios.every((value) => {
    if (!exact(value, [
      'id',
      'title',
      'rationale',
      'viewport',
      'preconditions',
      'seeded_state',
      'checkpoints',
      'allowed_mutations',
      'cleanup_expectations',
    ])) return false;
    const scenario = /** @type {Record<string, unknown>} */ (value);
    const viewport = scenario.viewport;
    if (!exact(viewport, ['kind', 'width', 'height', 'justification'])) return false;
    const view = /** @type {Record<string, unknown>} */ (viewport);
    const checkpoints = scenario.checkpoints;
    const mutations = scenario.allowed_mutations;
    return typeof scenario.id === 'string' && ID.test(scenario.id) &&
      text(scenario.title, 500) &&
      text(scenario.rationale, 4_000) &&
      ['desktop', 'mobile'].includes(/** @type {string} */ (view.kind)) &&
      integer(view.width) && Number(view.width) >= 240 && Number(view.width) <= 3_840 &&
      integer(view.height) && Number(view.height) >= 320 && Number(view.height) <= 2_160 &&
      text(view.justification, 500) &&
      textList(scenario.preconditions, 30) &&
      textList(scenario.seeded_state, 30) &&
      Array.isArray(checkpoints) && checkpoints.length >= 1 && checkpoints.length <= 20 &&
      checkpoints.every(record) &&
      unique(checkpoints.map((checkpoint) => /** @type {Record<string, unknown>} */ (checkpoint).id)) &&
      checkpoints.every((checkpoint) => {
        if (!exact(checkpoint, ['id', 'description', 'expected', 'assertion'])) return false;
        const c = /** @type {Record<string, unknown>} */ (checkpoint);
        const assertion = /** @type {Record<string, unknown>} */ (c.assertion);
        return typeof c.id === 'string' && ID.test(c.id) &&
          text(c.description, 500) && text(c.expected, 4_000) && planAssertion(c.assertion) &&
          (assertion.kind !== 'status' || /^(?:[2-4]\d{2})$/.test(/** @type {string} */ (c.expected)));
      }) &&
      Array.isArray(mutations) && mutations.length >= 1 && unique(mutations) &&
      mutations.every((mutation) => ['none', 'create', 'update', 'delete', 'upload'].includes(mutation)) &&
      textList(scenario.cleanup_expectations, 30);
  });
}

/** @param {unknown} value */
function revision(value) {
  if (!exact(value, [
    'verified_against',
    'expected_sha',
    'observed_sha',
    'relation',
    'method',
    'contains_merge_sha',
    'additional_commits',
    'additional_commits_truncated',
  ])) return false;
  const r = /** @type {Record<string, unknown>} */ (value);
  const shapeIsValid = ['merge', 'head', 'none'].includes(/** @type {string} */ (r.verified_against)) &&
    (r.expected_sha === null || (typeof r.expected_sha === 'string' && SHA40.test(r.expected_sha))) &&
    (r.observed_sha === null || (typeof r.observed_sha === 'string' && SHA40.test(r.observed_sha))) &&
    ['exact', 'descendant', 'unverified'].includes(/** @type {string} */ (r.relation)) &&
    ['github-compare', 'deployment-sha', 'static-probe', 'none'].includes(/** @type {string} */ (r.method)) &&
    (typeof r.contains_merge_sha === 'boolean' || r.contains_merge_sha === null) &&
    Array.isArray(r.additional_commits) &&
    r.additional_commits.every((sha) => typeof sha === 'string' && SHA40.test(sha)) &&
    typeof r.additional_commits_truncated === 'boolean';
  if (!shapeIsValid) return false;
  if (r.relation === 'unverified') {
    // An operator may retain an expected SHA as a diagnostic claim, but no
    // observed revision or eligibility proof can accompany it.
    return r.verified_against === 'none' && r.observed_sha === null && r.method === 'none' &&
      r.contains_merge_sha === null && r.additional_commits.length === 0 &&
      r.additional_commits_truncated === false;
  }
  if (r.verified_against === 'none' || r.expected_sha === null || r.observed_sha === null ||
    r.method === 'none' || r.contains_merge_sha === null) return false;
  const sameRevision = r.expected_sha.toLowerCase() === r.observed_sha.toLowerCase();
  if (r.relation === 'exact') {
    return sameRevision && ['deployment-sha', 'static-probe'].includes(/** @type {string} */ (r.method)) &&
      r.additional_commits.length === 0 && r.additional_commits_truncated === false;
  }
  return !sameRevision && ['github-compare', 'static-probe'].includes(/** @type {string} */ (r.method));
}

/** @param {unknown} value */
function target(value) {
  if (!exact(value, [
    'kind',
    'url',
    'allowed_origin',
    'environment',
    'deployment_id',
    'deployment_status_id',
    'revision',
    'stability',
    'verdict_eligible',
    'resolved_at',
    'ready_at',
  ])) return false;
  const t = /** @type {Record<string, unknown>} */ (value);
  return ['staging-deployment', 'staging-static', 'preview-deployment'].includes(/** @type {string} */ (t.kind)) &&
    httpUrl(t.url) && httpUrl(t.allowed_origin) &&
    (typeof t.environment === 'string' || t.environment === null) &&
    (t.deployment_id === null || (integer(t.deployment_id) && Number(t.deployment_id) >= 1)) &&
    (t.deployment_status_id === null || (integer(t.deployment_status_id) && Number(t.deployment_status_id) >= 1)) &&
    revision(t.revision) &&
    ['unchecked', 'stable', 'drifted'].includes(/** @type {string} */ (t.stability)) &&
    typeof t.verdict_eligible === 'boolean' && dateTime(t.resolved_at) && dateTime(t.ready_at);
}

/** @param {unknown} value */
function operation(value) {
  if (!exact(value, ['sequence', 'action', 'summary', 'status', 'started_at', 'duration_ms', 'error'])) return false;
  const o = /** @type {Record<string, unknown>} */ (value);
  return integer(o.sequence) && Number(o.sequence) >= 1 &&
    ['navigate', 'locate', 'click', 'fill', 'select', 'press', 'wait', 'inspect_text', 'inspect_url', 'checkpoint']
      .includes(/** @type {string} */ (o.action)) &&
    text(o.summary, 4_000) &&
    ['succeeded', 'failed', 'denied'].includes(/** @type {string} */ (o.status)) &&
    dateTime(o.started_at) && integer(o.duration_ms) && Number(o.duration_ms) >= 0 &&
    (o.error === null || text(o.error, 4_000));
}

/** @param {unknown} value */
function checkpoint(value) {
  if (!exact(value, ['checkpoint_id', 'status', 'expected', 'observed'])) return false;
  const c = /** @type {Record<string, unknown>} */ (value);
  return typeof c.checkpoint_id === 'string' && ID.test(c.checkpoint_id) &&
    ['passed', 'failed', 'blocked'].includes(/** @type {string} */ (c.status)) &&
    text(c.expected, 4_000) && text(c.observed, 4_000);
}

/** @param {unknown} value */
function observation(value) {
  if (!exact(value, ['kind', 'summary', 'observed_at'])) return false;
  const o = /** @type {Record<string, unknown>} */ (value);
  return ['browser', 'checkpoint', 'console', 'network', 'policy'].includes(/** @type {string} */ (o.kind)) &&
    text(o.summary, 4_000) && dateTime(o.observed_at);
}

/** @param {unknown} value */
function attempt(value) {
  if (!exact(value, [
    'scenario_id',
    'attempt',
    'status',
    'started_at',
    'duration_ms',
    'operations',
    'checkpoints',
    'observations',
    'evidence_artifact_ids',
  ])) return false;
  const a = /** @type {Record<string, unknown>} */ (value);
  return typeof a.scenario_id === 'string' && ID.test(a.scenario_id) &&
    [1, 2].includes(/** @type {number} */ (a.attempt)) &&
    ['passed', 'failed', 'blocked', 'infrastructure_error'].includes(/** @type {string} */ (a.status)) &&
    dateTime(a.started_at) && integer(a.duration_ms) && Number(a.duration_ms) >= 0 &&
    Array.isArray(a.operations) && a.operations.every(operation) &&
    Array.isArray(a.checkpoints) && a.checkpoints.every(checkpoint) &&
    Array.isArray(a.observations) && a.observations.every(observation) &&
    Array.isArray(a.evidence_artifact_ids) && unique(a.evidence_artifact_ids) &&
    a.evidence_artifact_ids.every((id) => text(id, 200));
}

/** @param {unknown} value */
function issue(value) {
  if (!exact(value, [
    'id',
    'scenario_id',
    'checkpoint_id',
    'severity',
    'classification',
    'reproducible',
    'title',
    'expected',
    'actual',
    'attempt_numbers',
  ])) return false;
  const i = /** @type {Record<string, unknown>} */ (value);
  return text(i.id, 200) && typeof i.scenario_id === 'string' && ID.test(i.scenario_id) &&
    typeof i.checkpoint_id === 'string' && ID.test(i.checkpoint_id) &&
    ['P0', 'P1', 'P2', 'P3'].includes(/** @type {string} */ (i.severity)) &&
    ['verified', 'advisory'].includes(/** @type {string} */ (i.classification)) &&
    typeof i.reproducible === 'boolean' && text(i.title, 500) &&
    text(i.expected, 4_000) && text(i.actual, 4_000) &&
    Array.isArray(i.attempt_numbers) && i.attempt_numbers.length >= 1 && i.attempt_numbers.length <= 2 &&
    unique(i.attempt_numbers) && i.attempt_numbers.every((number) => number === 1 || number === 2);
}

/** @param {unknown} value */
function cleanup(value) {
  if (!exact(value, ['status', 'summary', 'error'])) return false;
  const c = /** @type {Record<string, unknown>} */ (value);
  return ['passed', 'failed', 'not_required'].includes(/** @type {string} */ (c.status)) &&
    text(c.summary, 4_000) && (c.error === null || text(c.error, 4_000));
}

/** @param {unknown} value */
function artifact(value) {
  if (!exact(value, ['id', 'kind', 'path', 'sanitized', 'sha256', 'retention_days', 'upload'])) return false;
  const a = /** @type {Record<string, unknown>} */ (value);
  const upload = a.upload;
  const validUpload = upload === null || (
    exact(upload, ['name', 'url']) &&
    text(/** @type {Record<string, unknown>} */ (upload).name, 200) &&
    httpUrl(/** @type {Record<string, unknown>} */ (upload).url)
  );
  return text(a.id, 200) &&
    ['video', 'trace', 'screenshot', 'console', 'network', 'ledger', 'plan', 'report']
      .includes(/** @type {string} */ (a.kind)) &&
    text(a.path, 4_000) && typeof a.sanitized === 'boolean' &&
    typeof a.sha256 === 'string' && SHA256.test(a.sha256) &&
    integer(a.retention_days) && Number(a.retention_days) >= 1 && validUpload;
}

/** @param {unknown} value */
function usage(value) {
  if (!exact(value, ['uncachedIn', 'cacheRead', 'cacheWrite', 'out'])) return false;
  return Object.values(/** @type {Record<string, unknown>} */ (value))
    .every((amount) => integer(amount) && Number(amount) >= 0);
}

/** @param {unknown} value */
function runtime(value) {
  if (!exact(value, ['model_id', 'model_version', 'browser_name', 'browser_version'])) return false;
  const r = /** @type {Record<string, unknown>} */ (value);
  return text(r.model_id, 200) && (typeof r.model_version === 'string' || r.model_version === null) &&
    r.browser_name === 'chromium' && text(r.browser_version, 200);
}

/** @param {unknown} value */
function cost(value) {
  if (!exact(value, ['usage', 'usd', 'source'])) return false;
  const c = /** @type {Record<string, unknown>} */ (value);
  return (c.usage === null || usage(c.usage)) &&
    (c.usd === null || (typeof c.usd === 'number' && Number.isFinite(c.usd) && c.usd >= 0)) &&
    ['reported', 'estimated', 'unknown'].includes(/** @type {string} */ (c.source));
}

/** @param {unknown} outcome @param {unknown} conclusion */
function canonicalConclusion(outcome, conclusion) {
  return (SUCCESS_OUTCOMES.has(/** @type {string} */ (outcome)) && conclusion === 'success') ||
    (FAILURE_OUTCOMES.has(/** @type {string} */ (outcome)) && conclusion === 'failure') ||
    (outcome === 'cancelled' && conclusion === 'cancelled');
}

/** Resolve sealed plan references and reject duplicate/tampered browser evidence. */
function knownEvidence(result, requireCompleteFinal) {
  const attempts = /** @type {Array<Record<string, unknown>>} */ (result.attempts);
  const scenarios = /** @type {Array<Record<string, unknown>>} */ (result.plan.scenarios);
  const planned = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  if (planned.size !== scenarios.length) return false;
  const final = new Map();
  const tuples = new Set();
  for (const item of attempts) {
    const tuple = `${item.scenario_id}:${item.attempt}`;
    if (!planned.has(item.scenario_id) || tuples.has(tuple)) return false;
    tuples.add(tuple);
  }
  for (const item of attempts) {
    const scenario = planned.get(item.scenario_id);
    if (!scenario || !Array.isArray(item.checkpoints) ||
      (item.attempt === 2 && !tuples.has(`${item.scenario_id}:1`))) return false;
    const checkpoints = new Map(scenario.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
    const seen = new Set();
    for (const observed of item.checkpoints) {
      const sealed = checkpoints.get(observed.checkpoint_id);
      if (!sealed || seen.has(observed.checkpoint_id) || observed.expected !== sealed.expected) return false;
      seen.add(observed.checkpoint_id);
    }
    const current = final.get(item.scenario_id);
    if (!current || Number(item.attempt) > Number(current.attempt)) final.set(item.scenario_id, item);
  }
  if (!requireCompleteFinal) return true;
  return scenarios.every((scenario) => {
    const attempt = final.get(scenario.id);
    if (!attempt || attempt.status !== 'passed') return false;
    const checkpoints = new Map(attempt.checkpoints.map((checkpoint) => [checkpoint.checkpoint_id, checkpoint]));
    return scenario.checkpoints.length === checkpoints.size &&
      scenario.checkpoints.every((checkpoint) => checkpoints.get(checkpoint.id)?.status === 'passed');
  });
}

function resolvedIssueReferences(result) {
  const scenarios = new Map(result.plan.scenarios.map((scenario) => [scenario.id, scenario]));
  return result.issues.every((item) => scenarios.get(item.scenario_id)?.checkpoints
    .some((checkpoint) => checkpoint.id === item.checkpoint_id));
}

/** Match the classifier's comparison of independently observed checkpoint text. */
function normalizedObservation(value) {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Product and advisory findings must be backed by reproducible controller evidence. */
function reproducedIssues(result) {
  const attempts = new Map(result.attempts.map((item) => [`${item.scenario_id}:${item.attempt}`, item]));
  const scenarios = new Map(result.plan.scenarios.map((scenario) => [scenario.id, scenario]));
  return result.issues.every((item) => {
    if (!item.reproducible || item.attempt_numbers.length !== 2 ||
      !item.attempt_numbers.includes(1) || !item.attempt_numbers.includes(2)) return false;
    const scenario = scenarios.get(item.scenario_id);
    const sealed = scenario?.checkpoints.find((checkpoint) => checkpoint.id === item.checkpoint_id);
    const first = attempts.get(`${item.scenario_id}:1`);
    const second = attempts.get(`${item.scenario_id}:2`);
    const firstCheckpoint = first?.checkpoints.find((checkpoint) => checkpoint.checkpoint_id === item.checkpoint_id);
    const secondCheckpoint = second?.checkpoints.find((checkpoint) => checkpoint.checkpoint_id === item.checkpoint_id);
    return first?.status === 'failed' && second?.status === 'failed' &&
      firstCheckpoint?.status === 'failed' && secondCheckpoint?.status === 'failed' &&
      firstCheckpoint.expected === sealed?.expected && secondCheckpoint.expected === sealed?.expected &&
      normalizedObservation(firstCheckpoint.observed) === normalizedObservation(secondCheckpoint.observed) &&
      item.expected === sealed?.expected && item.actual === secondCheckpoint.observed;
  });
}

/** References remain coherent even when finalization changes the terminal outcome. */
function evidenceIsCoherent(result) {
  if (result.attempts.length > 0 && (!record(result.plan) || !knownEvidence(result, false))) return false;
  if (result.issues.length > 0 && (
    !record(result.plan) ||
    !resolvedIssueReferences(result) ||
    !reproducedIssues(result) ||
    (result.issues.some((item) => item.classification === 'verified') &&
      (result.base_resolution !== 'exact' || !record(result.target) || result.target.verdict_eligible !== true))
  )) return false;
  return true;
}

/** A verdict-eligible flag is only meaningful when it is backed by revision proof. */
function targetEligibilityIsCoherent(result) {
  if (!record(result.target)) return true;
  const proof = result.target.revision;
  if (!record(proof)) return false;
  if (proof.verified_against === 'merge') {
    if (proof.expected_sha === null || proof.expected_sha.toLowerCase() !== result.merge_sha.toLowerCase() ||
      proof.contains_merge_sha !== true) return false;
  } else if (proof.verified_against === 'head') {
    if (proof.observed_sha === null || result.target.kind !== 'preview-deployment' ||
      proof.relation !== 'exact' || typeof proof.contains_merge_sha !== 'boolean' ||
      proof.contains_merge_sha !== (proof.observed_sha.toLowerCase() === result.merge_sha.toLowerCase())) {
      return false;
    }
  }
  if (result.target.verdict_eligible !== true) return true;
  return result.base_resolution === 'exact' && proof.expected_sha !== null &&
    proof.observed_sha !== null && proof.relation !== 'unverified' && proof.method !== 'none' &&
    (proof.verified_against === 'merge' || proof.verified_against === 'head');
}

/** Terminal outcomes must be internally compatible with classifyQaOutcome. */
function presentationIsComplete(result) {
  if (!targetEligibilityIsCoherent(result) || !evidenceIsCoherent(result)) return false;
  if ((result.outcome === 'blocked' || result.outcome === 'cancelled') && result.issues.length !== 0) return false;
  if (result.outcome === 'infrastructure_error' || result.outcome === 'blocked' || result.outcome === 'cancelled') {
    return true;
  }
  if (result.outcome === 'no_testable_surface') {
    return record(result.plan) && result.plan.testability === 'no_testable_surface' &&
      result.attempts.length === 0 && result.issues.length === 0 && result.cleanup.status !== 'failed' &&
      (result.target === null || (record(result.target) && result.target.stability === 'stable'));
  }
  if (result.outcome === 'product_issue') {
    return record(result.target) && record(result.plan) && result.target.stability === 'stable' &&
      result.target.verdict_eligible === true && result.base_resolution === 'exact' &&
      result.plan.testability === 'testable' &&
      result.cleanup.status !== 'failed' && result.attempts.length > 0 && result.issues.length > 0 &&
      result.issues.some((item) => item.classification === 'verified') &&
      !result.attempts.some((item) => item.status === 'blocked' || item.status === 'infrastructure_error') &&
      knownEvidence(result, false) && resolvedIssueReferences(result) && reproducedIssues(result);
  }
  if (!SUCCESS_OUTCOMES.has(result.outcome)) return true;
  if (!record(result.target) || !record(result.plan) || result.cleanup.status === 'failed' ||
    result.target.stability !== 'stable') return false;
  if (result.plan.testability !== 'testable') return false;
  if (result.outcome === 'advisory') {
    return result.attempts.length > 0 && result.issues.length > 0 &&
      result.issues.every((item) => item.classification === 'advisory') &&
      !result.attempts.some((item) => item.status === 'blocked' || item.status === 'infrastructure_error') &&
      knownEvidence(result, false) && resolvedIssueReferences(result) && reproducedIssues(result);
  }
  if (result.issues.length !== 0 || result.attempts.length === 0 || !knownEvidence(result, true)) return false;
  if (result.outcome === 'passed') {
    return result.attempts.every((item) => item.status === 'passed' &&
      item.checkpoints.every((checkpoint) => checkpoint.status === 'passed'));
  }
  // classifyQaOutcome emits flaky only after an initial failure followed by a
  // passing retry, never for blocked/infrastructure attempts.
  return !result.attempts.some((item) => item.status === 'blocked' || item.status === 'infrastructure_error') &&
    result.attempts.some((item) => item.attempt === 1 && item.status === 'failed' &&
      result.attempts.some((retry) => retry.scenario_id === item.scenario_id && retry.attempt === 2 && retry.status === 'passed'));
}

/** @param {unknown} value @returns {boolean} */
export function isQaRunResult(value) {
  if (!exact(value, [
    'schema_version',
    'run_id',
    'repository',
    'pr_number',
    'merge_sha',
    'base_resolution',
    'source_base_sha',
    'policy_base_shas',
    'started_at',
    'completed_at',
    'duration_ms',
    'outcome',
    'conclusion',
    'target',
    'plan',
    'attempts',
    'issues',
    'cleanup',
    'artifacts',
    'runtime',
    'cost',
    'warnings',
  ])) return false;
  const r = /** @type {Record<string, unknown>} */ (value);
  return r.schema_version === 1 && text(r.run_id, 200) &&
    typeof r.repository === 'string' && /^[^/\s]+\/[^/\s]+$/.test(r.repository) &&
    integer(r.pr_number) && Number(r.pr_number) >= 1 &&
    typeof r.merge_sha === 'string' && SHA40.test(r.merge_sha) &&
    ['exact', 'conservative'].includes(/** @type {string} */ (r.base_resolution)) &&
    typeof r.source_base_sha === 'string' && SHA40.test(r.source_base_sha) &&
    Array.isArray(r.policy_base_shas) && r.policy_base_shas.length >= 1 && r.policy_base_shas.length <= 100 &&
    unique(r.policy_base_shas) && r.policy_base_shas.every((sha) => typeof sha === 'string' && SHA40.test(sha)) &&
    dateTime(r.started_at) && dateTime(r.completed_at) &&
    integer(r.duration_ms) && Number(r.duration_ms) >= 0 &&
    OUTCOMES.has(/** @type {string} */ (r.outcome)) && canonicalConclusion(r.outcome, r.conclusion) &&
    (r.target === null || target(r.target)) && (r.plan === null || plan(r.plan)) &&
    Array.isArray(r.attempts) && r.attempts.every(attempt) &&
    Array.isArray(r.issues) && r.issues.every(issue) && cleanup(r.cleanup) &&
    Array.isArray(r.artifacts) && r.artifacts.every(artifact) && runtime(r.runtime) && cost(r.cost) &&
    textList(r.warnings, 100) && presentationIsComplete(r);
}
