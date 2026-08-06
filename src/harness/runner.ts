/**
 * Fan-out: run every enabled model concurrently, in its own scratch dir, with its own
 * key and nothing else. The contract of this module is *degrade, never fail* — a model
 * that is missing a key, crashes, times out, or babbles becomes a `ModelRun` describing
 * exactly that, and the other models' reviews still get published.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  CostBreakdown,
  DiffContext,
  Harness,
  HarnessIO,
  HarnessResult,
  JurorConfig,
  ModelConfig,
  ModelRun,
  PricingTable,
  RunContext,
} from '../types.js';
import { log } from '../util/log.js';
import { run } from '../util/proc.js';
import { renderTemplate, resolveModelRuntime } from '../config.js';
import { computeCost } from '../cost/compute.js';
import { getHarness } from './registry.js';
import { runGenericOpenAI } from './generic-openai.js';

export interface FanOutOptions {
  config: JurorConfig;
  diff: DiffContext;
  repoDir: string;
  scratchRoot: string;
  /** Still holds `{{FINDINGS_PATH}}` and `{{SCRATCH}}` — filled in per model below. */
  promptTemplate: string;
  /** Everything else the template needs, already resolved by the caller. */
  promptVars: Record<string, string>;
  pricing: PricingTable;
  secrets: Record<string, string | undefined>;
  signal?: AbortSignal;
}

/**
 * Ambient variables a CLI genuinely needs to start. `NODE_OPTIONS` is deliberately
 * absent: it can inject a `--require` into every harness we spawn.
 */
const ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM'];

const ZERO_COST: CostBreakdown = { usd: 0, source: 'estimated', longContext: false };
const UNKNOWN_COST: CostBreakdown = { usd: null, source: 'unknown', longContext: false };

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

/** Filesystem-safe form of a model id (`accounts/fireworks/models/kimi-k3` → `…-kimi-k3`). */
export function slug(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out || 'model';
}

export function harnessScratch(scratchRoot: string, modelId: string): string {
  return join(scratchRoot, slug(modelId));
}

// ─────────────────────────────────────────────────────────────────────────────
// Single run
// ─────────────────────────────────────────────────────────────────────────────

function errText(e: unknown): string {
  if (e instanceof Error) return e.message || String(e);
  return String(e);
}

async function dumpIo(scratchDir: string, io: HarnessIO): Promise<void> {
  try {
    await Promise.all([
      writeFile(join(scratchDir, 'stdout.log'), io.stdout, 'utf8'),
      writeFile(join(scratchDir, 'stderr.log'), io.stderr, 'utf8'),
    ]);
  } catch {
    // Debug aid only — never let it affect the run.
  }
}

/**
 * `run()` layers its env over `process.env`, so an allowlisted env is not enough on its
 * own: every ambient variable has to be explicitly cleared, or a fan-out of four models
 * hands all four providers all four API keys. Node drops keys whose value is `undefined`.
 */
function isolate(env: Record<string, string>): Record<string, string | undefined> {
  const cleared: Record<string, string | undefined> = {};
  for (const k of Object.keys(process.env)) cleared[k] = undefined;
  return { ...cleared, ...env };
}

