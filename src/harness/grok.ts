/**
 * Grok Build adapter.
 *
 * The flags below are confirmed present on grok 0.2.118. The output parser remains
 * deliberately tolerant because Grok has emitted more than one headless envelope shape —
 * see `docs/harness-notes.md`. It tries documented keys in order and, when nothing matches,
 * reports `usage: null` so the cost engine prints "unknown" rather than a made-up number.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
import { log } from '../util/log.js';
import { run, which } from '../util/proc.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Grok discovers rules, hooks, plugins, skills, MCP servers, and permission overrides from
 * both its working directory and home. Neither may be the reviewed checkout or the
 * operator's real home while a provider credential is present.
 */
function runtimeRoot(ctx: RunContext): string {
  const key = createHash('sha256').update(resolve(ctx.scratchDir)).digest('hex').slice(0, 16);
  let root = join(tmpdir(), 'juror-grok', key);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    root = realpathSync(root);
  } catch {
    // The directory was just created; `resolve` is still a safe cleanup target if a
    // platform-specific realpath race removes it before this call.
    root = resolve(root);
  }
  return root;
}

function physical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function tomlString(value: string): string {
  // JSON strings are valid TOML basic strings and correctly escape Windows separators.
  return JSON.stringify(value);
}

function isAbnormalStopReason(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /(?:max[_ -]?turn|turn[_ -]?limit|budget|cancel|interrupt|error|timeout|length)/i.test(value)
  );
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

/** Whole-stdout JSON first, then the last parseable JSONL line — we do not know which we get. */
function parseEnvelope(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  try {
    const whole: unknown = JSON.parse(trimmed);
    if (isRecord(whole)) return whole;
  } catch {
    // not a single object — fall through to JSONL
  }

  const lines = trimmed.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (!line || !line.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) return parsed;
    } catch {
      // keep walking backwards
    }
  }
  return null;
}

function pickText(root: Record<string, unknown>): string {
  for (const key of ['text', 'result', 'response', 'message']) {
    const v = root[key];
    if (typeof v === 'string' && v.trim()) return v;
    // `message` is the key most likely to arrive as `{ content: "..." }`.
    if (isRecord(v) && typeof v['content'] === 'string' && v['content'].trim()) return v['content'];
  }
  return '';
}

/**
 * Two candidate shapes: the Anthropic-style one Grok's docs imply, where `input_tokens`
 * EXCLUDES cache, and the OpenAI-style one, where `prompt_tokens` INCLUDES it. Guessing
 * wrong on the second overbills a cache-heavy run by roughly 10x, so the two are handled
 * separately rather than merged.
 */
