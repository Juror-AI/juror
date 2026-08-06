/**
 * opencode adapter — the harness every third-party model rides on.
 *
 * Kimi K3, DeepSeek V4, GLM, MiniMax and friends have no usable CLI of their own, so
 * `opencode run` is what actually ships them: it resolves provider keys from the
 * environment via models.dev metadata (`FIREWORKS_API_KEY` alone enables every
 * `fireworks-ai/...` model) and it is the only non-Anthropic harness that reports a
 * real USD cost per step.
 *
 * Every shape below was measured against opencode 1.17.20 — see
 * `docs/harness-notes.md`. Do not "fix" this file against the docs.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type {
  CanonicalUsage,
  Harness,
  HarnessCommand,
  HarnessIO,
  HarnessLocation,
  HarnessResult,
  ModelReport,
  RunContext,
} from '../types.js';
import { parseModelReport, readReportFile } from '../report.js';
import { run, which } from '../util/proc.js';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Written to the scratch dir and handed over via `OPENCODE_CONFIG`.
 *
 * `edit: "allow"` is deliberate and load-bearing. Expressing the restriction the obvious
 * way — an object-form `edit` rule with a `"*": "deny"` catch-all and a single allowed
 * path — makes opencode drop the write tool from the model's toolset entirely; the model
 * then answers "I don't have a write tool available" and never produces findings.json.
 * So we allow edit outright and contain the blast radius three other ways instead:
 * the disabled tools below (no bash, no patch), opencode's own `--dir` confinement, and
 * the caller's post-run workspace guard.
 */
