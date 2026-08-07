/**
 * Step 6 of the pipeline — the privileged side of §11's trust boundary.
 *
 * Everything below arrived from a model and is treated as attacker-influenced text: it is
 * redacted immediately before it is handed to the API, and no failure here is allowed to
 * take the whole review down. A review that lands as summary-only still tells the author
 * something; a review that throws tells them nothing.
 */

import type { DiffContext, JurorConfig, ReviewResult } from '../types.js';
import type { RollingSpend } from '../cost/rolling.js';
import { renderSummaryComment, STICKY_MARKER } from '../render/summary.js';
import {
  renderFailedComment,
  renderWorkingComment,
  type FailedStatusOptions,
  type WorkingStatusOptions,
} from '../render/status.js';
import { selectInlineComments, type InlineComment } from '../render/inline.js';
import { log, redact } from '../util/log.js';
import { isGitHubApiError, type GitHubApi, type ReviewCommentInput } from './client.js';
import { fingerprint, fingerprintsIn } from './fingerprint.js';

export interface PublishOptions {
  /** `GitHubClient` in production; the interface keeps this unit-testable without a network. */
  client: GitHubApi;
  prNumber: number;
  headSha: string;
  config: JurorConfig;
  version: string;
  rolling?: RollingSpend | null;
  dryRun: boolean;
}

export interface PublishOutcome {
  summaryCommentId: number | null;
  inlinePosted: number;
  degradedToSummary: boolean;
  warnings: string[];
}

export type PublishStatusOptions = Pick<PublishOptions, 'client' | 'prNumber' | 'dryRun'> &
  Omit<WorkingStatusOptions, 'repo' | 'prNumber'>;

export type PublishFailureOptions = Pick<PublishOptions, 'client' | 'prNumber' | 'dryRun'> &
  Omit<FailedStatusOptions, 'repo' | 'prNumber'>;

/** GitHub hard-rejects a comment body over 65536 characters; leave room for the note. */
const MAX_COMMENT_CHARS = 65_000;

/** Create or replace the sticky summary with the live, animated working state. */
export async function publishWorkingComment(o: PublishStatusOptions): Promise<number | null> {
  if (o.dryRun) {
    log.info(`dry run: would upsert the animated working comment on #${o.prNumber}`);
    return null;
  }
  const warnings: string[] = [];
  const id = await upsertSticky(
    o,
    renderWorkingComment({
      repo: o.client.repo,
      prNumber: o.prNumber,
      headSha: o.headSha,
      modelLabels: o.modelLabels,
      version: o.version,
      jobUrl: o.jobUrl ?? null,
    }),
    warnings,
  );
  for (const warning of warnings) log.warn(warning);
  return id;
}

/** Replace a working comment with a terminal failure state without masking the error. */
export async function publishFailureComment(o: PublishFailureOptions): Promise<number | null> {
  if (o.dryRun) return null;
  const warnings: string[] = [];
  const id = await upsertSticky(
    o,
    renderFailedComment({
      repo: o.client.repo,
      prNumber: o.prNumber,
      headSha: o.headSha,
      version: o.version,
      reason: o.reason,
      jobUrl: o.jobUrl ?? null,
    }),
    warnings,
  );
  for (const warning of warnings) log.warn(warning);
  return id;
}

export async function publishReview(r: ReviewResult, o: PublishOptions): Promise<PublishOutcome> {
  const warnings: string[] = [];

  const body = buildSummaryBody(r, o);
  // `modelsRun` is the denominator behind every "3/4 models" badge, and `version` pins the
  // badge SVGs to a tag in our own repo. Omitting them silently renders both wrong.
  const { comments, overflow } = selectInlineComments(r.published, o.config, r.diff, {
    version: o.version,
    modelsRun: r.totals.modelsRun,
  });
  if (overflow.length > 0) {
    warnings.push(
      `${overflow.length} finding(s) could not be placed inline (over the cap or not on a diff line); they appear in the summary only.`,
    );
  }

  if (o.dryRun) {
    log.info(
      `dry run: would upsert the summary comment and post ${comments.length} inline comment(s) on #${o.prNumber}`,
    );
    return {
      summaryCommentId: null,
      inlinePosted: comments.length,
      degradedToSummary: false,
      warnings,
    };
  }

  const summaryCommentId = await upsertSticky(o, body, warnings);
  const fresh = await withoutPreviouslyPosted(o, comments, warnings);
  const inline = fresh.length > 0 ? await postInline(o, fresh, r.diff, warnings) : null;

  return {
    summaryCommentId,
    inlinePosted: inline?.posted ?? 0,
    degradedToSummary: inline?.degraded ?? false,
    warnings,
  };
}

