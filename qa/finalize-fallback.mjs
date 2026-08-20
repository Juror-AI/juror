/**
 * Runner-side fail-closed boundary for the post-upload QA phases.
 *
 * This file intentionally uses only Node built-ins. It remains available when the verified
 * runtime image or its CLI crashes, and it never executes code from the tested repository.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isQaRunResult } from '../src/qa/result-validator.js';

const outcomes = new Set([
  'passed',
  'no_testable_surface',
  'flaky',
  'advisory',
  'product_issue',
  'blocked',
  'infrastructure_error',
  'cancelled',
]);
const targetKinds = new Set(['staging-deployment', 'staging-static', 'preview-deployment']);

function configuredSecrets(encoded) {
  if (!encoded?.trim()) return [];
  let parsed;
  try {
    const raw = Buffer.from(encoded.trim(), 'base64');
    if (raw.length > 128 * 1024) throw new Error('decoded payload is too large');
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('QA fallback could not validate the configured secret bundle');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('QA fallback could not validate the configured secret bundle');
  }
  const values = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.length < 8) {
      throw new Error('QA fallback could not validate the configured secret bundle');
    }
    values.push(value);
  }
  return [...new Set(values)];
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function validHttpUrl(raw) {
  try {
    const parsed = new URL(raw);
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      !parsed.username &&
      !parsed.password
    ) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function markdownLink(label, rawUrl) {
  const normalized = validHttpUrl(rawUrl);
  if (!normalized) return null;
  const parsed = new URL(normalized);
  const authority = `${parsed.protocol}//${parsed.host}`;
  const destination = authority + normalized.slice(authority.length).replace(
    /[\\()[\]]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `[${label}](<${destination}>)`;
}

function safeWarning(raw) {
  return (raw || 'QA infrastructure finalization failed')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 500) || 'QA infrastructure finalization failed';
}

function fallbackReport(repository, prNumber) {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    run_id: `${repository.replace('/', '-')}-${prNumber}-${process.env.GITHUB_RUN_ID || 'unknown'}`,
    repository,
    pr_number: prNumber,
    merge_sha: '0'.repeat(40),
    base_resolution: 'conservative',
    source_base_sha: '0'.repeat(40),
    policy_base_shas: ['0'.repeat(40)],
    started_at: now,
    completed_at: now,
    duration_ms: 0,
    outcome: 'infrastructure_error',
    conclusion: 'failure',
    target: null,
    plan: null,
    attempts: [],
    issues: [],
    cleanup: {
      status: 'not_required',
      summary: 'QA finalization stopped before cleanup state could be verified.',
      error: null,
    },
    artifacts: [],
    runtime: {
      model_id: 'unknown',
      model_version: null,
      browser_name: 'chromium',
      browser_version: 'unknown',
    },
    cost: { usage: null, usd: null, source: 'unknown' },
    warnings: [],
  };
}

function loadReport(reportPath, repository, prNumber) {
  try {
    const parsed = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    if (
      !isQaRunResult(parsed) ||
      parsed.repository.toLowerCase() !== repository.toLowerCase() ||
      parsed.pr_number !== prNumber
    ) {
      throw new Error('invalid persisted QA result');
    }
    return { report: parsed, valid: true };
  } catch {
    return { report: fallbackReport(repository, prNumber), valid: false };
  }
}

function atomicWrite(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.juror-${process.pid}`;
  fs.writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function containsSecretValue(value, secrets, seen = new WeakSet()) {
  if (typeof value === 'string') return secrets.some((secret) => value.includes(secret));
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((item) => containsSecretValue(item, secrets, seen));
}

function containsSecretBytes(contents, secrets) {
  const body = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  return secrets.some((secret) => body.includes(Buffer.from(secret)));
}

function removeSemanticFiles(reportPath, summaryPath) {
  fs.rmSync(reportPath, { force: true });
  fs.rmSync(summaryPath, { force: true });
}

function refuseUnsafeSemanticOutput(reportPath, summaryPath, secrets, ...values) {
  if (values.some((value) => Buffer.isBuffer(value) || typeof value === 'string'
    ? containsSecretBytes(value, secrets)
    : containsSecretValue(value, secrets))) {
    removeSemanticFiles(reportPath, summaryPath);
    throw new Error('QA fallback semantic output contained a configured secret canary');
  }
}

function deliveryMatches(report, delivered, artifactName, artifactUrl) {
  if (delivered) {
    return report.artifacts.every((artifact) =>
      artifact &&
      artifact.upload?.name === artifactName &&
      artifact.upload?.url === artifactUrl,
    );
  }
  return report.outcome === 'infrastructure_error' &&
    report.conclusion === 'failure' &&
    report.artifacts.every((artifact) => !artifact?.upload);
}

function infrastructureSummary(report, reason, artifactUrl) {
  const evidenceLink = markdownLink('open artifact', artifactUrl);
  const evidence = evidenceLink ? `\n- Evidence payload: ${evidenceLink}` : '';
  return `### Juror QA — Infrastructure error\n\n` +
    `Juror could not produce a trustworthy final QA result.\n\n` +
    `- Outcome: \`infrastructure_error\`\n` +
    `- Pull request: #${report.pr_number}\n` +
    `- Browser issues retained: ${report.issues.length}${evidence}\n\n` +
    `Warning: ${reason}\n`;
}

function markInfrastructureError(report, reason, delivered, artifactName, artifactUrl) {
  report.outcome = 'infrastructure_error';
  report.conclusion = 'failure';
  report.artifacts = report.artifacts.map((artifact) => ({
    ...artifact,
    upload: delivered ? { name: artifactName, url: artifactUrl } : null,
  }));
  report.warnings = [
    ...report.warnings.filter((warning) => warning !== reason),
    reason,
  ].slice(-100);
  return report;
}

const reportPath = required('REPORT_PATH');
const summaryPath = required('SUMMARY_PATH');
const repository = required('GITHUB_REPOSITORY');
const prNumber = Number(required('PR_NUMBER'));
if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new Error('PR_NUMBER must be positive');

let secrets;
try {
  secrets = configuredSecrets(process.env.JUROR_QA_SECRETS_B64);
} catch (error) {
  removeSemanticFiles(reportPath, summaryPath);
  throw error;
}
for (const semanticPath of [reportPath, summaryPath]) {
  if (fs.existsSync(semanticPath)) {
    refuseUnsafeSemanticOutput(
      reportPath,
      summaryPath,
      secrets,
      fs.readFileSync(semanticPath),
    );
  }
}

const delivered = process.env.JUROR_QA_ACTION_PAYLOAD_DELIVERED === 'true';
const readOnly = process.env.JUROR_QA_ACTION_READ_ONLY === 'true';
const requireInfrastructureError = process.env.JUROR_QA_ACTION_REQUIRE_INFRASTRUCTURE_ERROR === 'true';
const artifactName = process.env.ARTIFACT_NAME?.trim() || '';
const artifactUrl = validHttpUrl(process.env.ARTIFACT_URL?.trim() || '');
if (delivered && (!artifactName || artifactName.length > 200 || !artifactUrl)) {
  throw new Error('Delivered QA payload requires a valid artifact name and URL');
}

const loaded = loadReport(reportPath, repository, prNumber);
let report = loaded.report;
refuseUnsafeSemanticOutput(reportPath, summaryPath, secrets, report);
let reason = safeWarning(process.env.JUROR_QA_ACTION_FINALIZATION_ERROR || '');
const explicitError = Boolean(process.env.JUROR_QA_ACTION_FINALIZATION_ERROR?.trim());
const missingSummary = !fs.existsSync(summaryPath) || fs.statSync(summaryPath).size === 0;
const wrongRequiredOutcome = requireInfrastructureError &&
  (report.outcome !== 'infrastructure_error' || report.conclusion !== 'failure');
const invalidFinalState = !loaded.valid ||
  !deliveryMatches(report, delivered, artifactName, artifactUrl) ||
  missingSummary ||
  wrongRequiredOutcome;
if (readOnly && (explicitError || invalidFinalState)) {
  throw new Error('Final QA result changed or became invalid after its immutable upload');
}
if (!explicitError && invalidFinalState) {
  reason = safeWarning(
    !loaded.valid
      ? 'QA finalizer did not persist a valid report'
      : missingSummary
      ? 'QA finalizer did not persist a non-empty summary'
      : wrongRequiredOutcome
      ? 'QA finalizer did not persist the required infrastructure-error outcome'
      : 'QA finalizer did not persist the expected evidence delivery state',
  );
}

if (explicitError || invalidFinalState) {
  report = markInfrastructureError(report, reason, delivered, artifactName, artifactUrl);
  const reportContents = `${JSON.stringify(report, null, 2)}\n`;
  const summaryContents = infrastructureSummary(report, reason, delivered ? artifactUrl : null);
  refuseUnsafeSemanticOutput(
    reportPath,
    summaryPath,
    secrets,
    report,
    reportContents,
    summaryContents,
  );
  atomicWrite(reportPath, reportContents);
  atomicWrite(summaryPath, summaryContents);
}

if (process.env.GITHUB_OUTPUT) {
  const targetKind = targetKinds.has(report.target?.kind) ? report.target.kind : 'none';
  const observedSha = /^[0-9a-f]{40}$/i.test(report.target?.revision?.observed_sha || '')
    ? report.target.revision.observed_sha
    : 'unverified';
  const cost = typeof report.cost?.usd === 'number' && Number.isFinite(report.cost.usd)
    ? report.cost.usd
    : 'unknown';
  const exitCode = report.conclusion === 'success' ? 0 : report.conclusion === 'cancelled' ? 130 : 1;
  const values = {
    outcome: outcomes.has(report.outcome) ? report.outcome : 'infrastructure_error',
    issues: report.issues.length,
    scenarios: Array.isArray(report.plan?.scenarios) ? report.plan.scenarios.length : 0,
    'target-kind': targetKind,
    'target-sha': observedSha,
    'cost-usd': cost,
    'artifact-url': delivered ? artifactUrl : '',
    'report-path': reportPath,
    'exit-code': exitCode,
  };
  for (const [key, value] of Object.entries(values)) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}
