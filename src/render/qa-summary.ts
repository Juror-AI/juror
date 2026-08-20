/** Human-readable post-merge QA report for the workflow summary and PR sticky. */

import type { QaRunResult } from '../qa/types.js';
import { redactWith } from '../util/log.js';
import { mdCell, mdText } from './summary.js';

export const QA_STICKY_MARKER = '<!-- juror:qa:v1 -->';

export interface QaRenderOptions {
  jobUrl?: string | null;
  artifactUrl?: string | null;
  /** Exact controller-held values to remove at the final presentation boundary. */
  secrets?: readonly string[];
}

/**
 * Render one external URL without letting URL path characters terminate the
 * CommonMark destination and introduce a second link. Invalid or credentialed
 * URLs deliberately produce no active link.
 */
export function renderQaMarkdownLink(
  label: string,
  rawUrl: string | null | undefined,
): string | null {
  if (!rawUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username ||
    parsed.password
  ) {
    return null;
  }
  // URL#toString normalizes whitespace and encodes angle brackets. Preserve
  // brackets that delimit an IPv6 host, but encode CommonMark delimiters in the
  // path/query/fragment so an adversarial deployment URL cannot introduce a
  // second link.
  const normalized = parsed.toString();
  const authority = `${parsed.protocol}//${parsed.host}`;
  const destination = authority + normalized.slice(authority.length).replace(
    /[\\()[\]]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `[${mdText(label)}](${destination})`;
}

/** A non-final sticky used while the immutable semantic result is still being committed. */
export function renderQaPending(result: QaRunResult, options: QaRenderOptions = {}): string {
  const jobLink = renderQaMarkdownLink('Open the QA workflow run', options.jobUrl);
  const job = jobLink ? `\n\n${jobLink}.` : '';
  return redactWith([
    `${QA_STICKY_MARKER}\n### Juror QA — Finalizing evidence`,
    'Browser execution is complete, but this result is not final yet. Juror is committing the immutable report artifact before publishing the verdict.',
    `**Change scope:** ${result.base_resolution} · source base \`${result.source_base_sha.slice(0, 12)}\``,
    `<sub>Run \`${mdText(result.run_id)}\`${job}</sub>`,
  ].join('\n\n'), options.secrets ?? []);
}

const OUTCOME_LABELS: Record<QaRunResult['outcome'], string> = {
  passed: 'Passed',
  no_testable_surface: 'Neutral — no testable browser surface',
  flaky: 'Flaky — passed on retry',
  advisory: 'Advisory findings',
  product_issue: 'Product issue found',
  blocked: 'Blocked',
  infrastructure_error: 'Infrastructure error',
  cancelled: 'Cancelled',
};

export function renderQaSummary(result: QaRunResult, options: QaRenderOptions = {}): string {
  const blocks: string[] = [
    `${QA_STICKY_MARKER}\n### Juror QA — ${OUTCOME_LABELS[result.outcome]}`,
  ];
  blocks.push(
    `**Change scope:** ${result.base_resolution} · source base ` +
      `\`${result.source_base_sha.slice(0, 12)}\` · ` +
      `${result.policy_base_shas.length} policy-base candidate${result.policy_base_shas.length === 1 ? '' : 's'}` +
      (result.base_resolution === 'conservative'
        ? ' · findings are advisory because the range can include earlier changes'
        : ''),
  );
  if (result.target) {
    const sha = result.target.revision.observed_sha?.slice(0, 12) ?? 'unverified';
    const target = renderQaMarkdownLink(result.target.kind, result.target.url) ??
      mdText(result.target.kind);
    blocks.push(
      [
        `**Target:** ${target}`,
        `**Revision:** \`${sha}\` (${result.target.revision.relation})`,
        `**Verdict eligible:** ${result.target.verdict_eligible ? 'yes' : 'no — findings are advisory'}`,
      ].join(' · '),
    );
  }

  if (result.plan) {
    blocks.push(`**Impact:** ${mdText(result.plan.impact_assessment)}`);
    if (result.plan.testability === 'no_testable_surface') {
      blocks.push('**QA verdict:** Neutral (not scored)');
      blocks.push(mdText(result.plan.no_testable_surface_reason ?? 'No browser scenario was justified.'));
    } else if (result.plan.scenarios.length > 0) {
      const rows = ['| Scenario | Attempt | Result | Checkpoints |', '| --- | ---: | --- | --- |'];
      for (const attempt of result.attempts) {
        const scenario = result.plan.scenarios.find((item) => item.id === attempt.scenario_id);
        const passed = attempt.checkpoints.filter((item) => item.status === 'passed').length;
        rows.push(
          `| ${mdCell(scenario?.title ?? attempt.scenario_id)} | ${attempt.attempt} | ${attempt.status} | ${passed}/${attempt.checkpoints.length} passed |`,
        );
      }
      blocks.push(`#### Scenarios\n\n${rows.join('\n')}`);
    }
  }

  if (result.issues.length > 0) {
    const issueBlocks = result.issues.map((issue) => [
      `**${issue.severity}: ${mdText(issue.title)}**`,
      `Expected: ${mdText(issue.expected)}`,
      `Observed: ${mdText(issue.actual)}`,
      `Scenario \`${issue.scenario_id}\`, checkpoint \`${issue.checkpoint_id}\`, attempts ${issue.attempt_numbers.join(' and ')}.`,
    ].join('\n\n'));
    blocks.push(`#### Issues\n\n${issueBlocks.join('\n\n---\n\n')}`);
  }

  const evidenceLink = renderQaMarkdownLink('Evidence and videos', options.artifactUrl) ??
    renderQaMarkdownLink('Workflow run', options.jobUrl) ??
    '';
  const videoRetentionDays = result.artifacts
    .filter((artifact) => artifact.kind === 'video')
    .map((artifact) => artifact.retention_days);
  const videoRetention = videoRetentionDays.length > 0
    ? `Videos retained for ${Math.min(...videoRetentionDays)} day${Math.min(...videoRetentionDays) === 1 ? '' : 's'}. `
    : '';
  const footer = [
    `${result.attempts.length} attempt${result.attempts.length === 1 ? '' : 's'}`,
    `${result.artifacts.filter((artifact) => artifact.kind === 'video').length} video${result.artifacts.filter((artifact) => artifact.kind === 'video').length === 1 ? '' : 's'}`,
    `cleanup ${result.cleanup.status}`,
    `${Math.round(result.duration_ms / 1000)}s`,
  ];
  blocks.push(
    `${evidenceLink ? `${evidenceLink} · ` : ''}${footer.join(' · ')}\n\n` +
      `<sub>Run \`${mdText(result.run_id)}\` · ${videoRetention}` +
      (result.base_resolution === 'conservative'
        ? 'The tested range can include changes older than this PR; findings are advisory.</sub>'
        : 'Issues are reported as found while validating this PR; staging may contain later commits.</sub>'),
  );
  if (result.warnings.length > 0) {
    blocks.push(`<details><summary>Warnings (${result.warnings.length})</summary>\n\n${result.warnings.map((warning) => `- ${mdText(warning)}`).join('\n')}\n\n</details>`);
  }
  return redactWith(blocks.join('\n\n'), options.secrets ?? []);
}
