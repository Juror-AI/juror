/**
 * Codex CLI adapter — `codex exec --json`.
 *
 * Two measured facts drive everything here (`docs/harness-notes.md`):
 * codex's `input_tokens` INCLUDES the cached tokens, and an `item.type === "error"`
 * event is a non-fatal note that shows up on perfectly successful exit-0 runs.
 */

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
import { log, redact } from '../util/log.js';
import { run, which } from '../util/proc.js';
import { parseModelReport, readReportFile } from '../report.js';

/** `cache_write_input_tokens` does not exist before this release — cache writes bill at 1.25x. */
const MIN_VERSION = '0.146.0';

const DEFAULT_REASONING_EFFORT = 'high';

// ─────────────────────────────────────────────────────────────────────────────
// Narrowing helpers
// ─────────────────────────────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

const MAX_STDERR_DIAGNOSTICS = 20;

function stderrDiagnostics(stderr: string): string[] {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const kept = lines.slice(0, MAX_STDERR_DIAGNOSTICS).map((l) => redact(l));
  if (lines.length > kept.length) kept.push(`… ${lines.length - kept.length} more stderr line(s)`);
  return kept;
}

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

/** -1 / 0 / 1, on the leading `major.minor.patch` of each side. */
function compareSemver(a: string, b: string): number {
  const parse = (s: string): number[] => {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(s);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  };
  const av = parse(a);
  const bv = parse(b);
  for (let i = 0; i < 3; i++) {
    const x = av[i] ?? 0;
    const y = bv[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────────

export const codexHarness: Harness = {
  id: 'codex',
  label: 'Codex',

  async locate(): Promise<HarnessLocation> {
    const binPath = await which('codex');
    if (!binPath) {
      throw new Error('codex not found on PATH — install @openai/codex');
    }
    // Two codex installs shadowing each other by PATH order is an observed failure
    // (0.132.0 in the Homebrew prefix, 0.146.1 in the fnm prefix). Log which one won.
    log.info(`codex binary: ${binPath}`);

    const warnings: string[] = [];
    const io = await run([binPath, '--version'], { timeoutMs: 15_000 });
    const raw = `${io.stdout} ${io.stderr}`.trim();
    const m = /(\d+\.\d+\.\d+)/.exec(raw);
    const version = m?.[1] ?? 'unknown';
    if (!m) {
      warnings.push(`could not parse a version from \`codex --version\` (${raw.slice(0, 120)})`);
      log.warn(`codex --version was unparseable: ${raw.slice(0, 120)}`);
    } else if (compareSemver(version, MIN_VERSION) < 0) {
      const msg =
        `codex ${version} at ${binPath} predates ${MIN_VERSION}: it does not emit ` +
        'cache_write_input_tokens, so cache writes will be billed as zero';
      warnings.push(msg);
      log.warn(msg);
    }
    return { binPath, version, warnings };
  },

  command(ctx: RunContext): HarnessCommand {
    const raw = ctx.args['reasoning_effort'];
    let effort = typeof raw === 'string' && raw.trim() ? raw.trim() : DEFAULT_REASONING_EFFORT;
    // The value lands inside a `-c key=value` override, so keep it to a bare token.
    if (!/^[A-Za-z0-9_-]+$/.test(effort)) {
      log.warn(`ignoring unusable reasoning_effort ${JSON.stringify(raw)}; using ${DEFAULT_REASONING_EFFORT}`);
      effort = DEFAULT_REASONING_EFFORT;
    }

    const argv = [
      'codex',
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '-c',
      `sandbox_workspace_write.writable_roots=["${ctx.scratchDir}"]`,
      '-m',
      ctx.model,
      '-c',
      `model_reasoning_effort=${effort}`,
      // A user's global config leaks MCP servers and stale OAuth errors into the run.
      '--ignore-user-config',
      '--skip-git-repo-check',
    ];

    // `exec` reads stdin even when given a positional prompt; a job that leaves stdin
    // open hangs until the timeout, so the prompt is delivered there instead.
    return { argv, env: ctx.env, stdin: ctx.prompt, cwd: ctx.repoDir };
  },

  parse(io: HarnessIO, ctx: RunContext): HarnessResult {
    const diagnostics = stderrDiagnostics(io.stderr);

    let finalText = '';
    let usage: CanonicalUsage | null = null;
    let turns = 0;

    for (const line of io.stdout.split(/\r?\n/)) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(t);
      } catch {
        continue; // interleaved non-JSON noise is expected; ignore it
      }
      const ev = asRecord(parsed);
      if (!ev) continue;
      const type = typeof ev['type'] === 'string' ? ev['type'] : '';

      if (type === 'item.completed') {
        const item = asRecord(ev['item']);
        const itemType = item && typeof item['type'] === 'string' ? item['type'] : '';
        if (item && itemType === 'agent_message') {
          // Last agent_message wins — earlier ones are intermediate narration.
          if (typeof item['text'] === 'string') finalText = item['text'];
        } else if (item && itemType === 'error') {
          const detail =
            typeof item['message'] === 'string'
              ? item['message']
              : typeof item['text'] === 'string'
                ? item['text']
                : JSON.stringify(item);
          diagnostics.push(redact(`codex error item (non-fatal): ${detail}`));
        }
        continue;
      }

      if (type === 'turn.completed') {
        turns++;
        const u = asRecord(ev['usage']);
        if (u) {
          const input = numOr(u['input_tokens'], 0);
          const cached = numOr(u['cached_input_tokens'], 0);
          usage = {
            // CRITICAL: codex's input_tokens is a SUPERSET that includes the cached
            // tokens. Not subtracting overbills a cache-heavy run by ~10x.
            uncachedIn: Math.max(0, input - cached),
            cacheRead: cached,
            cacheWrite: numOr(u['cache_write_input_tokens'], 0),
            // reasoning_output_tokens is already inside output_tokens; adding it double-counts.
            out: numOr(u['output_tokens'], 0),
          };
        }
      }
    }

    // Success is "a turn completed", never "no error items" — errors are advisory.
    const completed = turns > 0;
    if (!completed) diagnostics.push('no turn.completed event — the run did not finish a turn');

    const file = readReportSafely(ctx.findingsPath);
    let report = file.report;
    diagnostics.push(...file.problems);
    if (!report && finalText) {
      const fromText = parseTextSafely(finalText);
      diagnostics.push(...fromText.problems);
      if (fromText.report) {
        report = fromText.report;
        diagnostics.push('findings file missing — recovered the report from the final message');
      }
    }

    return {
      report,
      usage,
      // codex emits no cost field at all; the receipt has to estimate from tokens.
      reportedCostUsd: null,
      turns,
      truncated: io.timedOut || !completed,
      rawText: finalText,
      diagnostics,
    };
  },
};
