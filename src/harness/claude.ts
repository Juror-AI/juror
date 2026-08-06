/**
 * Claude Code adapter — `claude -p --output-format json`.
 *
 * Shapes here were measured against claude 2.1.223 (see `.context/HARNESS-PROBES.md`);
 * they are ground truth and outrank the docs.
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

// ─────────────────────────────────────────────────────────────────────────────
// Narrowing helpers — every field below crosses a trust boundary as `unknown`
// ─────────────────────────────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** stderr is noisy (connector warnings on every run); keep it bounded and redacted. */
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

/** The single stdout object, with a per-line retry in case anything prefixed it. */
function parseStdoutObject(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    // fall through
  }
  for (const line of trimmed.split(/\r?\n/).reverse()) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const obj = asRecord(JSON.parse(t));
      if (obj) return obj;
    } catch {
      // keep scanning upward
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────────

export const claudeHarness: Harness = {
  id: 'claude-code',
  label: 'Claude Code',

  async locate(): Promise<HarnessLocation> {
    const binPath = await which('claude');
    if (!binPath) {
      throw new Error('claude not found on PATH — install @anthropic-ai/claude-code');
    }
    const warnings: string[] = [];
    const io = await run([binPath, '--version'], { timeoutMs: 15_000 });
    const raw = `${io.stdout} ${io.stderr}`.trim();
    const m = /(\d+\.\d+\.\d+)/.exec(raw);
    const version = m?.[1] ?? 'unknown';
    if (!m) {
      warnings.push(`could not parse a version from \`claude --version\` (${raw.slice(0, 120)})`);
      log.warn(`claude --version was unparseable: ${raw.slice(0, 120)}`);
    }
    log.debug(`claude binary: ${binPath} (${version})`);
    return { binPath, version, warnings };
  },

  command(ctx: RunContext): HarnessCommand {
    // `--tools` REMOVES everything not listed; `--allowedTools` would only auto-approve.
    const argv = [
      'claude',
      '-p',
      ctx.prompt,
      '--model',
      ctx.model,
      '--output-format',
      'json',
      '--tools',
      'Read,Grep,Glob,Write',
      '--add-dir',
      ctx.scratchDir,
      '--max-turns',
      String(ctx.maxTurns),
    ];
    if (ctx.budgetUsd !== null && ctx.budgetUsd > 0) {
      argv.push('--max-budget-usd', String(ctx.budgetUsd));
    }
    return { argv, env: ctx.env, stdin: '', cwd: ctx.repoDir };
  },

  parse(io: HarnessIO, ctx: RunContext): HarnessResult {
    const diagnostics = stderrDiagnostics(io.stderr);
    const obj = parseStdoutObject(io.stdout);

    // No JSON envelope: the file the agent wrote is still the source of truth, but we
    // have no usage to bill from, and `null` usage is what makes the cost `unknown`
    // instead of a fabricated zero.
    if (!obj) {
      const file = readReportSafely(ctx.findingsPath);
      diagnostics.push(...file.problems);
      if (io.stdout.trim()) diagnostics.push('stdout was not JSON — parsed the findings file only');
      return {
        report: file.report,
        usage: null,
        reportedCostUsd: null,
        turns: 0,
        truncated: io.timedOut,
        rawText: io.stdout,
        diagnostics,
      };
    }

    const rawText = typeof obj['result'] === 'string' ? obj['result'] : '';

    // The written file wins; the fenced-block parse of `.result` is the fallback for a
    // model that answered in prose instead of using its Write tool.
    const file = readReportSafely(ctx.findingsPath);
    let report = file.report;
    diagnostics.push(...file.problems);
    if (!report && rawText) {
      const fromText = parseTextSafely(rawText);
      diagnostics.push(...fromText.problems);
      if (fromText.report) {
        report = fromText.report;
        diagnostics.push('findings file missing — recovered the report from the final message');
      }
    }

    const u = asRecord(obj['usage']);
    // `input_tokens` here already excludes cached tokens (observed 6 against a
    // cache_read of 12133) — unlike codex, do not subtract.
    const usage: CanonicalUsage | null = u
      ? {
          uncachedIn: numOr(u['input_tokens'], 0),
          cacheRead: numOr(u['cache_read_input_tokens'], 0),
          cacheWrite: numOr(u['cache_creation_input_tokens'], 0),
          out: numOr(u['output_tokens'], 0),
        }
      : null;

    const denials = obj['permission_denials'];
    if (Array.isArray(denials)) {
      for (const d of denials) {
        const rec = asRecord(d);
        const tool = rec && typeof rec['tool_name'] === 'string' ? rec['tool_name'] : null;
        diagnostics.push(redact(tool ? `permission denied: ${tool}` : `permission denied: ${JSON.stringify(d)}`));
      }
    }

    const subtype = typeof obj['subtype'] === 'string' ? obj['subtype'] : null;
    const stopReason = typeof obj['stop_reason'] === 'string' ? obj['stop_reason'] : null;

    return {
      report,
      usage,
      reportedCostUsd: typeof obj['total_cost_usd'] === 'number' ? obj['total_cost_usd'] : null,
      turns: numOr(obj['num_turns'], 0),
      truncated: io.timedOut || stopReason === 'max_turns' || subtype !== 'success',
      rawText,
      diagnostics,
    };
  },
};
