/** Idempotent publication of the post-merge QA sticky comment. */

import { isGitHubApiError, type GitHubApi } from './client.js';
import type { QaRunResult } from '../qa/types.js';
import { redact } from '../util/log.js';
import {
  QA_STICKY_MARKER,
  renderQaPending,
  renderQaSummary,
  type QaRenderOptions,
} from '../render/qa-summary.js';

const MAX_COMMENT_CHARS = 65_000;

export function qaPublicationAllowed(requested: boolean, cancelled: boolean): boolean {
  return requested && !cancelled;
}

export async function publishQaResult(
  client: Pick<GitHubApi, 'listIssueComments' | 'updateIssueComment' | 'createIssueComment'>,
  prNumber: number,
  result: QaRunResult,
  options: QaRenderOptions = {},
): Promise<{ commentId: number; updated: boolean }> {
  return publishQaComment(client, prNumber, renderQaSummary(result, options));
}

export async function publishQaPending(
  client: Pick<GitHubApi, 'listIssueComments' | 'updateIssueComment' | 'createIssueComment'>,
  prNumber: number,
  result: QaRunResult,
  options: QaRenderOptions = {},
): Promise<{ commentId: number; updated: boolean }> {
  return publishQaComment(client, prNumber, renderQaPending(result, options));
}

async function publishQaComment(
  client: Pick<GitHubApi, 'listIssueComments' | 'updateIssueComment' | 'createIssueComment'>,
  prNumber: number,
  rendered: string,
): Promise<{ commentId: number; updated: boolean }> {
  const safe = redact(rendered).slice(0, MAX_COMMENT_CHARS);
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
