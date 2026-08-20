/**
 * Ephemeral checkouts.
 *
 * The whole premise is that the agent greps the repo rather than reading a diff in isolation
 * — which only works if the repo on disk is at the PR's head commit. In Actions that is free
 * (`actions/checkout` already put you there). Locally it is not: `juror review --pr 1234`
 * from a branch you happen to be on would have every model reading the wrong code and
 * confidently reporting on functions the PR already changed.
 *
 * Every review uses a detached `git worktree`, even when the source checkout already points
 * at the requested SHA. Besides making the bytes deterministic, this keeps untracked local
 * files such as `.env` outside every model's read root. Local working-tree reviews can copy
 * their tracked/staged patch into that clean view without copying unrelated untracked files.
 */

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { run, runOrThrow } from './proc.js';
import { log } from './log.js';

const BROKER_PROMISOR_REMOTE = 'juror-promisor';

export interface EphemeralCheckout {
  dir: string;
  /** True when we created a worktree that must be torn down. */
  ephemeral: boolean;
  /**
   * Produce the complete committed textual patch from a materialized base to this checkout's head.
   * This must be called before `seal()` removes the controller-owned Git pointer.
   */
  diffFrom(baseSha: string, maxBytes: number): Promise<string>;
  /** Complete committed path inventory, independent from textual patch rendering. */
  changedPathsFrom(baseSha: string, maxBytes: number): Promise<string[]>;
  /** Remove the worktree's Git-metadata pointer before model execution. */
  seal(): Promise<void>;
  cleanup(): Promise<void>;
}

export interface CheckoutPromisorAccess {
  /** Controller-trusted canonical repository URL, never a value read from source Git config. */
  url: string;
  /** GitHub token used only through ephemeral Git config in the child environment. */
  token?: string | null;
  /** Test/local-fixture escape hatch; production callers use HTTPS only. */
  allowFile?: boolean;
}

export interface CommitFileSnapshot {
  files: ReadonlyMap<string, string>;
  commitAvailable: boolean;
  /** Requested paths whose existence or contents could not be established safely. */
  unreadablePaths: readonly string[];
  /** Requested blobs that exceeded the caller's strict byte limit and were never read. */
  oversizedPaths: readonly string[];
}

export interface CommitFileReadOptions {
  promisor?: CheckoutPromisorAccess;
  signal?: AbortSignal;
  /** Reject a blob from tree metadata before reading it. */
  maxFileBytes?: number;
}

/** Parse Git's NUL-delimited name/status stream without quadratic duplicate checks. */
export function parseChangedPathManifest(stdout: string): string[] {
  const fields = stdout.split('\0');
  if (fields[fields.length - 1] === '') fields.pop();
  const changed: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status || !/^[A-Z][0-9]*$/.test(status)) {
      throw new Error('Git returned a malformed changed-path manifest');
    }
    const count = status.startsWith('R') || status.startsWith('C') ? 2 : 1;
    for (let pathIndex = 0; pathIndex < count; pathIndex++) {
      const candidate = fields[index++];
      if (!candidate || candidate.includes('\0')) {
        throw new Error('Git returned a malformed changed-path manifest');
      }
      if (!seen.has(candidate)) {
        seen.add(candidate);
        changed.push(candidate);
      }
    }
  }
  return changed;
}

/**
 * Git normally inherits every controller credential plus the operator's global and
 * environment-injected configuration. The commands that materialize an untrusted tree need
 * neither. Start with an empty child environment, then restore only process-launch basics and
 * point every Git configuration source at controller-owned empty locations.
 */
function isolatedGitEnvironment(
  homeDir: string,
  globalConfig: string,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const name of Object.keys(process.env)) env[name] = undefined;

  for (const name of [
    'PATH',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'SystemRoot',
    'SYSTEMROOT',
    'ComSpec',
    'COMSPEC',
    'PATHEXT',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }

  env['HOME'] = homeDir;
  env['XDG_CONFIG_HOME'] = homeDir;
  env['GIT_CONFIG_NOSYSTEM'] = '1';
  env['GIT_CONFIG_GLOBAL'] = globalConfig;
  env['GIT_TERMINAL_PROMPT'] = '0';
  env['GIT_PAGER'] = 'cat';
  return env;
}

