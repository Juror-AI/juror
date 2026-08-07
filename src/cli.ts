#!/usr/bin/env node
/**
 * `juror` — the same binary in CI and on your laptop.
 *
 * There is exactly one code path: collect a diff, fan out, deduplicate, filter, render.
 * Whether the result is printed to a terminal or posted to a pull request is decided at
 * the very end, which is what keeps "works locally" and "works in Actions" from drifting.
 */

import { writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { run, runOrThrow } from './util/proc.js';

import type { DiffContext, JurorConfig, ReviewPreset } from './types.js';
import {
  applyReviewPreset,
  CONFIG_FILENAMES,
  defaultConfig,
  loadConfig,
  loadConfigText,
  parseReviewPreset,
  resolveModelRuntime,
  REVIEW_PRESETS,
} from './config.js';
import { collectFromPatch, collectLocalDiff } from './diff/collect.js';
import { runReview } from './review.js';
import { renderTerminalReport } from './render/terminal.js';
import { renderSummaryComment } from './render/summary.js';
import { GitHubClient, type PullMeta } from './github/client.js';
import { publishFailureComment, publishReview, publishWorkingComment } from './github/publish.js';
import { loadRolling, recordSpend } from './cost/rolling.js';
import { log, redact, setLogLevel } from './util/log.js';
import { gitStateDir, repoRoot } from './util/workspace.js';
import { checkoutAt, type EphemeralCheckout } from './util/worktree.js';
import { evaluateBenchmark, parseBenchmarkCorpus, renderBenchmark } from './benchmark.js';
import { loadAgentInstructions } from './instructions.js';

export const VERSION = '1.2.0';

const USAGE = `
juror ${VERSION} — multi-model PR review that shows you the bill

Usage
  juror review [options]
  juror benchmark --file <corpus.json> [--json [path]]

Target (pick one)
  --pr <number>          Review a GitHub pull request
  --base <ref>           Review the local working tree against a base ref (default: origin/HEAD)

Options
  --repo <owner/name>    GitHub repository (default: inferred from the git remote)
  --repo-dir <path>      Repository checkout to read (default: cwd)
  --head <ref>           Head ref for local mode (default: HEAD)
  --config <path>        Config file (default: .juror.yml in the repo)
  --preset <name>        Jury preset: fast (default), balanced, high, or ultra
  --mode <name>          Alias for --preset
  --models <a,b,c>       Only run these model ids
  --post                 Post the review to the pull request (requires --pr and GITHUB_TOKEN)
  --dry-run              With --post, render everything but perform no writes
  --json [path]          Emit the full ReviewResult as JSON (stdout, or a file)
  --markdown <path>      Write the rendered summary comment to a file
  --cost-target <usd>    Override budget.target_cost_usd_per_pr (planning target, not a hard cap)
  --keep-scratch         Keep the unique temporary run directory for debugging
  --env-file <path>      Load KEY=VALUE pairs before running (default: ./.env if present)
  --file <path>          Adjudicated corpus for the benchmark command
  -v, --verbose          Debug logging
  -q, --quiet            Errors only
  -h, --help             This message

Environment
  ANTHROPIC_API_KEY  OPENAI_API_KEY  XAI_API_KEY  FIREWORKS_API_KEY
  GITHUB_TOKEN
  Any model whose key is absent is skipped with a note in the receipt — a repo with one
  key still gets a working review.
`;

interface Args {
  command: string;
  pr: number | null;
  repo: string | null;
  repoDir: string;
  base: string | null;
  head: string | null;
  config: string | null;
  preset: ReviewPreset | null;
  models: string[];
  post: boolean;
  dryRun: boolean;
  json: string | boolean;
  markdown: string | null;
  costTarget: number | null;
  keepScratch: boolean;
  envFile: string | null;
  file: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    command: 'review',
    pr: null,
    repo: null,
    repoDir: process.cwd(),
    base: null,
    head: null,
    config: null,
    preset: null,
    models: [],
    post: false,
    dryRun: false,
    json: false,
    markdown: null,
    costTarget: null,
    keepScratch: false,
    envFile: null,
    file: null,
    help: false,
  };

  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith('-')) a.command = rest.shift() as string;

  const next = (i: number): string => {
    const v = rest[i + 1];
    if (v === undefined) throw new Error(`Missing value for ${rest[i]}`);
    return v;
  };

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    switch (arg) {
      case '--pr': a.pr = Number(next(i)); i++; break;
      case '--repo': a.repo = next(i); i++; break;
      case '--repo-dir': a.repoDir = path.resolve(next(i)); i++; break;
      case '--base': a.base = next(i); i++; break;
      case '--head': a.head = next(i); i++; break;
      case '--config': a.config = path.resolve(next(i)); i++; break;
      case '--preset':
      case '--mode': {
        const value = next(i);
        const preset = parseReviewPreset(value);
        if (!preset) throw new Error(`Unknown preset "${value}". Expected one of: ${REVIEW_PRESETS.join(', ')}`);
        a.preset = preset;
        i++;
        break;
      }
      case '--models': a.models = next(i).split(','); i++; break;
      case '--post': a.post = true; break;
      case '--no-post': a.post = false; break;
      case '--dry-run': a.dryRun = true; break;
      case '--markdown': a.markdown = path.resolve(next(i)); i++; break;
      case '--cost-target': a.costTarget = Number(next(i)); i++; break;
      case '--keep-scratch': a.keepScratch = true; break;
      case '--env-file': a.envFile = path.resolve(next(i)); i++; break;
      case '--file': a.file = path.resolve(next(i)); i++; break;
      case '--json': {
        const v = rest[i + 1];
        if (v && !v.startsWith('-')) { a.json = path.resolve(v); i++; } else a.json = true;
        break;
      }
      case '-v': case '--verbose': setLogLevel('debug'); break;
      case '-q': case '--quiet': setLogLevel('error'); break;
      case '-h': case '--help': a.help = true; break;
      case '--version': process.stdout.write(`${VERSION}\n`); process.exit(0);
      default:
        if (arg?.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    }
  }
  return a;
}

