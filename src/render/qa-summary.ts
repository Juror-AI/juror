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
  const job = jobLink ? `\n\n${jobLink}` : '';
  return redactWith([
    `${QA_STICKY_MARKER}\n## ⏳ Juror QA — Finalizing evidence`,
    '> [!NOTE]\n> Browser execution is complete. Juror is sealing the evidence before publishing a verdict.',
    `<details><summary>Run details</summary>\n\n` +
      `- Change scope: ${result.base_resolution}\n` +
      `- Source base: \`${result.source_base_sha.slice(0, 12)}\`\n` +
      `- Run: \`${mdText(result.run_id)}\`${job}\n\n` +
      '</details>',
  ].join('\n\n'), options.secrets ?? []);
}

const OUTCOME_PRESENTATION: Record<QaRunResult['outcome'], {
  icon: string;
  label: string;
  alert: 'NOTE' | 'TIP' | 'WARNING' | 'CAUTION';
  verdict: string;
}> = {
  passed: {
    icon: '✅',
    label: 'Passed',
    alert: 'TIP',
    verdict: 'All planned browser checks passed.',
  },
  no_testable_surface: {
    icon: '➖',
    label: 'Browser QA not applicable',
    alert: 'NOTE',
    verdict: 'Neutral — not scored. No browser was launched because this change has no user-testable surface.',
  },
  flaky: {
    icon: '⚠️',
    label: 'Passed on retry',
    alert: 'WARNING',
    verdict: 'The affected journey passed only after a retry. Review the evidence for instability.',
  },
  advisory: {
    icon: 'ℹ️',
    label: 'Advisory findings',
    alert: 'NOTE',
    verdict: 'Juror recorded findings that are not eligible for a product verdict because of target, range, or policy limitations.',
  },
  product_issue: {
    icon: '❌',
    label: 'Product issue found',
    alert: 'CAUTION',
    verdict: 'Juror reproduced a user-visible issue in an affected product flow.',
  },
  blocked: {
    icon: '⛔',
    label: 'QA blocked',
    alert: 'WARNING',
    verdict: 'No product verdict was produced because Juror could not produce a trustworthy result.',
  },
  infrastructure_error: {
    icon: '🛑',
    label: 'Infrastructure error',
    alert: 'CAUTION',
    verdict: 'No product verdict was produced because the QA runner or evidence pipeline failed.',
  },
  cancelled: {
    icon: '⏹️',
    label: 'Cancelled',
    alert: 'WARNING',
    verdict: 'No product verdict was produced because the QA run was cancelled.',
  },
};

type QaAttempt = QaRunResult['attempts'][number];

function finalAttempts(result: QaRunResult): Map<string, QaAttempt> {
  const final = new Map<string, QaAttempt>();
  for (const attempt of result.attempts) {
    const current = final.get(attempt.scenario_id);
    if (!current || attempt.attempt > current.attempt) final.set(attempt.scenario_id, attempt);
  }
  return final;
}

