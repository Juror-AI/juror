/** Resolve immutable, post-merge QA input without trusting a PR's stale base.sha. */

import type { GitHubApi, PullMeta } from './client.js';

export type MergedPullGitHubApi = Pick<
  GitHubApi,
  'getCommitParents' | 'getCommitRelationship'
>;

/**
 * Trusted revision identity derived only from immutable commit topology.
 *
 * A multi-commit PR whose merge SHA has one parent is ambiguous: it can be a squash whose first
 * parent is the exact base, or the final commit of a rebase whose first N parents contain PR
 * commits. Callers can evaluate policy at every plausible base while source collection starts at
 * the oldest candidate, which is conservative for either topology.
 */
export interface ResolvedMergedPull {
  mergeSha: string;
  /** Plausible pre-PR bases ordered nearest-to-oldest (M^1 through M^N). */
  policyBaseShas: readonly string[];
  /** Oldest plausible base, used to collect a conservative superset of changed source. */
  sourceBaseSha: string;
  baseResolution: 'exact' | 'conservative';
}

const MAX_BASE_CANDIDATES = 100;

/**
 * GitHub's pull.base.sha can lag the actual target tip at merge time. The merge
 * commit's first parent is authoritative for ordinary merge commits. For an
 * ambiguous one-parent merge, enumerate every base permitted by the PR's
 * bounded commit count. Raw diff equality is deliberately not a trust proof:
 * diff rendering describes content, not the identity of the pre-PR commit.
 */
export async function resolveMergedPull(
  client: MergedPullGitHubApi,
  pull: PullMeta,
): Promise<ResolvedMergedPull> {
  if (!pull.merged || !pull.mergeCommitSha || !/^[0-9a-f]{40}$/i.test(pull.mergeCommitSha)) {
    throw new Error(`PR #${pull.number} has no valid merge commit`);
  }
  const mergeSha = pull.mergeCommitSha.toLowerCase();
  const parents = await client.getCommitParents(mergeSha);
  if (parents.length > 2) {
    throw new Error(`PR #${pull.number} has an unsupported merge commit with ${parents.length} parents`);
  }
  const firstParent = parents[0];
  if (!firstParent) throw new Error(`PR #${pull.number} merge commit has no first parent`);

  if (parents.length === 2) {
    const secondParent = parents[1];
    if (
      !secondParent ||
      !/^[0-9a-f]{40}$/i.test(pull.headSha) ||
      secondParent.toLowerCase() !== pull.headSha.toLowerCase()
    ) {
      throw new Error(
        `PR #${pull.number} has an indirect or unrecognized two-parent merge; ` +
          'post-merge QA requires the captured PR head as the second parent',
      );
    }
    return exactResolution(mergeSha, firstParent);
  }
  if (
    !Number.isSafeInteger(pull.commitCount) ||
    pull.commitCount < 1 ||
    pull.commitCount > MAX_BASE_CANDIDATES
  ) {
    throw new Error(
      `PR #${pull.number} has an invalid or unbounded one-parent history ` +
        `(commit count ${pull.commitCount}); post-merge QA refuses to infer a policy base`,
    );
  }

  if (!/^[0-9a-f]{40}$/i.test(pull.headSha)) {
    throw new Error(`PR #${pull.number} has no valid captured head commit`);
  }
  // GitHub also marks a PR merged when its original head merely becomes reachable from the
  // base branch (for example through another PR or a direct push). Such an indirect merge can
  // have the same one-parent shape as a squash/rebase, but its reported merge SHA is the base
  // tip that happened to make the head reachable. Only a diverged rewritten commit proves the
  // one-parent result is a GitHub-created squash/rebase rather than that indirect case.
  const relationship = await client.getCommitRelationship(pull.headSha, mergeSha);
  if (relationship !== 'diverged') {
    throw new Error(
      `PR #${pull.number} has an indirect or unrecognized one-parent merge ` +
        `(captured-head-to-merge comparison status: ${relationship})`,
    );
  }

  const policyBaseShas = [firstParent];
  let candidate = firstParent;
  for (let depth = 1; depth < pull.commitCount; depth++) {
    const candidateParents = await client.getCommitParents(candidate);
    // Rebased PR commits form a one-parent chain. A root, merge, or octopus candidate cannot be
    // another such commit, so it is the oldest plausible base and bounds the walk early.
    if (candidateParents.length !== 1) break;
    candidate = candidateParents[0]!;
    policyBaseShas.push(candidate);
  }

  return {
    mergeSha,
    policyBaseShas,
    sourceBaseSha: policyBaseShas[policyBaseShas.length - 1]!,
    baseResolution: policyBaseShas.length === 1 ? 'exact' : 'conservative',
  };
}

function exactResolution(mergeSha: string, baseSha: string): ResolvedMergedPull {
  return {
    mergeSha,
    policyBaseShas: [baseSha],
    sourceBaseSha: baseSha,
    baseResolution: 'exact',
  };
}
