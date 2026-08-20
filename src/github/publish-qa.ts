/** Idempotent publication of the post-merge QA sticky comment. */

import { isGitHubApiError, type GitHubApi } from './client.js';
import type { QaRunResult } from '../qa/types.js';
import { isQaRunResult } from '../qa/result-validator.js';
import { redact } from '../util/log.js';
import {
  MAX_QA_COMMENT_CHARS,
  QA_STICKY_MARKER,
  containsQaPresentationSecret,
  renderQaPending,
  renderQaSummary,
  type QaRenderOptions,
} from '../render/qa-summary.js';

export function qaPublicationAllowed(requested: boolean, cancelled: boolean): boolean {
  return requested && !cancelled;
}

export async function publishQaResult(
  client: Pick<GitHubApi, 'repo' | 'listIssueComments' | 'updateIssueComment' | 'createIssueComment'>,
  prNumber: number,
  result: QaRunResult,
  options: QaRenderOptions = {},
): Promise<{ commentId: number; updated: boolean }> {
  assertPublishableQaResult(result);
  assertPublicationIdentity(client.repo, prNumber, result);
  return publishQaComment(
    client,
    prNumber,
    renderQaSummary(result, options),
    options.secrets ?? [],
  );
}

export async function publishQaPending(
  client: Pick<GitHubApi, 'repo' | 'listIssueComments' | 'updateIssueComment' | 'createIssueComment'>,
  prNumber: number,
  result: QaRunResult,
  options: QaRenderOptions = {},
): Promise<{ commentId: number; updated: boolean }> {
  assertPublishableQaResult(result);
  assertPublicationIdentity(client.repo, prNumber, result);
  return publishQaComment(
    client,
    prNumber,
    renderQaPending(result, options),
    options.secrets ?? [],
  );
}

/** The public publisher can be called without the persisted-artifact CLI path. */
function assertPublishableQaResult(result: QaRunResult): void {
  if (!isQaRunResult(result)) throw new Error('Refusing to publish an invalid QA result');
}

function assertPublicationIdentity(repository: string, prNumber: number, result: QaRunResult): void {
  if (result.repository.toLowerCase() !== repository.toLowerCase()) {
    throw new Error('Refusing to publish a QA result for a different repository');
  }
  if (result.pr_number !== prNumber) {
    throw new Error('Refusing to publish a QA result for a different pull request');
  }
}

async function publishQaComment(
  client: Pick<GitHubApi, 'listIssueComments' | 'updateIssueComment' | 'createIssueComment'>,
  prNumber: number,
  rendered: string,
  exactSecrets: readonly string[],
): Promise<{ commentId: number; updated: boolean }> {
  if (containsQaPresentationSecret(rendered, exactSecrets)) {
    throw new Error('Refusing to publish QA Markdown containing a configured secret canary');
  }
  const safe = redact(rendered);
  if (containsQaPresentationSecret(safe, exactSecrets)) {
    throw new Error('Refusing to publish QA Markdown containing a configured secret canary');
  }
  if (safe.length > MAX_QA_COMMENT_CHARS) {
    throw new Error('QA Markdown renderer exceeded the GitHub comment limit');
  }
  const existing = (await client.listIssueComments(prNumber))
    .filter((comment) => comment.user.login.endsWith('[bot]') && comment.body.includes(QA_STICKY_MARKER))
    .sort((a, b) => b.id - a.id);
  for (const comment of existing) {
    try {
      await client.updateIssueComment(comment.id, safe);
      return { commentId: comment.id, updated: true };
    } catch (error) {
      // A prior bot identity may own the marker. Create one owned by the current token.
      // Network failures, throttling, and server errors must stop publication; otherwise
      // a transient update failure can create a duplicate sticky.
      if (!isGitHubApiError(error) || (error.status !== 403 && error.status !== 404)) throw error;
    }
  }
  const created = await client.createIssueComment(prNumber, safe);
  return { commentId: created.id, updated: false };
}
