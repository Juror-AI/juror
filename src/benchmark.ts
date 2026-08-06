/**
 * Metrics for a manually adjudicated shadow-review corpus.
 *
 * Matching review prose automatically would turn the benchmark into another model
 * opinion. Instead, a human assigns each valid observed report to an expected finding id;
 * this module performs only deterministic accounting over those decisions.
 */

import type { Severity } from './types.js';
import { SEVERITIES } from './types.js';
import { redact } from './util/log.js';

export interface BenchmarkExpectedFinding {
  id: string;
  severity: Severity;
  title: string;
}

export interface BenchmarkObservedFinding {
  title: string;
  severity: Severity;
  /** Null means the adjudicator rejected the report as a false positive. */
  expected_id: string | null;
  /** Optional adjudicator label for repeated false positives describing the same claim. */
  duplicate_key?: string | null;
}

export interface BenchmarkReviewerRun {
  reviewer: string;
  cost_usd: number | null;
  duration_ms: number | null;
  findings: BenchmarkObservedFinding[];
}

export interface BenchmarkCase {
  id: string;
  url?: string;
  expected: BenchmarkExpectedFinding[];
  runs: BenchmarkReviewerRun[];
}

export interface BenchmarkCorpus {
  version: 1;
  cases: BenchmarkCase[];
}

export interface BenchmarkMiss {
  caseId: string;
  expectedId: string;
  severity: Severity;
  title: string;
}

export interface ReviewerBenchmarkMetrics {
  reviewer: string;
  cases: number;
  expected: number;
  found: number;
  recall: number;
  p0ToP2Expected: number;
  p0ToP2Found: number;
  p0ToP2Recall: number;
  reports: number;
  validReports: number;
  precision: number;
  duplicateReports: number;
  duplicateRate: number;
  costUsd: number;
  costPartial: boolean;
  averageDurationMs: number | null;
  misses: BenchmarkMiss[];
}

export interface BenchmarkResult {
  cases: number;
  reviewers: ReviewerBenchmarkMetrics[];
}

export function parseBenchmarkCorpus(raw: unknown): BenchmarkCorpus {
  if (!isRecord(raw) || raw['version'] !== 1 || !Array.isArray(raw['cases'])) {
    throw new Error('benchmark: expected {"version":1,"cases":[...]}');
  }

  const cases = raw['cases'].map((value, index) => parseCase(value, index));
  const ids = new Set<string>();
  for (const item of cases) {
    if (ids.has(item.id)) throw new Error(`benchmark: duplicate case id ${item.id}`);
    ids.add(item.id);
  }
  if (cases.length > 1) {
    const expectedReviewers = new Set(cases[0]?.runs.map((run) => run.reviewer) ?? []);
    for (const item of cases.slice(1)) {
      const actual = new Set(item.runs.map((run) => run.reviewer));
      const missing = [...expectedReviewers].filter((reviewer) => !actual.has(reviewer));
      const extra = [...actual].filter((reviewer) => !expectedReviewers.has(reviewer));
      if (missing.length > 0 || extra.length > 0) {
        throw new Error(
          `benchmark: case ${item.id} must contain the same reviewers as ${cases[0]?.id}` +
            `${missing.length ? `; missing ${missing.join(', ')}` : ''}` +
            `${extra.length ? `; unexpected ${extra.join(', ')}` : ''}`,
        );
      }
    }
  }
  return { version: 1, cases };
}

export function evaluateBenchmark(corpus: BenchmarkCorpus): BenchmarkResult {
  const reviewerNames = new Set<string>();
  for (const item of corpus.cases) {
    for (const run of item.runs) reviewerNames.add(run.reviewer);
  }

  const reviewers = [...reviewerNames]
    .sort()
    .map((reviewer) => evaluateReviewer(corpus.cases, reviewer));
  return { cases: corpus.cases.length, reviewers };
}