function pickUsage(root: Record<string, unknown>): CanonicalUsage | null {
  const u = isRecord(root['usage']) ? root['usage'] : root;

  if ('input_tokens' in u || 'output_tokens' in u) {
    return {
      uncachedIn: num(u['input_tokens']),
      cacheRead: num(u['cache_read_input_tokens']),
      cacheWrite: num(u['cache_creation_input_tokens']),
      out: num(u['output_tokens']),
    };
  }

  if ('prompt_tokens' in u || 'completion_tokens' in u) {
    const details = isRecord(u['prompt_tokens_details']) ? u['prompt_tokens_details'] : null;
    const cached = num(details ? details['cached_tokens'] : u['cached_tokens']);
    return {
      uncachedIn: Math.max(0, num(u['prompt_tokens']) - cached),
      cacheRead: cached,
      cacheWrite: 0,
      out: num(u['completion_tokens']),
    };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────────

export const grokHarness = {
  id: 'grok-build',
  label: 'Grok Build',

  async locate(env?: Record<string, string | undefined>): Promise<HarnessLocation> {
    const binPath = await which('grok');
    if (!binPath) {
      throw new Error('grok not found on PATH — install Grok Build or disable the model in .juror.yml');
    }
    // Even version probing should not inherit project/user startup discovery or a paid key.
    // Current Grok exits before loading extensions here, but keeping the probe isolated makes
    // that an implementation detail rather than a credential-bearing assumption.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'juror-grok-version-')));
    const home = join(root, 'home');
    const grokHome = join(home, '.grok');
    mkdirSync(grokHome, { recursive: true, mode: 0o700 });
    let io: HarnessIO;
    try {
      io = await run([binPath, '--version'], {
        cwd: root,
        timeoutMs: 15_000,
        env: {
          ...env,
          HOME: home,
          GROK_HOME: grokHome,
          XAI_API_KEY: undefined,
          GROK_DISABLE_AUTOUPDATER: '1',
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    const version = (io.stdout.trim() || io.stderr.trim()).split('\n')[0]?.trim() ?? '';
    const warnings: string[] = [];
    if (io.exitCode !== 0) warnings.push(`grok --version exited ${io.exitCode}`);
    if (!version) warnings.push('grok reported no version string');
    return { binPath, version, warnings };
  },

  command(ctx: RunContext): HarnessCommand {
    const root = runtimeRoot(ctx);
    // A retry gets a fresh session/config tree. Session transcripts can contain source and
    // prompt excerpts, so every directory is private even on a permissive runner umask.
    rmSync(root, { recursive: true, force: true });
    const home = join(root, 'home');
    const grokHome = join(home, '.grok');
    const cwd = join(root, 'workspace');
    const cacheHome = join(root, 'cache');
    const configHome = join(root, 'config');
    const dataHome = join(root, 'data');
    const stateHome = join(root, 'state');
    const tempHome = join(root, 'tmp');
    for (const dir of [root, home, grokHome, cwd, cacheHome, configHome, dataHome, stateHome, tempHome]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    // `strict` alone can read only the private cwd and system paths. Add exactly the sealed
    // review checkout and Juror scratch as read-only roots; PR-controlled `.grok` files are
    // children to inspect, never startup configuration because Grok starts outside the repo.
    writeFileSync(
      join(grokHome, 'sandbox.toml'),
      [
        '[profiles.juror-review]',
        'extends = "strict"',
        `read_only = [${tomlString(physical(ctx.repoDir))}, ${tomlString(physical(ctx.scratchDir))}]`,
        '',
      ].join('\n'),
      { encoding: 'utf8', mode: 0o600 },
    );
    writeFileSync(
      join(grokHome, 'config.toml'),
      [
        '[cli]',
        'auto_update = false',
        '[features]',
        'telemetry = false',
        'codebase_indexing = false',
        'remote_fetch = false',
        '[session]',
        'load_envrc = false',
        '[hints]',
        'project_picker_disabled = true',
        '[compat.cursor]',
        'skills = false',
        'rules = false',
        'agents = false',
        'mcps = false',
        'hooks = false',
        'sessions = false',
        '[compat.claude]',
        'skills = false',
        'rules = false',
        'agents = false',
        'mcps = false',
        'hooks = false',
        'sessions = false',
        '[compat.codex]',
        'sessions = false',
        '',
      ].join('\n'),
      { encoding: 'utf8', mode: 0o600 },
    );

    const argv = [
      'grok',
      '--prompt-file',
      ctx.promptPath,
      '-m',
      ctx.model,
      '--output-format',
      'json',
      // Kernel-enforced (Landlock/bubblewrap on Linux, Seatbelt on macOS), unlike a prompt
      // instruction. The named profile lives only in the private GROK_HOME above.
      '--sandbox',
      'juror-review',
      '--tools',
      'Read,Grep,Glob',
      // `--tools` filters built-ins but deliberately keeps MCP meta-tools. There should be
      // no discovered servers in this empty home/cwd; the deny is a second independent gate.
      '--deny',
      'MCPTool(*)',
      '--permission-mode',
      'dontAsk',
      '--no-subagents',
      '--no-memory',
      '--disable-web-search',
    ];
    // Grok has no documented unlimited sentinel, so omission is the unbounded form.
    if (ctx.maxTurns > 0) argv.push('--max-turns', String(ctx.maxTurns));

    const rawEffort = ctx.args['reasoning_effort'];
    if (rawEffort !== undefined && rawEffort !== null && String(rawEffort).trim()) {
      const effort = String(rawEffort).trim();
      if (/^[A-Za-z0-9_-]+$/.test(effort)) argv.push('--reasoning-effort', effort);
      else log.warn(`ignoring unusable Grok reasoning_effort ${JSON.stringify(rawEffort)}`);
    }

    return {
      argv,
      // An auto-update mid-run silently changes the binary we asserted the version of.
      env: {
        ...ctx.env,
        HOME: home,
        GROK_HOME: grokHome,
        XDG_CACHE_HOME: cacheHome,
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: dataHome,
        XDG_STATE_HOME: stateHome,
        TMPDIR: tempHome,
        GROK_DISABLE_AUTOUPDATER: '1',
      },
      stdin: '',
      cwd,
    };
  },

  parse(io: HarnessIO, ctx: RunContext): HarnessResult {
    const diagnostics: string[] = [];
    const root = parseEnvelope(io.stdout);

    // The report comes from the file the agent wrote, so it survives even a completely
    // unrecognized stdout envelope.
    const file = readReportSafely(ctx.findingsPath);
    let report = file.report;
    diagnostics.push(...file.problems);

    const recoverFromText = (text: string): void => {
      if (report || !text.trim()) return;
      const fromText = parseTextSafely(text);
      diagnostics.push(...fromText.problems);
      if (fromText.report) {
        report = fromText.report;
        diagnostics.push('findings file missing — recovered the report from the final message');
      }
    };

    if (!root) {
      // Deliberate: with no envelope we have no token counts and no cost, so we report
      // nothing rather than something. `usage: null` + `reportedCostUsd: null` makes the
      // cost engine print "unknown", which is the one honest answer here. Inventing a
      // zero would quietly understate the bill this whole project exists to show.
      diagnostics.push('grok output was neither a JSON object nor parseable JSONL — cost is unknown');
      if (io.exitCode !== 0) diagnostics.push(`grok exited ${io.exitCode}`);
      recoverFromText(io.stdout);
      return {
        report,
        usage: null,
        reportedCostUsd: null,
        turns: 0,
        truncated: io.timedOut || io.exitCode !== 0,
        rawText: io.stdout.trim(),
        diagnostics,
      };
    }

    const usage = pickUsage(root);
    if (!usage) diagnostics.push('grok reported no usage block — cost is unknown');
    if (root['is_error'] === true) diagnostics.push('grok flagged is_error on its final envelope');

    const stopReason = root['stop_reason'] ?? root['terminal_reason'];
    if (typeof stopReason === 'string' && stopReason && stopReason !== 'end_turn') {
      diagnostics.push(`grok stop reason: ${stopReason}`);
    }

    const rawText = pickText(root) || io.stdout.trim();
    recoverFromText(rawText);
    const turns = Math.trunc(num(root['num_turns']) || num(root['turns']));
    const partial =
      io.timedOut ||
      io.exitCode !== 0 ||
      root['is_error'] === true ||
      isAbnormalStopReason(stopReason) ||
      (ctx.maxTurns > 0 && turns >= ctx.maxTurns);

    return {
      report,
      usage,
      reportedCostUsd: finiteOrNull(root['total_cost_usd']) ?? finiteOrNull(root['cost']),
      turns,
      truncated: partial,
      rawText,
      diagnostics,
    };
  },

  cleanup(ctx: RunContext): void {
    rmSync(runtimeRoot(ctx), { recursive: true, force: true });
  },
} satisfies Harness;