async function withoutPreviouslyPosted(
  o: PublishOptions,
  comments: InlineComment[],
  warnings: string[],
): Promise<InlineComment[]> {
  if (comments.length === 0) return comments;
  try {
    const previous = await o.client.listReviewComments(o.prNumber);
    const seen = new Map<string, { path: string; line: number }[]>();
    for (const comment of previous) {
      if (!comment.user.login.endsWith('[bot]')) continue;
      if (comment.line === null || !comment.path) continue;
      for (const value of fingerprintsIn(comment.body)) {
        const locations = seen.get(value) ?? [];
        locations.push({ path: comment.path, line: comment.line });
        seen.set(value, locations);
      }
    }
    const fresh = comments.filter((comment) => {
      const previousLocations = seen.get(fingerprint(comment.cluster)) ?? [];
      // Title identity alone is deliberately insufficient: two defects in one file can both
      // be called "missing validation". Require the old anchor to remain nearby as well.
      return !previousLocations.some(
        (old) => old.path === comment.path && Math.abs(old.line - comment.line) <= 8,
      );
    });
    const duplicates = comments.length - fresh.length;
    if (duplicates > 0) {
      warnings.push(
        `${duplicates} unchanged finding${duplicates === 1 ? '' : 's'} already had an inline ` +
          'comment and were not posted again.',
      );
    }
    return fresh;
  } catch (error) {
    // Missing dedupe history should never hide a new review. Posting all findings is the
    // high-recall fallback, with an explicit warning that a rerun may duplicate a comment.
    warnings.push(`could not inspect earlier inline findings: ${messageOf(error)}`);
    return comments;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sticky summary
// ─────────────────────────────────────────────────────────────────────────────

function buildSummaryBody(r: ReviewResult, o: PublishOptions): string {
  const body = renderSummaryComment(r, {
    version: o.version,
    headSha: o.headSha,
    repo: o.client.repo,
    prNumber: o.prNumber,
    rolling: o.rolling ?? null,
    config: o.config,
  });
  // The marker is the only way the next run finds this comment instead of posting a second
  // one, so re-add it rather than silently spamming the PR if the renderer ever drops it.
  return body.includes(STICKY_MARKER) ? body : `${STICKY_MARKER}\n${body}`;
}

async function upsertSticky(
  o: Pick<PublishOptions, 'client' | 'prNumber'>,
  body: string,
  warnings: string[],
): Promise<number | null> {
  // Defense in depth. The renderer redacts, but this is the last line of code before the
  // text becomes public, and the text is a paraphrase of whatever a model read in the repo —
  // it can echo back a key it found in a fixture or a .env. A second regex pass is cheap;
  // one leaked key is not.
  const safe = clamp(redact(body), warnings);

  const existing = await o.client.listIssueComments(o.prNumber);
  const stickies = existing
    .filter((c) => c.user.login.endsWith('[bot]') && c.body.includes(STICKY_MARKER))
    .sort((a, b) => b.id - a.id);
  let foundUneditable = false;

  // GitHub lists oldest-first. After a bot identity change, the oldest marker may be an
  // uneditable legacy comment while a newer replacement belongs to the current token.
  for (const sticky of stickies) {
    try {
      await o.client.updateIssueComment(sticky.id, safe);
      log.info(`updated the juror sticky comment (#${sticky.id})`);
      return sticky.id;
    } catch (e) {
      // A different bot can carry the marker, or the comment can disappear between list
      // and update. In either case, create our own instead of losing publication.
      if (!isGitHubApiError(e) || (e.status !== 403 && e.status !== 404)) throw e;
      foundUneditable = true;
    }
  }

  if (foundUneditable) warnings.push('the previous bot summary was not editable; posted a new one');

  const created = await o.client.createIssueComment(o.prNumber, safe);
  log.info(`posted the juror sticky comment (#${created.id})`);
  return created.id;
}

function clamp(body: string, warnings: string[]): string {
  if (body.length <= MAX_COMMENT_CHARS) return body;
  warnings.push("the summary comment was truncated to fit GitHub's comment size limit");
  return `${body.slice(0, MAX_COMMENT_CHARS)}\n\n<sub>Truncated to fit GitHub's comment size limit.</sub>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Batched inline review
// ─────────────────────────────────────────────────────────────────────────────

async function postInline(
  o: PublishOptions,
  comments: InlineComment[],
  diff: DiffContext,
  warnings: string[],
): Promise<{ posted: number; degraded: boolean }> {
  const payload = comments.map(toApiComment);

  try {
    await o.client.createReview(o.prNumber, { commitId: o.headSha, body: '', comments: payload });
    log.info(`posted ${payload.length} inline comment(s) as one review`);
    return { posted: payload.length, degraded: false };
  } catch (e) {
    if (!isGitHubApiError(e) || e.status !== 422) {
      warnings.push(`inline comments were not posted: ${messageOf(e)}`);
      log.warn(`inline review failed, falling back to summary-only: ${messageOf(e)}`);
      return { posted: 0, degraded: true };
    }

    // GitHub validates the review as a unit: one comment on a line outside the diff sinks
    // all twelve. Identify the offenders, drop them, and try once more.
    const offending = findOffendingComments(e, payload, diff);
    const kept = payload.filter((_, i) => !offending.has(i));
    if (offending.size === 0 || kept.length === 0) {
      warnings.push(
        `GitHub rejected the inline review (${messageOf(e)}); the findings appear in the summary instead.`,
      );
      log.warn('inline review rejected with no identifiable offender; summary-only');
      return { posted: 0, degraded: true };
    }

    try {
      await o.client.createReview(o.prNumber, { commitId: o.headSha, body: '', comments: kept });
      warnings.push(
        `${offending.size} inline comment(s) targeted lines GitHub does not consider part of the diff and were dropped; they remain in the summary.`,
      );
      log.info(`posted ${kept.length} inline comment(s) after dropping ${offending.size}`);
      return { posted: kept.length, degraded: false };
    } catch (retryError) {
      warnings.push(
        `GitHub rejected the inline review twice (${messageOf(retryError)}); the findings appear in the summary instead.`,
      );
      log.warn('inline review rejected twice; summary-only');
      return { posted: 0, degraded: true };
    }
  }
}

function toApiComment(c: InlineComment): ReviewCommentInput {
  // Same reasoning as the summary body: redact at the boundary, not upstream of it.
  return { path: c.path, line: c.line, side: c.side, body: redact(c.body) };
}

/**
 * Which comments GitHub choked on.
 *
 * The 422 body is not consistent: sometimes it names an index, sometimes a path, and most
 * often only says "line must be part of the diff" with no pointer at all. Try each in turn,
 * then fall back to our own position map — anything we cannot prove sits on a diff line is
 * the likely offender, and dropping it is cheaper than losing every comment.
 */
function findOffendingComments(
  e: unknown,
  comments: ReviewCommentInput[],
  diff: DiffContext,
): Set<number> {
  const out = new Set<number>();
  const text = errorText(e);

  for (const m of text.matchAll(/comments?\[(\d+)\]/g)) addIndex(out, m[1], comments.length);
  for (const m of text.matchAll(/"index"\s*:\s*(\d+)/g)) addIndex(out, m[1], comments.length);

  comments.forEach((c, i) => {
    if (c.path.length > 0 && text.includes(c.path)) out.add(i);
  });

  if (out.size === 0) {
    comments.forEach((c, i) => {
      if (!isOnDiffLine(c, diff)) out.add(i);
    });
  }

  return out;
}

function addIndex(out: Set<number>, raw: string | undefined, length: number): void {
  if (raw === undefined) return;
  const i = Number(raw);
  if (Number.isInteger(i) && i >= 0 && i < length) out.add(i);
}

function isOnDiffLine(c: ReviewCommentInput, diff: DiffContext): boolean {
  const file = diff.files.find((f) => f.path === c.path);
  if (!file) return false;
  return file.positionByLine.has(c.line) || file.changedLines.includes(c.line);
}

function errorText(e: unknown): string {
  if (isGitHubApiError(e)) return `${e.message}\n${e.rawBody}`;
  return messageOf(e);
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return redact(e.message);
  return typeof e === 'string' ? redact(e) : 'unknown error';
}
