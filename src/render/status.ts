/**
 * Transient GitHub status comments shown while a posted review is running.
 *
 * The working state deliberately shares the summary marker: GitHub sees one sticky
 * comment that changes from "working" to the finished review instead of two permanent
 * comments. The spinner is the same small GitHub-hosted asset used by Claude Code Action's
 * official progress tracker, so it renders through GitHub's comment sanitizer and proxy.
 */

import { redact } from '../util/log.js';
import { mdCell, mdText, STICKY_MARKER } from './summary.js';

export const WORKING_SPINNER_HTML =
  '<img src="https://github.com/user-attachments/assets/5ac382c7-e004-429b-8e35-7feb3e8f9c6f" width="14px" height="14px" alt="" style="vertical-align: middle; margin-left: 4px;" />';

export interface WorkingStatusOptions {
  repo: string;
  prNumber: number;
  headSha: string;
  modelLabels: string[];
  version: string;
  jobUrl?: string | null;
}

export interface FailedStatusOptions {
  repo: string;
  prNumber: number;
  headSha: string;
  version: string;
  reason: string;
  jobUrl?: string | null;
}

export function renderWorkingComment(o: WorkingStatusOptions): string {
  const count = o.modelLabels.length;
  const models = count > 0
    ? o.modelLabels.map(code).join(' · ')
    : 'No reviewer credentials were detected yet';
  const noun = count === 1 ? 'juror is' : 'jurors are';

  return [
    STICKY_MARKER,
    `### Juror is reviewing… ${WORKING_SPINNER_HTML}`,
    '',
    count > 0
      ? `${count} independent ${noun} reading the diff and repository context. This comment will update in place when the review is ready.`
      : 'Juror is preparing the review. This comment will update in place when the run finishes.',
    '',
    '- [x] Diff collected',
    '- [ ] Reviewers inspecting the changed code and its callers',
    '- [ ] Similar findings deduplicated across models',
    '- [ ] Summary and inline comments published',
    '',
    `<sub>${models} · ${targetLinks(o)}</sub>`,
  ].join('\n');
}

export function renderFailedComment(o: FailedStatusOptions): string {
  const reason = mdText(o.reason).replace(/\s+/g, ' ').slice(0, 600) || 'unknown error';
  return [
    STICKY_MARKER,
    '### Juror review stopped',
    '',
    'The review could not complete, so no final findings were posted.',
    '',
    `<sub>${targetLinks(o)} · ${reason}</sub>`,
  ].join('\n');
}

function targetLinks(o: WorkingStatusOptions | FailedStatusOptions): string {
  const repo = safeRepo(o.repo);
  const sha = /^[0-9a-f]{7,40}$/i.test(o.headSha) ? o.headSha : '';
  const short = sha.slice(0, 7) || 'unknown';
  const base = `https://github.com/${repo}`;
  const parts = [
    `Juror ${safePlain(o.version)}`,
    `[PR #${o.prNumber}](${base}/pull/${o.prNumber})`,
    sha ? `reviewing [\`${short}\`](${base}/commit/${sha})` : `reviewing \`${short}\``,
  ];
  const jobUrl = safeUrl(o.jobUrl);
  if (jobUrl) parts.push(`[view run](${jobUrl})`);
  return parts.join(' · ');
}

function code(value: string): string {
  return `\`${mdCell(value).replace(/`/g, '\\`')}\``;
}

function safeRepo(value: string): string {
  const cleaned = redact(value).replace(/[^A-Za-z0-9_.\-/]/g, '');
  return /^[^/]+\/[^/]+$/.test(cleaned) ? cleaned : 'unknown/unknown';
}

function safePlain(value: string): string {
  return redact(value).replace(/[^A-Za-z0-9_.+-]/g, '').slice(0, 40) || 'unknown';
}

function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}
