/** Resolve PR-mode configuration without trusting bytes from the merged checkout. */

import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  CONFIG_FILENAMES,
  defaultConfig,
  loadConfig,
  loadConfigText,
} from '../config.js';
import { unsafeQaConfigProblems } from './config.js';
import {
  readFilesAtCommit,
  type CheckoutPromisorAccess,
} from '../util/worktree.js';

export type LoadedTrustedConfig = ReturnType<typeof loadConfig>;
const MAX_TRUSTED_CONFIG_BYTES = 256 * 1024;

export interface TrustedQaConfigConsensusOptions {
  /** A forced run consumes disabled policy fields, so those fields must also agree. */
  force?: boolean;
  promisor?: CheckoutPromisorAccess;
  /** Cancel trusted-blob hydration when the owning QA command is terminating. */
  signal?: AbortSignal;
}

interface LoadedTrustedConfigDetails {
  loaded: LoadedTrustedConfig;
  baseAvailable: boolean;
  explicitMissing: boolean;
  unreadablePaths: readonly string[];
  oversizedPaths: readonly string[];
}

function relativeInside(repository: string, candidate: string): string | null {
  const relative = path.relative(repository, candidate);
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return relative.replaceAll(path.sep, '/');
}

/**
 * Load repository-owned configuration from the trusted PR base. An explicit path is
 * repository-owned when either its lexical location or its resolved symlink target is
 * inside the physical repository. Only a path that remains outside by both measures is
 * accepted as an operator-owned override.
 */
export async function loadConfigFromBase(
  repoDir: string,
  baseSha: string,
  overridePath: string | null,
  promisor?: CheckoutPromisorAccess,
  signal?: AbortSignal,
): Promise<LoadedTrustedConfig> {
  return (await loadConfigFromBaseDetailed(repoDir, baseSha, overridePath, promisor, signal)).loaded;
}

async function loadConfigFromBaseDetailed(
  repoDir: string,
  baseSha: string,
  overridePath: string | null,
  promisor?: CheckoutPromisorAccess,
  signal?: AbortSignal,
): Promise<LoadedTrustedConfigDetails> {
  signal?.throwIfAborted();
  const physicalRepo = await realpath(repoDir).catch(() => path.resolve(repoDir));
  let relativeOverride: string | null = null;
  if (overridePath) {
    const lexicalOverride = path.resolve(overridePath);
    relativeOverride = relativeInside(physicalRepo, lexicalOverride);
    let resolvedOverride: string | null = null;
    if (!relativeOverride) {
      resolvedOverride = await realpath(lexicalOverride).catch(() => null);
      if (resolvedOverride) relativeOverride = relativeInside(physicalRepo, resolvedOverride);
    }
    if (!relativeOverride) {
      const loaded = loadConfig(physicalRepo, resolvedOverride ?? lexicalOverride);
      return {
        loaded,
        // An operator-owned override does not depend on a repository commit being local.
        baseAvailable: true,
        explicitMissing: loaded.sourcePath === null,
        unreadablePaths: [],
        oversizedPaths: [],
      };
    }
  }

  const candidates = relativeOverride ? [relativeOverride] : CONFIG_FILENAMES;
  let snapshot;
  try {
    snapshot = await readFilesAtCommit(physicalRepo, baseSha, candidates, {
      ...(promisor ? { promisor } : {}),
      ...(signal ? { signal } : {}),
      maxFileBytes: MAX_TRUSTED_CONFIG_BYTES,
    });
  } catch {
    signal?.throwIfAborted();
    snapshot = {
      files: new Map<string, string>(),
      commitAvailable: false,
      unreadablePaths: [],
      oversizedPaths: [],
    };
  }
  for (const name of candidates) {
    const contents = snapshot.files.get(name);
    if (contents !== undefined) {
      return {
        loaded: loadConfigText(contents, `${name}@${baseSha.slice(0, 12)}`),
        baseAvailable: snapshot.commitAvailable,
        explicitMissing: false,
        unreadablePaths: [],
        oversizedPaths: [],
      };
    }
    if (snapshot.oversizedPaths.includes(name)) {
      return {
        loaded: {
          config: defaultConfig(),
          problems: [
            `trusted config ${name} at base ${baseSha.slice(0, 12)} exceeds ` +
              `${MAX_TRUSTED_CONFIG_BYTES} bytes; using defaults`,
          ],
          sourcePath: null,
        },
        baseAvailable: snapshot.commitAvailable,
        explicitMissing: false,
        unreadablePaths: [],
        oversizedPaths: [name],
      };
    }
    if (snapshot.unreadablePaths.includes(name)) {
      return {
        loaded: {
          config: defaultConfig(),
          problems: [
            `could not read trusted config ${name} at base ${baseSha.slice(0, 12)}; using defaults`,
          ],
          sourcePath: null,
        },
        baseAvailable: snapshot.commitAvailable,
        explicitMissing: false,
        unreadablePaths: [name],
        oversizedPaths: [],
      };
    }
  }
  if (relativeOverride && snapshot.commitAvailable) {
    return {
      loaded: {
        config: defaultConfig(),
        problems: [`trusted config ${relativeOverride} does not exist at the PR base; using defaults`],
        sourcePath: null,
      },
      baseAvailable: true,
      explicitMissing: true,
      unreadablePaths: [],
      oversizedPaths: [],
    };
  }
  return {
    loaded: {
      config: defaultConfig(),
      problems:
        snapshot.commitAvailable
          ? []
          : [`base revision ${baseSha.slice(0, 12)} is unavailable locally; using secure defaults`],
      sourcePath: null,
    },
    baseAvailable: snapshot.commitAvailable,
    explicitMissing: false,
    unreadablePaths: [],
    oversizedPaths: [],
  };
}

