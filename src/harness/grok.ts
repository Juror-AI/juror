/**
 * Grok Build adapter.
 *
 * The flags below are confirmed present on grok 0.2.118, but no `XAI_API_KEY` was
 * available when this was written, so the **output shape is unverified** — see
 * `.context/HARNESS-PROBES.md`. Everything in `parse()` is therefore written to survive
 * a shape we have not seen: try the documented keys in order, and when nothing matches,
 * report `usage: null` so the cost engine prints "unknown" rather than a made-up number.
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
import { parseModelReport, readReportFile } from '../report.js';
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

  async locate(): Promise<HarnessLocation> {
    const binPath = await which('grok');
    if (!binPath) {
      throw new Error('grok not found on PATH — install Grok Build or disable the model in .juror.yml');
    }
    const io = await run([binPath, '--version'], {
      timeoutMs: 15_000,
      env: { GROK_DISABLE_AUTOUPDATER: '1' },
    });
    const version = (io.stdout.trim() || io.stderr.trim()).split('\n')[0]?.trim() ?? '';
    const warnings: string[] = [];
    if (io.exitCode !== 0) warnings.push(`grok --version exited ${io.exitCode}`);
    if (!version) warnings.push('grok reported no version string');
    return { binPath, version, warnings };
  },

  command(ctx: RunContext): HarnessCommand {
    return {
      argv: [
        'grok',
        '-p',
        ctx.prompt,
        '-m',
        ctx.model,
        '--output-format',
        'json',
        // Kernel-enforced (Landlock on Linux runners), unlike Claude Code's tool removal.
        '--sandbox',
        'workspace',
        '--tools',
        'read_file,grep,list_dir,write_file',
        '--max-turns',
        String(ctx.maxTurns),
        '--disable-web-search',
      ],
      // An auto-update mid-run silently changes the binary we asserted the version of.
      env: { ...ctx.env, GROK_DISABLE_AUTOUPDATER: '1' },
      stdin: '',
      cwd: ctx.repoDir,
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
        truncated: io.timedOut,
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

    return {
      report,
      usage,
      reportedCostUsd: finiteOrNull(root['total_cost_usd']) ?? finiteOrNull(root['cost']),
      turns: Math.trunc(num(root['num_turns']) || num(root['turns'])),
      truncated: io.timedOut,
      rawText,
      diagnostics,
    };
  },
} satisfies Harness;