function safePromisorUrl(raw: string, allowFile: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Partial-clone remote must be an absolute URL');
  }
  if (url.protocol !== 'https:' && !(allowFile && url.protocol === 'file:')) {
    throw new Error('Partial-clone remote must use HTTPS');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Partial-clone remote cannot contain credentials, a query, or a fragment');
  }
  return url.toString();
}

/**
 * Expose a controller-trusted promisor only in the child environment. Nothing credentialed
 * is written to argv or the temporary repository config, and nested Git fetches inherit the
 * same deny-by-default protocol and empty global configuration.
 */
function promisorGitEnvironment(
  base: Record<string, string | undefined>,
  access: CheckoutPromisorAccess,
  templates: string,
): Record<string, string | undefined> {
  const url = safePromisorUrl(access.url, access.allowFile ?? false);
  const entries: Array<[string, string]> = [
    ['core.hooksPath', templates],
    ['core.fsmonitor', 'false'],
    ['credential.helper', ''],
    ['maintenance.auto', 'false'],
    ['protocol.allow', 'never'],
    ['protocol.https.allow', 'always'],
    ['extensions.partialClone', BROKER_PROMISOR_REMOTE],
    [`remote.${BROKER_PROMISOR_REMOTE}.url`, url],
    [`remote.${BROKER_PROMISOR_REMOTE}.promisor`, 'true'],
    [`remote.${BROKER_PROMISOR_REMOTE}.partialCloneFilter`, 'blob:none'],
  ];
  if (access.allowFile && new URL(url).protocol === 'file:') {
    entries.push(['protocol.file.allow', 'always']);
  }
  const token = access.token?.trim();
  if (token) {
    entries.push([
      `http.${url}.extraHeader`,
      `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    ]);
  }
  const env: Record<string, string | undefined> = {
    ...base,
    GIT_CONFIG_COUNT: String(entries.length),
  };
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

async function resolveGitPath(
  repoDir: string,
  name: string,
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<string> {
  const raw = (
    await runOrThrow(['git', '--no-pager', 'rev-parse', '--git-path', name], {
      cwd: repoDir,
      env,
      timeoutMs: 30_000,
      ...(signal ? { signal } : {}),
    })
  ).trim();
  if (!raw) throw new Error(`Git did not resolve its ${name} path`);
  return path.resolve(repoDir, raw);
}

function validateFullSha(sha: string, label: string): void {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)) {
    throw new Error(`${label} must be a full SHA`);
  }
}

/**
 * Read a small set of blobs without ever consulting the tested repository's remotes,
 * credential helpers, hooks, or transport settings. A controller-trusted promisor can fill
 * missing partial-clone objects, but its URL and token exist only in child-process config.
 */
export async function readFilesAtCommit(
  repoDir: string,
  sha: string,
  requestedPaths: readonly string[],
  options: CommitFileReadOptions = {},
): Promise<CommitFileSnapshot> {
  const { promisor, signal } = options;
  signal?.throwIfAborted();
  const maxFileBytes = options.maxFileBytes ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) {
    throw new Error('Commit file byte limit must be a positive safe integer');
  }
  validateFullSha(sha, 'Commit');
  const paths = [...new Set(requestedPaths)];
  for (const candidate of paths) {
    if (
      !candidate ||
      candidate.includes('\0') ||
      candidate.includes('\n') ||
      candidate.includes('\r') ||
      path.posix.isAbsolute(candidate) ||
      candidate.split('/').includes('..')
    ) {
      throw new Error('Commit file path must be a normalized repository-relative path');
    }
  }

  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'juror-read-')));
  const broker = path.join(dir, 'repository.git');
  const homeDir = path.join(dir, 'home');
  const templates = path.join(dir, 'templates');
  const globalConfig = path.join(dir, 'global.gitconfig');
  try {
    await Promise.all([
      mkdir(homeDir, { mode: 0o700 }),
      mkdir(templates, { mode: 0o700 }),
      writeFile(globalConfig, '', { encoding: 'utf8', mode: 0o600 }),
    ]);
    const gitEnv = isolatedGitEnvironment(homeDir, globalConfig);
    const sourceObjects = await realpath(await resolveGitPath(repoDir, 'objects', gitEnv, signal));
    if (sourceObjects.includes('\n') || sourceObjects.includes('\r')) {
      throw new Error('Git object directory contains a newline and cannot be shared safely');
    }
    const formatProbe = await run(['git', '--no-pager', 'rev-parse', '--show-object-format'], {
      cwd: repoDir,
      env: gitEnv,
      timeoutMs: 30_000,
      ...(signal ? { signal } : {}),
    });
    signal?.throwIfAborted();
    const objectFormat = formatProbe.exitCode === 0 ? formatProbe.stdout.trim() : 'sha1';
    if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
      throw new Error(`Unsupported Git object format ${JSON.stringify(objectFormat)}`);
    }
    const initArgs = ['git', 'init', '--bare', '--quiet', `--template=${templates}`];
    if (objectFormat !== 'sha1') initArgs.push(`--object-format=${objectFormat}`);
    initArgs.push(broker);
    await runOrThrow(initArgs, {
      cwd: dir,
      env: gitEnv,
      timeoutMs: 30_000,
      ...(signal ? { signal } : {}),
    });
    await mkdir(path.join(broker, 'objects', 'info'), { recursive: true, mode: 0o700 });
    await writeFile(path.join(broker, 'objects', 'info', 'alternates'), `${sourceObjects}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });

    const command = (args: string[]): string[] => [
      'git',
      '-c',
      'protocol.allow=never',
      '-c',
      'protocol.https.allow=always',
      ...(promisor?.allowFile ? ['-c', 'protocol.file.allow=always'] : []),
      `--git-dir=${broker}`,
      ...args,
    ];
    const accessEnv = promisor
      ? promisorGitEnvironment(gitEnv, promisor, templates)
      : gitEnv;
    const commit = await run(command(['cat-file', '-e', `${sha}^{commit}`]), {
      cwd: dir,
      env: accessEnv,
      timeoutMs: 120_000,
      ...(signal ? { signal } : {}),
    });
    signal?.throwIfAborted();
    if (commit.exitCode !== 0) {
      return {
        files: new Map(),
        commitAvailable: false,
        unreadablePaths: [],
        oversizedPaths: [],
      };
    }

    // A failed `git show sha:path` does not mean the path is absent: partial clones can have the
    // commit and tree while the selected blob cannot be hydrated. Establish tree membership first
    // and retain an explicit unreadable state so trusted-policy callers can fail closed.
    const listed = await run(command(['ls-tree', '-l', '-z', '--full-tree', sha, '--', ...paths]), {
      cwd: dir,
      env: accessEnv,
      timeoutMs: 120_000,
      ...(signal ? { signal } : {}),
    });
    signal?.throwIfAborted();
    if (listed.exitCode !== 0) {
      return {
        files: new Map(),
        commitAvailable: true,
        unreadablePaths: paths,
        oversizedPaths: [],
      };
    }
    const entries = new Map<string, { type: string; size: number | null }>();
    for (const record of listed.stdout.split('\0')) {
      if (!record) continue;
      const tab = record.indexOf('\t');
      if (tab < 0) continue;
      const metadata = record.slice(0, tab).match(
        /^(?:[0-7]{6}) (\S+) ([0-9a-f]+)\s+(-|[0-9]+)$/,
      );
      if (!metadata) continue;
      const candidate = record.slice(tab + 1);
      const size = metadata[3] === '-' ? null : Number(metadata[3]);
      entries.set(candidate, {
        type: metadata[1] ?? '',
        size: Number.isSafeInteger(size) && size! >= 0 ? size : null,
      });
    }

    const files = new Map<string, string>();
    const unreadablePaths: string[] = [];
    const oversizedPaths: string[] = [];
    for (const candidate of paths) {
      const entry = entries.get(candidate);
      if (entry === undefined) continue;
      if (entry.type !== 'blob' || entry.size === null) {
        unreadablePaths.push(candidate);
        continue;
      }
      if (entry.size > maxFileBytes) {
        oversizedPaths.push(candidate);
        continue;
      }
      const io = await run(command(['--no-pager', 'show', `${sha}:${candidate}`]), {
        cwd: dir,
        env: accessEnv,
        timeoutMs: 120_000,
        maxBufferBytes: maxFileBytes + 1,
        ...(signal ? { signal } : {}),
      });
      signal?.throwIfAborted();
      if (io.exitCode === 0 && Buffer.byteLength(io.stdout, 'utf8') <= maxFileBytes) {
        files.set(candidate, io.stdout);
      }
      else if (Buffer.byteLength(io.stdout, 'utf8') > maxFileBytes) oversizedPaths.push(candidate);
      else unreadablePaths.push(candidate);
    }
    return { files, commitAvailable: true, unreadablePaths, oversizedPaths };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function checkoutAt(
  repoDir: string,
  sha: string,
  o: {
    prNumber?: number | null;
    includeWorkingTree?: boolean;
    promisor?: CheckoutPromisorAccess;
    /** Other trees that must be fully local before the broker metadata is sealed. */
    requiredCommits?: readonly string[];
    /** Cancel controller-owned Git materialization and diff processes. */
    signal?: AbortSignal;
  } = {},
): Promise<EphemeralCheckout> {
  o.signal?.throwIfAborted();
  validateFullSha(sha, 'Checkout commit');
  const prNumber = o.prNumber ?? null;
  if (prNumber !== null && (!Number.isSafeInteger(prNumber) || prNumber <= 0)) {
    throw new Error('Pull request number must be a positive integer');
  }

  // Do not run `git worktree prune` here. The source repository can be bind-mounted into a
  // container at a different path, while its other linked worktrees remain valid on the
  // host. Those paths look missing from inside the container and a global prune would delete
  // their registrations. Cleanup below removes only the worktree created by this function.

  // realpath, because on macOS `os.tmpdir()` is `/var/folders/...`, a symlink to
  // `/private/var/folders/...`. Handing the symlinked form to a harness makes it compare a
  // resolved file path against an unresolved root and conclude that files inside the repo
  // are outside it — opencode auto-rejects those reads and the review comes back empty.
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'juror-')));
  const target = path.join(dir, 'repo');
  const broker = path.join(dir, 'repository.git');
  const homeDir = path.join(dir, 'home');
  const templates = path.join(dir, 'templates');
  const globalConfig = path.join(dir, 'global.gitconfig');
  await Promise.all([
    mkdir(homeDir, { mode: 0o700 }),
    mkdir(templates, { mode: 0o700 }),
    writeFile(globalConfig, '', { encoding: 'utf8', mode: 0o600 }),
  ]);
  const gitEnv = isolatedGitEnvironment(homeDir, globalConfig);
  const worktreeCommand = (args: string[]): string[] => [
    'git',
    '-c',
    'protocol.allow=never',
    '-c',
    'protocol.https.allow=always',
    ...(o.promisor?.allowFile ? ['-c', 'protocol.file.allow=always'] : []),
    `--git-dir=${broker}`,
    ...args,
  ];
  const checkoutEnv = o.promisor
    ? promisorGitEnvironment(gitEnv, o.promisor, templates)
    : gitEnv;
  const hasBrokerCommit = async (commit: string): Promise<boolean> => {
    const io = await run(worktreeCommand(['cat-file', '-e', `${commit}^{commit}`]), {
      cwd: dir,
      env: { ...gitEnv, GIT_NO_LAZY_FETCH: '1' },
      timeoutMs: 30_000,
      ...(o.signal ? { signal: o.signal } : {}),
    });
    return io.exitCode === 0;
  };
  const ensureBrokerCommit = async (
    commit: string,
    pullNumber: number | null,
    sourceObjects: string,
  ): Promise<boolean> => {
    if (await hasBrokerCommit(commit)) return true;
    if (!o.promisor) return false;

    // A fork head may not be fetchable from the base repository by object ID, even though
    // GitHub exposes it through refs/pull/N/head. Fetch only into the controller-owned broker,
    // keep credentials in ephemeral process config, and verify the exact requested commit
    // after every attempt so a stale or mismatched pull ref cannot change the checkout.
    const candidates = [commit];
    if (pullNumber !== null) candidates.push(`refs/pull/${pullNumber}/head`);
    const alternates = path.join(broker, 'objects', 'info', 'alternates');
    // An alternate from a shallow/partial source can contain a child whose parent is absent.
    // Git's fetch connectivity check treats that as corrupt because shallow boundaries are not
    // represented by alternates. Temporarily detach the alternate while hydrating the broker.
    await rm(alternates, { force: true });
    try {
      for (const candidate of candidates) {
        log.debug(`fetching ${candidate.startsWith('refs/') ? candidate : commit.slice(0, 12)}`);
        const fetched = await run(
          worktreeCommand([
            'fetch',
            '--no-tags',
            '--depth=50',
            '--filter=blob:none',
            BROKER_PROMISOR_REMOTE,
            candidate,
          ]),
          { cwd: dir, env: checkoutEnv, timeoutMs: 300_000, ...(o.signal ? { signal: o.signal } : {}) },
        );
        if (fetched.exitCode !== 0) {
          log.debug(`fetch attempt for ${candidate.startsWith('refs/') ? candidate : 'commit'} failed`);
        }
        if (await hasBrokerCommit(commit)) return true;
      }
      return false;
    } finally {
      await writeFile(alternates, `${sourceObjects}\n`, { encoding: 'utf8', mode: 0o600 });
    }
  };
  let gitPointer = '';
  let sealed = false;
  try {
    // Do not materialize an untrusted commit through the source repository. Its local Git
    // configuration can execute core.fsmonitor, checkout hooks, or arbitrary smudge filters
    // selected by a tracked .gitattributes file. Instead, create a controller-owned bare
    // broker with no templates or inherited configuration and share only immutable objects.
    const sourceObjects = await realpath(await resolveGitPath(repoDir, 'objects', gitEnv, o.signal));
    if (sourceObjects.includes('\n') || sourceObjects.includes('\r')) {
      throw new Error('Git object directory contains a newline and cannot be shared safely');
    }
    const formatProbe = await run(['git', '--no-pager', 'rev-parse', '--show-object-format'], {
      cwd: repoDir,
      env: gitEnv,
      timeoutMs: 30_000,
      ...(o.signal ? { signal: o.signal } : {}),
    });
    const objectFormat = formatProbe.exitCode === 0 ? formatProbe.stdout.trim() : 'sha1';
    if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
      throw new Error(`Unsupported Git object format ${JSON.stringify(objectFormat)}`);
    }
    const initArgs = ['git', 'init', '--bare', '--quiet', `--template=${templates}`];
    if (objectFormat !== 'sha1') initArgs.push(`--object-format=${objectFormat}`);
    initArgs.push(broker);
    await runOrThrow(initArgs, {
      cwd: dir,
      env: gitEnv,
      timeoutMs: 30_000,
      ...(o.signal ? { signal: o.signal } : {}),
    });
    await mkdir(path.join(broker, 'objects', 'info'), { recursive: true, mode: 0o700 });
    await writeFile(path.join(broker, 'objects', 'info', 'alternates'), `${sourceObjects}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });

    const required = [...new Set(o.requiredCommits ?? [])]
      .filter((commit) => commit.toLowerCase() !== sha.toLowerCase());
    for (const [index, commit] of required.entries()) {
      validateFullSha(commit, 'Required commit');
      if (!(await ensureBrokerCommit(commit, null, sourceObjects))) {
        throw new Error(`Could not fetch required commit ${commit.slice(0, 12)}`);
      }
      const hydrationTarget = path.join(dir, `required-${index}`);
      try {
        await runOrThrow(
          worktreeCommand(['worktree', 'add', '--detach', '--quiet', hydrationTarget, commit]),
          {
            cwd: dir,
            env: checkoutEnv,
            timeoutMs: 600_000,
            ...(o.signal ? { signal: o.signal } : {}),
          },
        );
      } finally {
        await run(worktreeCommand(['worktree', 'remove', '--force', hydrationTarget]), {
          cwd: dir,
          env: checkoutEnv,
          timeoutMs: 120_000,
        });
        await rm(hydrationTarget, { recursive: true, force: true });
      }
    }

    if (!(await ensureBrokerCommit(sha, prNumber, sourceObjects))) {
      throw new Error(
        `Could not fetch review head ${sha.slice(0, 12)}; refusing to expose or review the ` +
          'operator checkout as a fallback.',
      );
    }
    await runOrThrow(worktreeCommand(['worktree', 'add', '--detach', '--quiet', target, sha]), {
      cwd: dir,
      env: checkoutEnv,
      timeoutMs: 600_000,
      ...(o.signal ? { signal: o.signal } : {}),
    });
    gitPointer = await readFile(path.join(target, '.git'), 'utf8');

    if (o.includeWorkingTree) {
      // `git diff <sha>` contains staged and unstaged tracked changes plus staged additions.
      // Untracked files are intentionally absent: collectLocalDiff does not review them, and
      // copying them would reintroduce the `.env` exposure this checkout exists to prevent.
      // Compare through the broker as well. Point it at the operator's worktree and index so
      // staged and unstaged tracked edits are preserved, without loading source-local filter,
      // diff-driver, or fsmonitor configuration.
      const sourceIndex = await resolveGitPath(repoDir, 'index', gitEnv, o.signal);
      const patch = await runOrThrow(
        [
          'git',
          `--git-dir=${broker}`,
          `--work-tree=${repoDir}`,
          '-c',
          'core.fsmonitor=false',
          '--no-pager',
          'diff',
          '--binary',
          '--full-index',
          '--no-color',
          '--no-ext-diff',
          '--no-textconv',
          sha,
        ],
        {
          cwd: dir,
          env: { ...gitEnv, GIT_INDEX_FILE: sourceIndex },
          timeoutMs: 120_000,
          ...(o.signal ? { signal: o.signal } : {}),
        },
      );
      if (patch.trim()) {
        await runOrThrow(['git', 'apply', '--binary', '--whitespace=nowarn', '-'], {
          cwd: target,
          env: gitEnv,
          stdin: patch,
          timeoutMs: 300_000,
          ...(o.signal ? { signal: o.signal } : {}),
        });
      }
    }
  } catch (error) {
    // `add` or local-patch application may fail before the cleanup closure below exists to
    // reap it. Remove both the registration and the temp directory here.
    await run(worktreeCommand(['worktree', 'remove', '--force', target]), {
      cwd: dir,
      env: gitEnv,
      timeoutMs: 120_000,
    });
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  log.debug(`reviewing detached worktree at ${sha.slice(0, 12)}`);

  return {
    dir: target,
    ephemeral: true,
    diffFrom: async (baseSha: string, maxBytes: number) => {
      validateFullSha(baseSha, 'Diff base commit');
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes >= Number.MAX_SAFE_INTEGER) {
        throw new Error('Diff byte limit must be a positive safe integer');
      }
      if (sealed || !gitPointer || !(await hasBrokerCommit(baseSha)) || !(await hasBrokerCommit(sha))) {
        throw new Error('Diff commits are not fully materialized in the isolated checkout');
      }

      // Generate the patch through the empty-config broker rather than the source repository.
      // Tracked attributes may select a diff driver or text converter, so disable both execution
      // paths explicitly. Binary object hashes and paths remain in the patch, while Git's compact
      // "binary files differ" marker avoids base85 bodies the planner cannot use. Capture one byte
      // beyond the supported limit and reject oversize textual patches instead of truncating them.
      const io = await run(
        worktreeCommand([
          '--no-pager',
          'diff',
          '--full-index',
          '--unified=3',
          '--no-color',
          '--no-ext-diff',
          '--no-textconv',
          '--find-renames',
          `${baseSha}..${sha}`,
          '--',
        ]),
        {
          cwd: dir,
          env: { ...gitEnv, GIT_NO_LAZY_FETCH: '1' },
          timeoutMs: 300_000,
          maxBufferBytes: maxBytes + 1,
          ...(o.signal ? { signal: o.signal } : {}),
        },
      );
      if (io.exitCode !== 0 || io.timedOut) {
        throw new Error(
          `Could not generate the isolated merged patch: ${io.stderr.trim() || `git exited ${io.exitCode}`}`,
        );
      }
      if (Buffer.byteLength(io.stdout, 'utf8') > maxBytes) {
        throw new Error(
          `Merged patch exceeds the ${maxBytes}-byte QA safety limit; refusing to test an incomplete change set`,
        );
      }
      return io.stdout;
    },
    changedPathsFrom: async (baseSha: string, maxBytes: number) => {
      validateFullSha(baseSha, 'Changed-path base commit');
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes >= Number.MAX_SAFE_INTEGER) {
        throw new Error('Changed-path byte limit must be a positive safe integer');
      }
      if (sealed || !gitPointer || !(await hasBrokerCommit(baseSha)) || !(await hasBrokerCommit(sha))) {
        throw new Error('Changed-path commits are not fully materialized in the isolated checkout');
      }
      const io = await run(
        worktreeCommand([
          '--no-pager',
          'diff',
          '--name-status',
          '-z',
          '--no-ext-diff',
          '--no-textconv',
          '--find-renames',
          `${baseSha}..${sha}`,
          '--',
        ]),
        {
          cwd: dir,
          env: { ...gitEnv, GIT_NO_LAZY_FETCH: '1' },
          timeoutMs: 300_000,
          maxBufferBytes: maxBytes + 1,
          ...(o.signal ? { signal: o.signal } : {}),
        },
      );
      if (io.exitCode !== 0 || io.timedOut) {
        throw new Error(
          `Could not generate the isolated changed-path manifest: ` +
            `${io.stderr.trim() || `git exited ${io.exitCode}`}`,
        );
      }
      if (Buffer.byteLength(io.stdout, 'utf8') > maxBytes) {
        throw new Error(
          `Merged change-path manifest exceeds the ${maxBytes}-byte QA safety limit; ` +
            'refusing to plan from an incomplete affected-file list',
        );
      }

      return parseChangedPathManifest(io.stdout);
    },
    seal: async () => {
      // Models do not need repository plumbing. Remove even the isolated broker pointer after
      // Juror has loaded trusted base-revision config and AGENTS.md files, keeping the model's
      // read root to source bytes only.
      await rm(path.join(target, '.git'), { force: true });
      sealed = true;
    },
    cleanup: async () => {
      // `seal()` removes this pointer before untrusted model execution. Restore only the
      // controller-captured value after that execution so Git can unregister this one exact
      // worktree without a namespace-unsafe global prune.
      const gitFile = path.join(target, '.git');
      await rm(gitFile, { recursive: true, force: true });
      if (gitPointer && (await realpath(target).catch(() => null)) === target) {
        await writeFile(gitFile, gitPointer, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      }
      const removed = await run(worktreeCommand(['worktree', 'remove', '--force', target]), {
        cwd: dir,
        env: gitEnv,
        timeoutMs: 120_000,
      });
      await rm(dir, { recursive: true, force: true });
      if (removed.exitCode !== 0) {
        log.debug(`could not remove ephemeral worktree registration at ${target}`);
      }
    },
  };
}