function scenarioIds(result: QaRunResult, final: ReadonlyMap<string, QaAttempt>): string[] {
  const ids = result.plan?.scenarios.map((scenario) => scenario.id) ?? [];
  for (const id of final.keys()) {
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function scenarioTitle(result: QaRunResult, id: string): string {
  return result.plan?.scenarios.find((scenario) => scenario.id === id)?.title ?? id;
}

function attemptStatus(status: QaAttempt['status'] | null): string {
  switch (status) {
    case 'passed': return '✅ Passed';
    case 'failed': return '❌ Failed';
    case 'blocked': return '⛔ Blocked';
    case 'infrastructure_error': return '🛑 Infrastructure error';
    default: return '➖ Not run';
  }
}

export function renderQaSummary(result: QaRunResult, options: QaRenderOptions = {}): string {
  const outcome = OUTCOME_PRESENTATION[result.outcome];
  const final = finalAttempts(result);
  const ids = scenarioIds(result, final);
  const finalCheckpoints = [...final.values()].flatMap((attempt) => attempt.checkpoints);
  const passedCheckpoints = finalCheckpoints.filter((checkpoint) => checkpoint.status === 'passed').length;
  const executedChecks = finalCheckpoints.length > 0
    ? `${passedCheckpoints}/${finalCheckpoints.length} passed`
    : 'Not run';
  const targetRevision = result.target
    ? `${result.target.kind} · ${result.target.revision.observed_sha
      ? `\`${result.target.revision.observed_sha.slice(0, 12)}\``
      : 'unverified'} (${result.target.revision.relation})`
    : 'not resolved';
  const blocks: string[] = [
    `${QA_STICKY_MARKER}\n## ${outcome.icon} Juror QA — ${outcome.label}`,
    `> [!${outcome.alert}]\n> ${outcome.verdict}`,
  ];

  blocks.push([
    '| Scope | Target revision | Journeys | Executed checks | Duration |',
    '| --- | --- | ---: | ---: | ---: |',
    `| ${mdCell(result.base_resolution)} | ${targetRevision} | ${ids.length} | ${executedChecks} | ${Math.round(result.duration_ms / 1000)}s |`,
  ].join('\n'));

  if (result.plan) {
    blocks.push(`### What changed\n\n${mdText(result.plan.impact_assessment)}`);
    if (result.plan.testability === 'no_testable_surface') {
      blocks.push(
        `### Why browser QA was skipped\n\n${mdText(
          result.plan.no_testable_surface_reason ?? 'No browser scenario was justified.',
        )}`,
      );
    }
  }

  if (result.issues.length > 0) {
    const issueBlocks = result.issues.map((issue) => [
      `#### ${issue.severity} · ${mdText(issue.title)}`,
      `- **Journey:** ${mdText(scenarioTitle(result, issue.scenario_id))} · checkpoint \`${mdText(issue.checkpoint_id)}\``,
      `- **Expected:** ${mdText(issue.expected)}`,
      `- **Observed:** ${mdText(issue.actual)}`,
      `- **Reproduced:** attempt${issue.attempt_numbers.length === 1 ? '' : 's'} ${issue.attempt_numbers.join(' and ')} · ${issue.classification}`,
    ].join('\n\n'));
    const issuesHeading = result.outcome === 'product_issue' &&
      result.issues.some((issue) => issue.classification === 'verified')
      ? 'Product issues'
      : result.outcome === 'advisory' || result.issues.every((issue) => issue.classification === 'advisory')
        ? 'Advisory findings'
        : 'Retained browser findings';
    blocks.push(`### ${issuesHeading}\n\n${issueBlocks.join('\n\n---\n\n')}`);
  }

  if (ids.length > 0 && result.plan?.testability !== 'no_testable_surface') {
    const rows = ['| Journey | Final result | Checks | Attempts |', '| --- | --- | ---: | ---: |'];
    for (const id of ids) {
      const attempt = final.get(id) ?? null;
      const passed = attempt?.checkpoints.filter((checkpoint) => checkpoint.status === 'passed').length ?? 0;
      const attempts = result.attempts.filter((candidate) => candidate.scenario_id === id).length;
      rows.push(
        `| ${mdCell(scenarioTitle(result, id))} | ${attemptStatus(attempt?.status ?? null)} | ` +
          `${attempt ? `${passed}/${attempt.checkpoints.length}` : '—'} | ${attempts} |`,
      );
    }
    blocks.push(`### What Juror tested\n\n${rows.join('\n')}`);
  }

  const unresolved = [...final.entries()].flatMap(([id, attempt]) => attempt.checkpoints
    .filter((checkpoint) => checkpoint.status !== 'passed')
    .map((checkpoint) => ({ id, checkpoint })));
  if (result.outcome === 'blocked' || result.outcome === 'infrastructure_error') {
    let reason: string;
    if (result.cleanup.status === 'failed') {
      reason = `Cleanup failed: ${result.cleanup.error ?? result.cleanup.summary}`;
    } else if (result.target?.stability === 'drifted') {
      reason = 'The deployed target changed while Juror was testing it, so the result could not be trusted.';
    } else if (result.outcome === 'infrastructure_error') {
      reason = 'The QA runner or evidence pipeline could not finalize a trustworthy product result.';
    } else if (unresolved.length > 0) {
      reason = `The final attempt left ${unresolved.length} planned check${unresolved.length === 1 ? '' : 's'} unresolved.`;
    } else {
      reason = 'Juror could not start or complete the planned browser journey.';
    }
    blocks.push(`### Why QA stopped\n\n${mdText(reason)}`);
  } else if (result.outcome === 'cancelled') {
    blocks.push(
      '### Why QA stopped\n\nThe workflow was cancelled before Juror could finalize the planned browser result.',
    );
  }
  if (
    unresolved.length > 0 &&
    (result.outcome === 'blocked' || result.outcome === 'infrastructure_error')
  ) {
    const rows = [
      '| Journey | Check | Result | Expected | Observed |',
      '| --- | --- | --- | --- | --- |',
      ...unresolved.map(({ id, checkpoint }) =>
        `| ${mdCell(scenarioTitle(result, id))} | \`${mdCell(checkpoint.checkpoint_id)}\` | ` +
        `${attemptStatus(checkpoint.status === 'blocked' ? 'blocked' : 'failed')} | ` +
        `${mdCell(checkpoint.expected)} | ${mdCell(checkpoint.observed)} |`),
    ];
    blocks.push(`### Unresolved checks\n\n${rows.join('\n')}`);
  }

  const retryFailures = result.outcome === 'flaky'
    ? result.attempts.flatMap((attempt) => {
      const finalAttempt = final.get(attempt.scenario_id);
      if (!finalAttempt || attempt.attempt >= finalAttempt.attempt) return [];
      return attempt.checkpoints
        .filter((checkpoint) => checkpoint.status !== 'passed')
        .map((checkpoint) => ({ attempt, checkpoint }));
    })
    : [];
  if (retryFailures.length > 0) {
    const rows = [
      '| Journey | Attempt | Check | Result | Observed |',
      '| --- | ---: | --- | --- | --- |',
      ...retryFailures.map(({ attempt, checkpoint }) =>
        `| ${mdCell(scenarioTitle(result, attempt.scenario_id))} | ${attempt.attempt} | ` +
        `\`${mdCell(checkpoint.checkpoint_id)}\` | ` +
        `${attemptStatus(checkpoint.status === 'blocked' ? 'blocked' : 'failed')} | ` +
        `${mdCell(checkpoint.observed)} |`),
    ];
    blocks.push(`<details><summary>Retry history</summary>\n\n${rows.join('\n')}\n\n</details>`);
  }

  const videos = result.artifacts.filter((artifact) => artifact.kind === 'video');
  const evidenceLink = renderQaMarkdownLink(
    videos.length > 0 ? 'View evidence & video' : 'View evidence',
    options.artifactUrl,
  );
  const workflowLink = renderQaMarkdownLink('Open workflow run', options.jobUrl);
  const links = [evidenceLink, workflowLink].filter((link): link is string => Boolean(link));
  const videoRetentionDays = result.artifacts
    .filter((artifact) => artifact.kind === 'video')
    .map((artifact) => artifact.retention_days);
  const videoRetention = videoRetentionDays.length > 0
    ? ` · videos retained for ${Math.min(...videoRetentionDays)} day${Math.min(...videoRetentionDays) === 1 ? '' : 's'}`
    : '';
  if (links.length > 0 || result.artifacts.length > 0) {
    blocks.push(
      `### Evidence\n\n${links.join(' · ')}` +
      `${links.length > 0 ? '\n\n' : ''}` +
      `${result.artifacts.length} artifact${result.artifacts.length === 1 ? '' : 's'} · ` +
      `${videos.length} video${videos.length === 1 ? '' : 's'}${videoRetention}`,
    );
  }

  const cost = result.cost.usd === null ? 'unknown' : `$${result.cost.usd.toFixed(4)}`;
  blocks.push(
    '<details><summary>Run details</summary>\n\n' +
      `- Run: \`${mdText(result.run_id)}\`\n` +
      `- Change scope: ${result.base_resolution} · source base \`${result.source_base_sha.slice(0, 12)}\` · ` +
        `${result.policy_base_shas.length} policy-base candidate${result.policy_base_shas.length === 1 ? '' : 's'}\n` +
      `- Target: ${result.target ? mdText(result.target.kind) : 'not resolved'} · revision ` +
        `${result.target?.revision.observed_sha ? `\`${result.target.revision.observed_sha.slice(0, 12)}\`` : 'unverified'} ` +
        `(${result.target?.revision.relation ?? 'unverified'}) · verdict eligible ` +
        `${result.target?.verdict_eligible ? 'yes' : 'no'}\n` +
      `- Runtime: ${mdText(result.runtime.browser_name)} ${mdText(result.runtime.browser_version)} · ` +
        `${mdText(result.runtime.model_id)} · cost ${cost}\n` +
      `- Cleanup: ${result.cleanup.status} — ${mdText(result.cleanup.summary)}\n` +
      `- Attempts: ${result.attempts.length} · artifacts: ${result.artifacts.length}${videoRetention}\n\n` +
      (result.base_resolution === 'conservative'
        ? 'The tested range can include changes older than this PR, so findings are advisory.\n\n'
        : '') +
      '</details>',
  );
  if (result.warnings.length > 0) {
    blocks.push(`<details><summary>Warnings (${result.warnings.length})</summary>\n\n${result.warnings.map((warning) => `- ${mdText(warning)}`).join('\n')}\n\n</details>`);
  }
  const presentationSecrets = [
    ...(options.secrets ?? []),
    ...(result.target ? [result.target.url, result.target.allowed_origin] : []),
  ];
  return redactWith(blocks.join('\n\n'), presentationSecrets);
}