const OPENCODE_CONFIG = {
  $schema: 'https://opencode.ai/config.json',
  autoupdate: false,
  share: 'disabled',
  // Snapshots exist so a user can undo an agent's edits. A reviewer makes none worth
  // undoing, and the snapshot is a full git object store of the project — on a large
  // monorepo that is the single most expensive thing in the run.
  snapshot: false,
  instructions: [],
  tools: { bash: false, webfetch: false, task: false, todowrite: false, patch: false },
  permission: {
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    edit: 'allow',
    bash: 'deny',
    webfetch: 'deny',
    websearch: 'deny',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `path.resolve` normalises `..` but does not follow symlinks, and opencode compares the
 * paths it resolved itself against the `--dir` it was given. On macOS that difference is
 * routine rather than exotic — `/var/folders/...` is a symlink to `/private/var/folders/...`,
 * so a worktree under `os.tmpdir()` makes every file in the repo look external. Resolve
 * both sides here so the comparison is between like and like.
 */
function realOrSelf(p: string): string {
  const absolute = resolve(p);
  try {
    return realpathSync(absolute);
  } catch {
    // `findings.json` normally does not exist yet. Resolve its nearest existing ancestor
    // so a symlink in the repo path is still eliminated before the containment check.
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(realOrSelf(parent), basename(absolute));
  }
}

function isInside(child: string, parent: string): boolean {
  const c = realOrSelf(child);
  const p = realOrSelf(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** `readReportFile` is another module's; a throw there must not fail the whole run. */
function readReportSafely(path: string): { report: ModelReport | null; problems: string[] } {
  try {
    return readReportFile(path);
  } catch (e) {
    return { report: null, problems: [e instanceof Error ? e.message : String(e)] };
  }
}

function parseTextSafely(text: string): { report: ModelReport | null; problems: string[] } {
  try {
    return parseModelReport(text);
  } catch (e) {
    return { report: null, problems: [e instanceof Error ? e.message : String(e)] };
  }
}

/** opencode interleaves plain-text noise with its JSONL, so unparseable lines are skipped. */
function parseJsonl(text: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) events.push(parsed);
    } catch {
      // not a complete JSON object on this line
    }
  }
  return events;
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────────

export const opencodeHarness = {
  id: 'opencode',
  label: 'opencode',

  async locate(): Promise<HarnessLocation> {
    const binPath = await which('opencode');
    if (!binPath) {
      throw new Error(
        'opencode not found on PATH — install it (npm i -g opencode-ai) or disable the model in .juror.yml',
      );
    }
    const io = await run([binPath, '--version'], { timeoutMs: 15_000 });
    const version = (io.stdout.trim() || io.stderr.trim()).split('\n')[0]?.trim() ?? '';
    const warnings: string[] = [];
    if (io.exitCode !== 0) warnings.push(`opencode --version exited ${io.exitCode}`);
    if (!version) warnings.push('opencode reported no version string');
    return { binPath, version, warnings };
  },

  command(ctx: RunContext): HarnessCommand {
    // Writing outside `--dir` raises an `external_directory` permission prompt that headless
    // opencode auto-rejects, which looks like a silent no-op. Fail here instead of burning a
    // full model run on a report the agent was never allowed to write.
    if (!isInside(ctx.findingsPath, ctx.repoDir)) {
      throw new Error(
        `opencode auto-rejects writes outside --dir: findings path ${ctx.findingsPath} must live inside ${ctx.repoDir}`,
      );
    }

    // The scratch dir holds OUR run artifacts and may legitimately sit outside the repo —
    // only the agent-written findings file is constrained by --dir.
    mkdirSync(ctx.scratchDir, { recursive: true });
    const configPath = resolve(ctx.scratchDir, 'opencode.json');
    writeFileSync(configPath, `${JSON.stringify(OPENCODE_CONFIG, null, 2)}\n`, 'utf8');

    // Two things force the data dir to be private AND outside the repo.
    //
    // Private: opencode keeps sessions in SQLite, and two instances sharing one data dir
    // die instantly with `Error: database is locked` and an empty stdout — measured, not
    // theorised. Juror's whole shape is "run every model at once", so a shared dir would
    // fail whenever two jurors are opencode models, or two verifications overlap.
    //
    // Outside the repo: opencode writes into its data dir while walking the project. Put
    // that dir under the project and it starts recording its own writes, which shows up as
    // a run that dies in about a second and a scratch tree that will not delete.
    //
    // Keyed by scratch dir: distinct per concurrent caller, and bounded — one dir per
    // (repo, model) rather than one per run. It is wiped first because a data dir that
    // ever got corrupted would otherwise poison every future run of that model; the
    // symptom is a run that dies in about a second with empty output, which reads like a
    // model failure and is not one. Re-initialising costs ~1 MB and well under a second.
    const key = createHash('sha256').update(resolve(ctx.scratchDir)).digest('hex').slice(0, 16);
    const home = join(tmpdir(), 'juror-opencode', key);
    rmSync(home, { recursive: true, force: true });
    const dataHome = join(home, 'data');
    const cacheHome = join(home, 'cache');
    const configHome = join(home, 'config');
    const stateHome = join(home, 'state');
    mkdirSync(dataHome, { recursive: true });
    mkdirSync(cacheHome, { recursive: true });
    mkdirSync(configHome, { recursive: true });
    mkdirSync(stateHome, { recursive: true });

    const argv = [
      'opencode',
      'run',
      // Do not load ambient plugins. A review must behave the same on a clean Actions
      // runner and on a developer machine with a customised opencode installation.
      '--pure',
      '--format',
      'json',
      '--dir',
      // Symlink-resolved: opencode resolves the files it reads, so an unresolved --dir
      // makes it treat the repo's own files as an external directory and refuse them.
      realOrSelf(ctx.repoDir),
      '-m',
      ctx.model,
      ctx.prompt,
    ];

    // `variant` is opencode's reasoning-effort knob (low|high|max on the reasoning models).
    const variant = ctx.args['variant'];
    if (variant !== undefined && variant !== null && String(variant).trim() !== '') {
      argv.push('--variant', String(variant));
    }

    return {
      argv,
      env: {
        ...ctx.env,
        // opencode otherwise merges user and project configuration into OPENCODE_CONFIG.
        // Besides making runs non-reproducible, a PR-controlled opencode.json could enable
        // tools or instructions before the review prompt is applied. Give the process a
        // private home and explicitly disable every ambient instruction/config source.
        HOME: home,
        OPENCODE_CONFIG: configPath,
        OPENCODE_CONFIG_DIR: configHome,
        OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
        OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
        OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: 'true',
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'true',
        OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
        XDG_DATA_HOME: dataHome,
        XDG_CACHE_HOME: cacheHome,
        XDG_CONFIG_HOME: configHome,
        XDG_STATE_HOME: stateHome,
      },
      // opencode blocks on an open stdin pipe; an unclosed stdin costs a full timeout.
      stdin: '',
      cwd: realOrSelf(ctx.repoDir),
    };
  },

  parse(io: HarnessIO, ctx: RunContext): HarnessResult {
    const events = parseJsonl(io.stdout);

    const textParts: { messageId: string; text: string }[] = [];
    let lastMessageId = '';
    const totals: CanonicalUsage = { uncachedIn: 0, cacheRead: 0, cacheWrite: 0, out: 0 };
    let turns = 0;
    let costUsd = 0;
    let sawCost = false;

    for (const ev of events) {
      const part = isRecord(ev['part']) ? ev['part'] : null;
      if (!part) continue;

      if (ev['type'] === 'text') {
        const messageId = typeof part['messageID'] === 'string' ? part['messageID'] : '';
        textParts.push({ messageId, text: typeof part['text'] === 'string' ? part['text'] : '' });
        lastMessageId = messageId;
        continue;
      }

      if (ev['type'] !== 'step_finish') continue;
      turns += 1;

      const tokens = isRecord(part['tokens']) ? part['tokens'] : null;
      if (tokens) {
        // `input` already excludes cache here — subtracting would zero out a cache-heavy run.
        totals.uncachedIn += num(tokens['input']);
        totals.out += num(tokens['output']);
        const cache = isRecord(tokens['cache']) ? tokens['cache'] : null;
        if (cache) {
          totals.cacheRead += num(cache['read']);
          totals.cacheWrite += num(cache['write']);
        }
      }

      const cost = part['cost'];
      if (typeof cost === 'number' && Number.isFinite(cost)) {
        costUsd += cost;
        sawCost = true;
      }
    }

    // Intermediate steps emit "\n\n" filler under their own message id; only the last
    // message is the answer.
    const rawText = textParts
      .filter((p) => p.messageId === lastMessageId)
      .map((p) => p.text)
      .join('');

    const diagnostics: string[] = [];
    // A blocked write surfaces on stderr as an auto-rejected permission prompt and nowhere
    // else — without this the run just looks like a model that forgot to write its report.
    for (const line of io.stderr.split('\n')) {
      const trimmed = line.trim();
      const lower = trimmed.toLowerCase();
      if (lower.includes('permission requested')) diagnostics.push(trimmed);
      // Should be impossible now that every run gets its own XDG_DATA_HOME, but if it ever
      // reappears it is worth naming precisely rather than reading as "the model said nothing".
      if (lower.includes('database is locked')) {
        diagnostics.push('opencode session database was locked — data dir isolation failed');
      }
    }
    if (events.length === 0) diagnostics.push('opencode emitted no JSON events on stdout');

    let report: ModelReport | null = null;
    // Referee and verifier calls deliberately write different JSON contracts. Their callers
    // parse those files after runHarness returns; treating verdict.json as a ModelReport only
    // produces alarming-but-false "merge_confidence missing" diagnostics.
    if (basename(ctx.findingsPath) === 'findings.json') {
      // The written file wins; the fenced-block parse of the final message is the fallback
      // for a model that answered in prose instead of using its write tool.
      const file = readReportSafely(ctx.findingsPath);
      report = file.report;
      diagnostics.push(...file.problems);
      if (!report && rawText.trim()) {
        const fromText = parseTextSafely(rawText);
        diagnostics.push(...fromText.problems);
        if (fromText.report) {
          report = fromText.report;
          diagnostics.push('findings file missing — recovered the report from the final message');
        }
      }
    }

    return {
      report,
      // No step_finish means no measurement at all — null makes the receipt say "unknown"
      // instead of a confident $0.00.
      usage: turns > 0 ? totals : null,
      reportedCostUsd: sawCost ? costUsd : null,
      turns,
      truncated: io.timedOut,
      rawText,
      diagnostics,
    };
  },
} satisfies Harness;