/**
 * Establish one fail-closed QA policy across every base allowed by the merge topology.
 *
 * Candidate loading is deliberately exhaustive: a disabled/default result from one base must
 * not hide an unavailable or malformed alternative. Disabled policies may disagree in dormant
 * fields only for a non-forced run, where none of those fields can be consumed.
 */
export async function loadQaConfigConsensusFromBases(
  repoDir: string,
  baseShas: readonly string[],
  overridePath: string | null,
  options: TrustedQaConfigConsensusOptions = {},
): Promise<LoadedTrustedConfig> {
  const candidates = [...new Set(baseShas.map((sha) => sha.toLowerCase()))];
  if (candidates.length === 0) {
    throw new Error('Trusted QA policy has no candidate base revisions');
  }
  if (candidates.some((sha) => !/^[0-9a-f]{40}$/.test(sha))) {
    throw new Error('Trusted QA policy candidate bases must be full GitHub commit SHAs');
  }

  // Do not reject while loading: every topology branch must contribute to the trust decision.
  const loaded: Array<{ sha: string; details: LoadedTrustedConfigDetails }> = [];
  for (const sha of candidates) {
    loaded.push({
      sha,
      details: await loadConfigFromBaseDetailed(
        repoDir,
        sha,
        overridePath,
        options.promisor,
        options.signal,
      ),
    });
  }

  const failures: string[] = [];
  for (const { sha, details } of loaded) {
    const label = sha.slice(0, 12) || '(empty)';
    if (!details.baseAvailable) {
      failures.push(`candidate base ${label} is unavailable`);
      continue;
    }
    if (details.explicitMissing) {
      failures.push(`candidate base ${label} cannot load the explicit trusted config`);
      continue;
    }
    if (details.unreadablePaths.length > 0) {
      failures.push(
        `candidate base ${label} cannot read trusted config ${details.unreadablePaths.join(', ')}`,
      );
      continue;
    }
    if (details.oversizedPaths.length > 0) {
      failures.push(
        `candidate base ${label} has trusted config above the ` +
          `${MAX_TRUSTED_CONFIG_BYTES}-byte limit: ${details.oversizedPaths.join(', ')}`,
      );
      continue;
    }

    const invalid = details.loaded.problems.filter((problem) =>
      problem.includes(' is not valid YAML:') ||
      problem.includes(' must be a YAML mapping at the top level') ||
      problem.startsWith('could not read ') ||
      problem.startsWith('version: expected 1,'),
    );
    for (const problem of invalid) failures.push(`candidate base ${label}: ${problem}`);
    for (const problem of unsafeQaConfigProblems(details.loaded.problems)) {
      failures.push(`candidate base ${label}: ${problem}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Trusted QA policy is unsafe:\n- ${failures.join('\n- ')}`);
  }

  const enabled = new Set(loaded.map(({ details }) => details.loaded.config.qa.enabled));
  if (enabled.size !== 1) {
    throw new Error('Trusted QA policy candidates disagree on qa.enabled');
  }

  const first = loaded[0]!.details.loaded;
  const allDisabled = first.config.qa.enabled === false;
  if (!allDisabled || options.force === true) {
    const conflict = loaded.slice(1).find(
      ({ details }) => !isDeepStrictEqual(first.config.qa, details.loaded.config.qa),
    );
    if (conflict) {
      throw new Error(
        `Trusted QA policy candidates disagree on parsed qa configuration ` +
          `(first conflict at ${conflict.sha.slice(0, 12)})`,
      );
    }
  }

  return first;
}