export function renderBenchmark(result: BenchmarkResult): string {
  const lines = [
    `Juror shadow benchmark · ${result.cases} case${result.cases === 1 ? '' : 's'}`,
    '',
    '| Reviewer | P0–P2 recall | Overall recall | Precision | Duplicates | Cost | Avg time |',
    '|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const metrics of result.reviewers) {
    const cost =
      metrics.costPartial && metrics.costUsd === 0
        ? 'unknown'
        : `${metrics.costPartial ? '≥' : ''}$${metrics.costUsd.toFixed(2)}`;
    lines.push(
      `| ${cell(metrics.reviewer)} | ${percent(metrics.p0ToP2Recall)} (${metrics.p0ToP2Found}/${metrics.p0ToP2Expected}) | ` +
        `${percent(metrics.recall)} (${metrics.found}/${metrics.expected}) | ${percent(metrics.precision)} | ` +
        `${percent(metrics.duplicateRate)} (${metrics.duplicateReports}) | ${cost} | ${duration(metrics.averageDurationMs)} |`,
    );
  }

  const misses = result.reviewers.flatMap((reviewer) =>
    reviewer.misses.map((miss) => ({ reviewer: reviewer.reviewer, ...miss })),
  );
  if (misses.length > 0) {
    lines.push('', 'Misses:');
    for (const miss of misses) {
      lines.push(
        `- ${plain(miss.reviewer)} · ${plain(miss.caseId)} · ${miss.severity} ` +
          `${plain(miss.expectedId)}: ${plain(miss.title)}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

function evaluateReviewer(cases: BenchmarkCase[], reviewer: string): ReviewerBenchmarkMetrics {
  let caseCount = 0;
  let expected = 0;
  let p0ToP2Expected = 0;
  let reports = 0;
  let validReports = 0;
  let duplicateReports = 0;
  let costUsd = 0;
  let costPartial = false;
  let durationTotal = 0;
  let durationCount = 0;
  const found = new Set<string>();
  const p0ToP2Found = new Set<string>();
  const misses: BenchmarkMiss[] = [];

  for (const item of cases) {
    const run = item.runs.find((candidate) => candidate.reviewer === reviewer);
    if (!run) continue;
    caseCount++;
    expected += item.expected.length;
    p0ToP2Expected += item.expected.filter((finding) => finding.severity !== 'P3').length;
    reports += run.findings.length;

    const expectedById = new Map(item.expected.map((finding) => [finding.id, finding]));
    const foundInCase = new Set<string>();
    const reportKeys = new Set<string>();
    for (const report of run.findings) {
      const reportKey = report.expected_id
        ? `expected:${report.expected_id}`
        : report.duplicate_key
          ? `rejected:${report.duplicate_key}`
          : null;
      if (reportKey) {
        if (reportKeys.has(reportKey)) duplicateReports++;
        reportKeys.add(reportKey);
      }
      if (report.expected_id === null) continue;
      validReports++;
      const key = `${item.id}\u0000${report.expected_id}`;
      foundInCase.add(report.expected_id);
      found.add(key);
      if (expectedById.get(report.expected_id)?.severity !== 'P3') p0ToP2Found.add(key);
    }

    for (const finding of item.expected) {
      if (!foundInCase.has(finding.id)) {
        misses.push({
          caseId: item.id,
          expectedId: finding.id,
          severity: finding.severity,
          title: finding.title,
        });
      }
    }

    if (run.cost_usd === null) costPartial = true;
    else costUsd += run.cost_usd;
    if (run.duration_ms !== null) {
      durationTotal += run.duration_ms;
      durationCount++;
    }
  }

  return {
    reviewer,
    cases: caseCount,
    expected,
    found: found.size,
    recall: ratio(found.size, expected),
    p0ToP2Expected,
    p0ToP2Found: p0ToP2Found.size,
    p0ToP2Recall: ratio(p0ToP2Found.size, p0ToP2Expected),
    reports,
    validReports,
    precision: ratio(validReports, reports),
    duplicateReports,
    duplicateRate: ratio(duplicateReports, reports),
    costUsd,
    costPartial,
    averageDurationMs: durationCount > 0 ? durationTotal / durationCount : null,
    misses,
  };
}

function parseCase(raw: unknown, index: number): BenchmarkCase {
  if (!isRecord(raw)) throw new Error(`benchmark: cases[${index}] must be an object`);
  const id = requiredString(raw['id'], `cases[${index}].id`);
  if (!Array.isArray(raw['expected']) || !Array.isArray(raw['runs'])) {
    throw new Error(`benchmark: case ${id} needs expected[] and runs[]`);
  }
  const expected = raw['expected'].map((value, i) => parseExpected(value, `${id}.expected[${i}]`));
  const expectedIds = new Set<string>();
  for (const finding of expected) {
    if (expectedIds.has(finding.id)) throw new Error(`benchmark: ${id} repeats expected id ${finding.id}`);
    expectedIds.add(finding.id);
  }

  const runs = raw['runs'].map((value, i) => parseRun(value, `${id}.runs[${i}]`, expectedIds));
  const reviewers = new Set<string>();
  for (const run of runs) {
    if (reviewers.has(run.reviewer)) throw new Error(`benchmark: ${id} repeats reviewer ${run.reviewer}`);
    reviewers.add(run.reviewer);
  }

  const url = optionalString(raw['url']);
  return { id, ...(url ? { url } : {}), expected, runs };
}

function parseExpected(raw: unknown, at: string): BenchmarkExpectedFinding {
  if (!isRecord(raw)) throw new Error(`benchmark: ${at} must be an object`);
  return {
    id: requiredString(raw['id'], `${at}.id`),
    severity: severity(raw['severity'], `${at}.severity`),
    title: requiredString(raw['title'], `${at}.title`),
  };
}

function parseRun(raw: unknown, at: string, expectedIds: Set<string>): BenchmarkReviewerRun {
  if (!isRecord(raw) || !Array.isArray(raw['findings'])) {
    throw new Error(`benchmark: ${at} must be an object with findings[]`);
  }
  const reviewer = requiredString(raw['reviewer'], `${at}.reviewer`);
  const findings = raw['findings'].map((value, i) => {
    const findingAt = `${at}.findings[${i}]`;
    if (!isRecord(value)) throw new Error(`benchmark: ${findingAt} must be an object`);
    const expectedId = value['expected_id'];
    if (expectedId !== null && (typeof expectedId !== 'string' || !expectedIds.has(expectedId))) {
      throw new Error(`benchmark: ${findingAt}.expected_id must name an expected finding or be null`);
    }
    return {
      title: requiredString(value['title'], `${findingAt}.title`),
      severity: severity(value['severity'], `${findingAt}.severity`),
      expected_id: expectedId,
      ...(value['duplicate_key'] === undefined || value['duplicate_key'] === null
        ? {}
        : { duplicate_key: requiredString(value['duplicate_key'], `${findingAt}.duplicate_key`) }),
    };
  });
  return {
    reviewer,
    cost_usd: nullableNonNegative(raw['cost_usd'], `${at}.cost_usd`),
    duration_ms: nullableNonNegative(raw['duration_ms'], `${at}.duration_ms`),
    findings,
  };
}

function severity(raw: unknown, at: string): Severity {
  if (typeof raw === 'string' && SEVERITIES.includes(raw as Severity)) return raw as Severity;
  throw new Error(`benchmark: ${at} must be P0, P1, P2, or P3`);
}

function nullableNonNegative(raw: unknown, at: string): number | null {
  if (raw === null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;
  throw new Error(`benchmark: ${at} must be a non-negative number or null`);
}

function requiredString(raw: unknown, at: string): string {
  const value = optionalString(raw);
  if (!value) throw new Error(`benchmark: ${at} must be a non-empty string`);
  return value;
}

function optionalString(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value || null;
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function duration(ms: number | null): string {
  if (ms === null) return 'unknown';
  const seconds = Math.round(ms / 1_000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m${String(rest).padStart(2, '0')}s` : `${rest}s`;
}

function cell(value: string): string {
  return plain(value).replace(/\|/g, '\\|');
}

function plain(value: string): string {
  return redact(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}
