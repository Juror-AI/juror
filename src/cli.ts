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

import { runOrThrow } from './util/proc.js';

import type { DiffContext, JurorConfig } from './types.js';
import { loadConfig } from './config.js';
import { collectFromPatch, collectLocalDiff } from './diff/collect.js';
import { runReview } from './review.js';
import { renderTerminalReport } from './render/terminal.js';
import { renderSummaryComment } from './render/summary.js';
import { GitHubClient } from './github/client.js';
import { publishReview } from './github/publish.js';
import { loadRolling, recordSpend } from './cost/rolling.js';
import { log, redact, setLogLevel } from './util/log.js';
import { gitStateDir, repoRoot } from './util/workspace.js';
import { checkoutAt, type EphemeralCheckout } from './util/worktree.js';

export const VERSION = '0.1.0';

const USAGE = `
juror ${VERSION} — multi-model PR review that shows you the bill

Usage
  juror review [options]

Target (pick one)
  --pr <number>          Review a GitHub pull request
  --base <ref>           Review the local working tree against a base ref (default: origin/HEAD)

Options
  --repo <owner/name>    GitHub repository (default: inferred from the git remote)
  --repo-dir <path>      Repository checkout to read (default: cwd)
  --head <ref>           Head ref for local mode (default: HEAD)
  --config <path>        Config file (default: .juror.yml in the repo)
  --models <a,b,c>       Only run these model ids
  --post                 Post the review to the pull request (requires --pr and GITHUB_TOKEN)
  --dry-run              With --post, render everything but perform no writes
  --json [path]          Emit the full ReviewResult as JSON (stdout, or a file)
  --markdown <path>      Write the rendered summary comment to a file
  --max-cost <usd>       Override budget.max_cost_usd_per_pr
  --keep-scratch         Leave .juror-run/ in place for debugging
  --env-file <path>      Load KEY=VALUE pairs before running (default: ./.env if present)
  -v, --verbose          Debug logging
  -q, --quiet            Errors only
  -h, --help             This message

Environment
  ANTHROPIC_API_KEY  OPENAI_API_KEY  XAI_API_KEY  FIREWORKS_API_KEY  GITHUB_TOKEN
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
  models: string[];
  post: boolean;
  dryRun: boolean;
  json: string | boolean;
  markdown: string | null;
  maxCost: number | null;
  keepScratch: boolean;
  envFile: string | null;
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
    models: [],
    post: false,
    dryRun: false,
    json: false,
    markdown: null,
    maxCost: null,
    keepScratch: false,
    envFile: null,
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
      case '--models': a.models = next(i).split(','); i++; break;
      case '--post': a.post = true; break;
      case '--no-post': a.post = false; break;
      case '--dry-run': a.dryRun = true; break;
      case '--markdown': a.markdown = path.resolve(next(i)); i++; break;
      case '--max-cost': a.maxCost = Number(next(i)); i++; break;
      case '--keep-scratch': a.keepScratch = true; break;
      case '--env-file': a.envFile = path.resolve(next(i)); i++; break;
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
  if (args.command !== 'review') {
    process.stderr.write(`Unknown command "${args.command}".\n${USAGE}`);
    return 2;
  }

  const loaded = loadEnvFile(args.envFile ?? path.join(process.cwd(), '.env'));
  if (loaded) log.debug(`loaded ${loaded} variable(s) from the env file`);

  const repoDir = await repoRoot(args.repoDir);
  const { config: baseConfig, problems, sourcePath } = loadConfig(repoDir, args.config ?? undefined);
  for (const p of problems) log.warn(`config: ${p}`);
  if (sourcePath) log.debug(`config from ${sourcePath}`);

  const config: JurorConfig = args.maxCost
    ? { ...baseConfig, budget: { ...baseConfig.budget, max_cost_usd_per_pr: args.maxCost } }
    : baseConfig;

  // ── Collect the diff ───────────────────────────────────────────────────────
  const repo = args.repo ?? (await inferRepo(repoDir));
  let diff: DiffContext;
  let headSha: string;
  const prNumber: number | null = args.pr;
  let checkout: EphemeralCheckout = { dir: repoDir, ephemeral: false, cleanup: async () => {} };

  if (args.pr !== null) {
    if (!repo) throw new Error('--pr needs a repository: pass --repo owner/name');
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    if (!token) throw new Error('--pr needs GITHUB_TOKEN (read access is enough without --post)');
    const client = new GitHubClient({ token, repo, version: VERSION });
    const meta = await client.getPull(args.pr);
    log.step(`PR #${meta.number} — ${meta.title}`);
    const patch = await client.getPullDiff(args.pr);
    diff = collectFromPatch(patch, {
      baseSha: meta.baseSha,
      headSha: meta.headSha,
      pathsIgnore: config.review.paths_ignore,
      maxDiffBytes: config.review.max_diff_bytes,
    });
    headSha = meta.headSha;
    // Reviewing a PR means grepping the PR's code, not whatever branch happens to be
    // checked out. Falls back to the current tree with a warning when the SHA is unreachable.
    checkout = await checkoutAt(repoDir, meta.headSha, { prNumber: args.pr });
  } else {
    diff = await collectLocalDiff({
      repoDir,
      ...(args.base ? { base: args.base } : {}),
      ...(args.head ? { head: args.head } : {}),
      pathsIgnore: config.review.paths_ignore,
      maxDiffBytes: config.review.max_diff_bytes,
    });
    headSha = diff.headSha;
  }

  const reviewable = diff.files.filter((f) => !f.ignored);
  if (reviewable.length === 0) {
    log.warn('Nothing to review: the diff is empty after path filters.');
    return 0;
  }
  log.step(
    `${reviewable.length} file${reviewable.length === 1 ? '' : 's'} · ` +
      `+${diff.totalAdditions}/-${diff.totalDeletions} · base ${diff.baseSha.slice(0, 7)}`,
  );

  // ── Review ─────────────────────────────────────────────────────────────────
  // A review is minutes of model time, so Ctrl-C during one is normal rather than
  // exceptional. `finally` does not run when the process is signalled, and a leaked
  // worktree is not self-healing — it stays registered in the parent repo until someone
  // runs `git worktree prune`. Hook the signals so the common case cleans up after itself.
  const onSignal = (sig: NodeJS.Signals) => {
    void checkout.cleanup().finally(() => process.exit(sig === 'SIGINT' ? 130 : 143));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let result;
  try {
    result = await runReview({
      repoDir: checkout.dir,
      config,
      diff,
      secrets: process.env as Record<string, string | undefined>,
      ...(args.models.length ? { onlyModels: args.models } : {}),
      keepScratch: args.keepScratch,
    });
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (!args.keepScratch) await checkout.cleanup();
    else if (checkout.ephemeral) log.info(`worktree kept at ${checkout.dir}`);
  }

  // ── Output ─────────────────────────────────────────────────────────────────
  const stateDir = await gitStateDir(repoDir);
  const prKey = `${repo ?? 'local'}#${prNumber ?? 'wt'}@${headSha.slice(0, 12)}`;
  const rolling = safeRecordSpend(stateDir, result.totals.usd, prKey);

  process.stdout.write(renderTerminalReport(result, { version: VERSION }));

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

  if (args.post) {
    if (prNumber === null || !repo) {
      log.error('--post requires --pr and a resolvable repository');
      return 2;
    }
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    if (!token) {
      log.error('--post requires GITHUB_TOKEN');
      return 2;
    }
    const client = new GitHubClient({ token, repo, version: VERSION });
    const outcome = await publishReview(result, {
      client,
      prNumber,
      headSha,
      config,
      version: VERSION,
      rolling,
      dryRun: args.dryRun,
    });
    for (const w of outcome.warnings) log.warn(w);
    log.info(
      args.dryRun
        ? 'dry run: nothing was posted'
        : `posted — summary comment ${outcome.summaryCommentId}, ${outcome.inlinePosted} inline`,
    );
  }

  // A review that found blockers is still a successful review. Exit non-zero only when the
  // tool itself failed, so a PR check can decide policy separately from tool health.
  return 0;
}

function safeRecordSpend(stateDir: string, usd: number | null, prKey: string) {
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