/**
 * Minimal `.env` loader. A dependency for this would be silly, and keeping it in-tree means
 * the file format is whatever we say it is: `KEY=VALUE`, `#` comments, optional quotes.
 */
function loadEnvFile(file: string): number {
  if (!existsSync(file)) return 0;
  let n = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (val && process.env[key] === undefined) {
      process.env[key] = val;
      n++;
    }
  }
  return n;
}

async function inferRepo(repoDir: string): Promise<string | null> {
  try {
    const url = (await runOrThrow(['git', 'remote', 'get-url', 'origin'], { cwd: repoDir })).trim();
    const m = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
    return m?.[1] && m[2] ? `${m[1]}/${m[2]}` : null;
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.command === 'benchmark') return runBenchmarkCommand(args);
  if (args.command !== 'review') {
    process.stderr.write(`Unknown command "${args.command}".\n${USAGE}`);
    return 2;
  }

  const loaded = loadEnvFile(args.envFile ?? path.join(process.cwd(), '.env'));
  if (loaded) log.debug(`loaded ${loaded} variable(s) from the env file`);
  if (args.costTarget !== null && (!Number.isFinite(args.costTarget) || args.costTarget < 0)) {
    throw new Error('--cost-target must be a finite number greater than or equal to zero');
  }

  const repoDir = await repoRoot(args.repoDir);
  const repo = args.repo ?? (await inferRepo(repoDir));
  const prNumber: number | null = args.pr;
  let githubClient: GitHubClient | null = null;
  let pull: PullMeta | null = null;

  if (prNumber !== null) {
    if (!repo) throw new Error('--pr needs a repository: pass --repo owner/name');
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    if (!token) throw new Error('--pr needs GITHUB_TOKEN (read access is enough without --post)');
    githubClient = new GitHubClient({ token, repo, version: VERSION });
    pull = await githubClient.getPull(prNumber);
    log.step(`PR #${pull.number} — ${pull.title}`);
  }

  // In PR mode, repository configuration is untrusted until read from the base revision.
  // An explicit path inside the repo is also read from base; only an external operator-owned
  // config file is read directly.
  const loadedConfig = pull
    ? await loadConfigFromBase(repoDir, pull.baseSha, args.config)
    : loadConfig(repoDir, args.config ?? undefined);
  const { config: baseConfig, problems, sourcePath } = loadedConfig;
  for (const p of problems) log.warn(`config: ${p}`);
  if (sourcePath) log.debug(`config from ${sourcePath}`);

  let config: JurorConfig = args.preset ? applyReviewPreset(baseConfig, args.preset) : baseConfig;
  if (args.costTarget !== null) {
    config = { ...config, budget: { ...config.budget, target_cost_usd_per_pr: args.costTarget } };
  }

  // ── Collect the diff ───────────────────────────────────────────────────────
  let diff: DiffContext;
  let headSha: string;
  let checkout: EphemeralCheckout = {
    dir: repoDir,
    ephemeral: false,
    seal: async () => {},
    cleanup: async () => {},
  };

  if (pull && githubClient && prNumber !== null) {
    const patch = await githubClient.getCompareDiff(pull.baseSha, pull.headSha);
    diff = collectFromPatch(patch, {
      baseSha: pull.baseSha,
      headSha: pull.headSha,
      pathsIgnore: config.review.paths_ignore,
      maxDiffBytes: config.review.max_diff_bytes,
    });
    headSha = pull.headSha;
    // Reviewing a PR means grepping an isolated PR-head worktree, never whatever branch or
    // untracked secret files happen to be present in the operator checkout.
    checkout = await checkoutAt(repoDir, pull.headSha, { prNumber });
  } else {
    diff = await collectLocalDiff({
      repoDir,
      ...(args.base ? { base: args.base } : {}),
      ...(args.head ? { head: args.head } : {}),
      pathsIgnore: config.review.paths_ignore,
      maxDiffBytes: config.review.max_diff_bytes,
    });
    headSha = diff.headSha;
    // A commit-to-commit review needs only the detached head. Without --head, reproduce
    // staged and unstaged tracked changes inside that clean view; untracked files (including
    // `.env`) are neither part of the collected diff nor copied into the model read root.
    checkout = await checkoutAt(repoDir, headSha, { includeWorkingTree: !args.head });
  }

  // Load policy while the detached worktree still has repository metadata, then sever its
  // `.git` pointer before any model can read the checkout. That pointer can lead back to an
  // Actions credential-bearing git config even though the source tree itself is clean.
  const instructions = await loadAgentInstructions(
    checkout.dir,
    diff.baseSha,
    diff.files.filter((file) => !file.ignored).map((file) => file.path),
  );
  await checkout.seal();

  const reviewable = diff.files.filter((f) => !f.ignored);
  if (reviewable.length === 0) {
    log.warn('Nothing to review: the diff is empty after path filters.');
  } else {
    log.step(
      `${reviewable.length} file${reviewable.length === 1 ? '' : 's'} · ` +
        `+${diff.totalAdditions}/-${diff.totalDeletions} · base ${diff.baseSha.slice(0, 7)}`,
    );
  }

  // ── Review ─────────────────────────────────────────────────────────────────
  const progress = args.post && prNumber !== null && repo && githubClient
    ? {
        client: githubClient,
        prNumber,
        headSha,
        version: VERSION,
        modelLabels: runnableModelLabels(config, args.models, process.env),
        jobUrl: actionRunUrl(repo),
        dryRun: args.dryRun,
      }
    : null;

  let workingCommentPosted = false;
  let failureCommentPosted = false;
  const markFailed = async (reason: string): Promise<void> => {
    if (!progress || !workingCommentPosted || failureCommentPosted) return;
    failureCommentPosted = true;
    try {
      await publishFailureComment({ ...progress, reason });
    } catch (statusError) {
      log.warn(`could not update the failed working comment: ${errorMessage(statusError)}`);
    }
  };

  // A review is minutes of model time, so Ctrl-C during one is normal. Abort the active
  // harnesses first, let runReview settle, and only then leave through the ordinary cleanup
  // path; exiting directly from the signal handler would orphan provider processes.
  const controller = new AbortController();
  let receivedSignal: NodeJS.Signals | null = null;
  let signalNotice: Promise<void> | null = null;
  const onSignal = (sig: NodeJS.Signals) => {
    if (receivedSignal) return;
    receivedSignal = sig;
    controller.abort();
    signalNotice = markFailed(`Review cancelled by ${sig}.`);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let result: Awaited<ReturnType<typeof runReview>>;
  try {
    if (progress) {
      try {
        workingCommentPosted = (await publishWorkingComment(progress)) !== null;
      } catch (e) {
        log.warn(`could not post the working comment: ${errorMessage(e)}`);
      }
    }
    result = await runReview({
      repoDir: checkout.dir,
      config,
      diff,
      secrets: process.env as Record<string, string | undefined>,
      ...(args.models.length ? { onlyModels: args.models } : {}),
      keepScratch: args.keepScratch,
      signal: controller.signal,
      instructions,
      ...(pull ? { pullRequest: { title: pull.title, body: pull.body } } : {}),
    });
  } catch (e) {
    await markFailed(errorMessage(e));
    throw e;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (!args.keepScratch) await checkout.cleanup();
    else if (checkout.ephemeral) log.info(`worktree kept at ${checkout.dir}`);
  }

  if (receivedSignal) {
    await signalNotice;
    return receivedSignal === 'SIGINT' ? 130 : 143;
  }

  // ── Output ─────────────────────────────────────────────────────────────────
  const stateDir = await gitStateDir(repoDir);
  const prKey = `${repo ?? 'local'}#${prNumber ?? 'wt'}@${headSha.slice(0, 12)}`;
  const rolling = safeRecordSpend(
    stateDir,
    result.totals.partial ? null : result.totals.usd,
    prKey,
  );

  if (args.json !== true) process.stdout.write(renderTerminalReport(result, { version: VERSION }));

  if (args.post) {
    if (prNumber === null || !repo || !githubClient) {
      log.error('--post requires --pr and a resolvable repository');
      return 2;
    }
    let outcome;
    let current: PullMeta | null = null;
    try {
      // A synchronize event normally cancels this job, but cancellation is advisory: a
      // provider call or network request may finish first. Never let that stale run replace
      // the new head's sticky comment or attach findings to an obsolete commit.
      current = await githubClient.getPull(prNumber);
    } catch (e) {
      // Fail closed without touching the sticky: it may already belong to a newer run, and
      // a failed freshness request gives us no safe way to distinguish that case.
      log.warn(
        `Could not confirm PR #${prNumber}'s current head; the completed review was not posted: ` +
          errorMessage(e),
      );
    }

    if (current) {
      const snapshotChanged = current.headSha !== headSha || current.baseSha !== diff.baseSha;
      if (snapshotChanged) {
        log.warn(
          `PR #${prNumber} changed during review; completed snapshot ${headSha.slice(0, 12)} ` +
            'was not posted because a fresh run must review the current head.',
        );
        outcome = null;
      } else {
        try {
          outcome = await publishReview(result, {
            client: githubClient,
            prNumber,
            headSha,
            config,
            version: VERSION,
            rolling,
            dryRun: args.dryRun,
          });
        } catch (e) {
          await markFailed(`Publishing the completed review failed: ${errorMessage(e)}`);
          throw e;
        }
      }
    }
    if (outcome) {
      for (const w of outcome.warnings) log.warn(w);
      log.info(
        args.dryRun
          ? 'dry run: nothing was posted'
          : `posted — summary comment ${outcome.summaryCommentId}, ${outcome.inlinePosted} inline`,
      );
    }
  }

  if (args.markdown) {
    const md = renderSummaryComment(result, {
      version: VERSION,
      headSha,
      config,
      rolling,
      ...(repo ? { repo } : {}),
      ...(prNumber !== null ? { prNumber } : {}),
    });
    await writeFile(args.markdown, redact(md), 'utf8');
    log.info(`summary written to ${args.markdown}`);
  }

  if (args.json) {
    const payload = JSON.stringify(serializable(result), null, 2);
    if (typeof args.json === 'string') await writeFile(args.json, payload, 'utf8');
    else process.stdout.write(`${payload}\n`);
  }

  // A review that found blockers is still a successful review. Exit non-zero only when the
  // tool itself failed, so a PR check can decide policy separately from tool health.
  return 0;
}

async function runBenchmarkCommand(args: Args): Promise<number> {
  if (!args.file) throw new Error('benchmark requires --file <corpus.json>');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(args.file, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `Could not read benchmark corpus ${args.file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = evaluateBenchmark(parseBenchmarkCorpus(raw));
  if (args.json !== true) process.stdout.write(renderBenchmark(result));
  if (args.json) {
    const payload = `${JSON.stringify(result, null, 2)}\n`;
    if (typeof args.json === 'string') await writeFile(args.json, payload, 'utf8');
    else process.stdout.write(payload);
  }
  return 0;
}

type LoadedConfig = ReturnType<typeof loadConfig>;

async function loadConfigFromBase(
  repoDir: string,
  baseSha: string,
  overridePath: string | null,
): Promise<LoadedConfig> {
  if (overridePath) {
    const relative = path.relative(repoDir, overridePath).replaceAll(path.sep, '/');
    const insideRepo = relative !== '' && relative !== '..' && !relative.startsWith('../');
    if (!insideRepo) return loadConfig(repoDir, overridePath);
    const io = await run(['git', 'show', `${baseSha}:${relative}`], {
      cwd: repoDir,
      timeoutMs: 30_000,
    });
    if (io.exitCode === 0) return loadConfigText(io.stdout, `${relative}@${baseSha.slice(0, 12)}`);
    return {
      config: defaultConfig(),
      problems: [`trusted config ${relative} does not exist at the PR base; using defaults`],
      sourcePath: null,
    };
  }

  for (const name of CONFIG_FILENAMES) {
    const io = await run(['git', 'show', `${baseSha}:${name}`], { cwd: repoDir, timeoutMs: 30_000 });
    if (io.exitCode === 0) return loadConfigText(io.stdout, `${name}@${baseSha.slice(0, 12)}`);
  }

  const base = await run(['git', 'cat-file', '-e', `${baseSha}^{commit}`], {
    cwd: repoDir,
    timeoutMs: 30_000,
  });
  return {
    config: defaultConfig(),
    problems:
      base.exitCode === 0
        ? []
        : [`base revision ${baseSha.slice(0, 12)} is unavailable locally; using secure defaults`],
    sourcePath: null,
  };
}

function safeRecordSpend(stateDir: string, usd: number | null, prKey: string) {
  // GitHub-hosted runners discard their checkout after every job. A ledger stored there
  // would reset on every invocation and make a "30-day" total look authoritative while it
  // contains only the current run. Keep rolling spend for persistent local/self-hosted
  // checkouts and omit it when persistence is not available.
  if (process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted') {
    return null;
  }
  try {
    return recordSpend(stateDir, usd, prKey);
  } catch {
    try {
      return loadRolling(stateDir);
    } catch {
      return null;
    }
  }
}

function runnableModelLabels(
  config: JurorConfig,
  onlyModels: string[],
  secrets: NodeJS.ProcessEnv,
): string[] {
  const wanted = new Set(onlyModels.map((id) => id.trim()).filter(Boolean));
  return config.models
    .filter((model) => model.enabled && (wanted.size === 0 || wanted.has(model.id)))
    .filter((model) => Boolean(secrets[model.secret]?.trim()))
    .map((model) => resolveModelRuntime(model).label);
}

function actionRunUrl(repo: string): string | null {
  const runId = process.env.GITHUB_RUN_ID?.trim();
  if (!runId) return null;
  const server = (process.env.GITHUB_SERVER_URL ?? 'https://github.com').replace(/\/+$/, '');
  return `${server}/${repo}/actions/runs/${encodeURIComponent(runId)}`;
}

function errorMessage(e: unknown): string {
  return redact(e instanceof Error ? e.message : String(e));
}

/** `DiffFile.positionByLine` is a Map, which `JSON.stringify` would silently flatten to `{}`. */
function serializable(r: unknown): unknown {
  return JSON.parse(
    JSON.stringify(r, (_k, v: unknown) => (v instanceof Map ? Object.fromEntries(v) : v)),
  );
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`${redact(msg)}\n`);
    process.exit(1);
  });