export async function runHarness(
  h: Harness,
  ctx: RunContext,
  signal?: AbortSignal,
): Promise<HarnessResult> {
  try {
    // The escape-hatch adapter drives an OpenAI-compatible endpoint from inside this
    // process — it has no CLI to spawn, so `command()` deliberately throws for it.
    if (h.id === 'generic-openai') return await runGenericOpenAI(ctx);

    const cmd = h.command(ctx);
    const io = await run(cmd.argv, {
      cwd: cmd.cwd,
      env: isolate(cmd.env),
      stdin: cmd.stdin,
      timeoutMs: ctx.timeoutMs,
      signal,
    });
    // Kept alongside the prompt so `--keep-scratch` gives you the exact bytes the harness
    // produced. Reconstructing a failed agent run from a one-line diagnostic is miserable.
    await dumpIo(ctx.scratchDir, io);

    const result = h.parse(io, ctx);
    if (io.timedOut) {
      result.diagnostics.push(`timed out after ${Math.round(ctx.timeoutMs / 1000)}s`);
    } else if (io.exitCode !== 0) {
      result.diagnostics.push(`${h.id} exited ${io.exitCode}${io.signal ? ` (${io.signal})` : ''}`);
    }
    return result;
  } catch (e) {
    // A spawn failure (missing binary, bad cwd) is data, not an exception to propagate.
    return {
      report: null,
      usage: null,
      reportedCostUsd: null,
      turns: 0,
      truncated: false,
      rawText: '',
      diagnostics: [`${h.id} failed to run: ${errText(e)}`],
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fan-out
// ─────────────────────────────────────────────────────────────────────────────

function hasKey(v: string | undefined): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** The PR budget split evenly across the models that will actually run. */
function perModelBudget(maxUsdPerPr: number, runnable: number): number | null {
  if (!Number.isFinite(maxUsdPerPr) || maxUsdPerPr <= 0 || runnable <= 0) return null;
  return Math.round((maxUsdPerPr / runnable) * 10_000) / 10_000;
}

function childEnv(
  ambient: Record<string, string | undefined>,
  secretName: string,
  secretValue: string,
  extras: string[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...ENV_ALLOWLIST, ...extras]) {
    const v = ambient[name];
    if (typeof v === 'string') env[name] = v;
  }
  // Exactly one provider key per child. A harness that can be prompt-injected into
  // exfiltrating its environment must not be able to leak a sibling model's key.
  env[secretName] = secretValue;
  return env;
}

/** Per-model env names a config may need forwarded (proxies, custom CA bundles, …). */
function envPassthrough(m: ModelConfig): string[] {
  const raw = m.args?.['env_passthrough'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v));
}

export async function fanOut(o: FanOutOptions): Promise<ModelRun[]> {
  const ambient: Record<string, string | undefined> = process.env;
  const enabled = o.config.models.filter((m) => m.enabled);
  const runnable = enabled.filter((m) => hasKey(o.secrets[m.secret]));
  const budgetUsd = perModelBudget(o.config.budget.max_cost_usd_per_pr, runnable.length);

  log.debug(
    `fan-out: ${runnable.length} runnable, ${enabled.length - runnable.length} without a key, ` +
      `per-model budget ${budgetUsd === null ? 'none' : `$${budgetUsd}`}`,
  );

  // Promise.all is safe because the wrapper below cannot reject.
  return Promise.all(enabled.map((m) => runOne(m, o, ambient, budgetUsd)));
}

async function runOne(
  m: ModelConfig,
  o: FanOutOptions,
  ambient: Record<string, string | undefined>,
  budgetUsd: number | null,
): Promise<ModelRun> {
  const started = Date.now();
  let modelLabel = m.label ?? m.id;
  let pricingKey = m.pricing_key ?? m.id;
  let harnessLabel: string = m.harness;

  try {
    const rt = resolveModelRuntime(m);
    modelLabel = rt.label;
    pricingKey = rt.pricingKey;

    const h = getHarness(m.harness);
    harnessLabel = h.label;

    const key = o.secrets[m.secret];
    if (!hasKey(key)) {
      log.info(`${modelLabel}: skipped (no ${m.secret})`);
      return {
        modelId: m.id,
        modelLabel,
        harness: m.harness,
        harnessLabel,
        pricingKey,
        ok: false,
        skipped: true,
        skipReason: `no ${m.secret} in environment`,
        result: null,
        cost: { ...ZERO_COST },
        durationMs: 0,
        error: null,
      };
    }

    const scratchDir = harnessScratch(o.scratchRoot, m.id);
    await mkdir(scratchDir, { recursive: true });
    const findingsPath = join(scratchDir, 'findings.json');

    // Rendered here, once, so each model is told to write to its OWN findings file rather
    // than a shared one every model would clobber. Single pass on purpose: the diff is
    // attacker-controlled and must not be rescanned for placeholders after substitution.
    const prompt = renderTemplate(o.promptTemplate, {
      ...o.promptVars,
      FINDINGS_PATH: findingsPath,
      SCRATCH: scratchDir,
    });
    const promptPath = join(scratchDir, 'prompt.md');
    await writeFile(promptPath, prompt, 'utf8');

    const ctx: RunContext = {
      repoDir: o.repoDir,
      scratchDir,
      findingsPath,
      promptPath,
      prompt,
      model: rt.harnessModel,
      ...(m.base_url ? { baseUrl: m.base_url } : {}),
      args: m.args ?? {},
      env: childEnv(ambient, m.secret, key, envPassthrough(m)),
      providerKey: key,
      timeoutMs: (m.timeout_seconds ?? o.config.review.per_model_timeout_seconds) * 1000,
      budgetUsd,
      maxTurns: m.max_turns ?? o.config.review.max_turns,
    };

    log.info(`${modelLabel}: running via ${h.label} (${rt.harnessModel})`);
    const result = await runHarness(h, ctx, o.signal);
    const durationMs = Date.now() - started;

    for (const d of result.diagnostics) log.debug(`${modelLabel}: ${d}`);

    const cost = computeCost({
      pricingKey,
      usage: result.usage,
      reportedCostUsd: result.reportedCostUsd,
      pricing: o.pricing,
      // Agent usage is summed over every round-trip, so the cost engine needs the turn
      // count to tell a 3M-token session apart from a 3M-token single request.
      turns: result.turns,
    });

    const ok = result.report !== null;
    if (!ok) log.warn(`${modelLabel}: no usable report after ${Math.round(durationMs / 1000)}s`);
    else log.info(`${modelLabel}: ${result.report?.findings.length ?? 0} finding(s) in ${Math.round(durationMs / 1000)}s`);

    return {
      modelId: m.id,
      modelLabel,
      harness: m.harness,
      harnessLabel,
      pricingKey,
      ok,
      skipped: false,
      skipReason: null,
      result,
      cost,
      durationMs,
      error: ok ? null : 'model produced no usable report',
    };
  } catch (e) {
    const message = errText(e);
    log.warn(`${modelLabel}: ${message}`);
    return {
      modelId: m.id,
      modelLabel,
      harness: m.harness,
      harnessLabel,
      pricingKey,
      ok: false,
      skipped: false,
      skipReason: null,
      result: null,
      cost: { ...UNKNOWN_COST },
      durationMs: Date.now() - started,
      error: message,
    };
  }
}
