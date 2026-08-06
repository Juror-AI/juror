/**
 * Stage 5 in consensus mode: the adversarial pass. The verifier is asked to *refute* a
 * claimed defect, and ambiguity resolves against the finding. All-findings mode bypasses
 * this stage because verification cannot affect publication there.
 *
 * Among clusters that can reach the active agreement threshold, verify every P0/P1 plus
 * every solo finding when `verifySolo`. A P2/P3 that two models found independently already
 * has its evidence.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  Cluster,
  CostBreakdown,
  DiffContext,
  ModelConfig,
  PricingTable,
  RunContext,
  Verification,
} from '../types.js';
import { renderTemplate, resolveModelRuntime } from '../config.js';
import { computeCost } from '../cost/compute.js';
import { getHarness } from '../harness/registry.js';
import { runHarness } from '../harness/runner.js';
import { loadAgentInstructions } from '../instructions.js';
import { log } from '../util/log.js';

export interface VerifyOptions {
  modelRun: ModelConfig | null;
  pricing: PricingTable;
  secrets: Record<string, string | undefined>;
  repoDir: string;
  scratchRoot: string;
  promptTemplate: string;
  diff: DiffContext;
  verifySolo: boolean;
  /** Skip clusters that cannot reach the active publication threshold. */
  minimumAgreement: number;
  signal?: AbortSignal;
}

export interface VerifyResult {
  clusters: Cluster[];
  cost: CostBreakdown;
  calls: number;
}

const ZERO_COST: CostBreakdown = { usd: 0, source: 'estimated', longContext: false };

/** Enough parallelism to hide latency, few enough to stay inside provider rate limits. */
const CONCURRENCY = 4;
const EXCERPT_CONTEXT_LINES = 24;
const MAX_EXCERPT_LINES = 220;
/**
 * Verification is a read-the-code task, and on a large monorepo that means real grepping:
 * measured on textcortex/platform, two of four verifications hit a 180s limit and came
 * back unverified. An unverified solo P0/P1 gets suppressed by the publish rule, so a
 * timeout here quietly costs recall — the cheapest fix is to stop being impatient.
 */
const VERIFY_TIMEOUT_MS = 420_000;
const VERIFY_MAX_TURNS = 12;

const ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM'];

// ─────────────────────────────────────────────────────────────────────────────
// Selection
// ─────────────────────────────────────────────────────────────────────────────

export function needsVerification(
  c: Cluster,
  verifySolo: boolean,
  minimumAgreement = 1,
): boolean {
  if (c.agreement < minimumAgreement) return false;
  if (c.severity === 'P0' || c.severity === 'P1') return true;
  return verifySolo && c.agreement === 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Diff excerpt
// ─────────────────────────────────────────────────────────────────────────────

function headerPath(raw: string): string {
  const trimmed = (raw.split('\t')[0] ?? '').trim();
  if (trimmed === '/dev/null') return '';
  return trimmed.startsWith('a/') || trimmed.startsWith('b/') ? trimmed.slice(2) : trimmed;
}

/**
 * The hunk lines around the finding, with their `@@` header so line numbers stay
 * readable. Sending the whole patch would drown a cheap verifier in unrelated files.
 */
export function diffExcerpt(diff: DiffContext, path: string, line: number): string {
  const out: string[] = [];
  const whole: string[] = [];
  let current = '';
  let newLine = 0;
  let header = '';
  let headerEmitted = false;

  for (const raw of diff.patch.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      current = '';
      continue;
    }
    if (raw.startsWith('+++ ')) {
      current = headerPath(raw.slice(4));
      continue;
    }
    if (raw.startsWith('--- ') || raw.startsWith('index ')) continue;
    if (raw.startsWith('@@')) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
      newLine = m?.[1] ? Number(m[1]) : 0;
      header = raw;
      headerEmitted = false;
      continue;
    }
    if (current !== path) continue;

    const at = newLine;
    const kind = raw.charAt(0);
    // Deletions occupy no line in the post-image, so they keep the counter where it is and
    // are reported against the line that follows them. Everything that is not a deletion
    // or a `\ No newline` marker is context — including a stripped-space empty line, the
    // same convention `diff/patch.ts` uses.
    if (kind !== '-' && kind !== '\\') newLine++;

    if (whole.length < MAX_EXCERPT_LINES) whole.push(raw);
    if (Math.abs(at - line) <= EXCERPT_CONTEXT_LINES && out.length < MAX_EXCERPT_LINES) {
      if (!headerEmitted) {
        out.push(header);
        headerEmitted = true;
      }
      out.push(raw);
    }
  }

  if (out.length > 0) return out.join('\n');
  if (whole.length > 0) return whole.join('\n');
  return `(no hunk in the diff for ${path}:${line})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tolerant JSON
// ─────────────────────────────────────────────────────────────────────────────

function extractJson(text: string): unknown {
  const candidates: string[] = [];
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const body = m[1];
    if (body) candidates.push(body);
  }
  candidates.push(text);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));

  for (const c of candidates) {
    try {
      return JSON.parse(c.trim()) as unknown;
    } catch {
      // Next candidate.
    }
  }
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A "confirmed" verdict that is not actually confident. Hedging is not confirmation. */
const HEDGE =
  /\b(unclear|uncertain|not sure|cannot (?:be )?(?:determine|confirm|verify|tell)|could not (?:determine|confirm|verify)|unable to|insufficient|no access|without (?:seeing|access)|might|maybe|possibly|appears to|seems to|likely)\b/i;

type Judgement = { refuted: boolean; reason: string } | null;

function readJudgement(raw: unknown): Judgement {
  if (!isRecord(raw)) return null;
  const reasonRaw = raw['reason'];
  const reason = typeof reasonRaw === 'string' && reasonRaw.trim() ? reasonRaw.trim() : '';

  const refutedRaw = raw['refuted'];
  let refuted: boolean;
  if (typeof refutedRaw === 'boolean') refuted = refutedRaw;
  else if (refutedRaw === 'true' || refutedRaw === 'false') refuted = refutedRaw === 'true';
  else return null;

  // Asymmetry, deliberately: a hedged "not refuted" is not evidence the finding is real.
  if (!refuted && reason && HEDGE.test(reason)) {
    return { refuted: true, reason: `verifier hedged: ${reason}` };
  }
  return { refuted, reason: reason || (refuted ? 'refuted without a reason' : 'survived refutation') };
}

// ─────────────────────────────────────────────────────────────────────────────
// The call
// ─────────────────────────────────────────────────────────────────────────────

function hasKey(v: string | undefined): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function childEnv(m: ModelConfig, secret: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ENV_ALLOWLIST) {
    const v = process.env[name];
    if (typeof v === 'string') env[name] = v;
  }
  env[m.secret] = secret;
  return env;
}

const OUTPUT_CONTRACT = `## The claimed defect

- file: {{PATH}}
- line: {{LINE}}
- severity: {{SEVERITY}}
- title: {{TITLE}}

{{BODY}}

## The diff around it

\`\`\`diff
{{DIFF}}
\`\`\`

## Output

Read the repository and try to REFUTE the claim above. Write STRICT JSON to
{{FINDINGS_PATH}} and nothing else:

{ "refuted": true, "reason": "one or two sentences citing what you read" }

Answer "refuted": false only if you confirmed the failure the claim describes. If the
evidence is not clear, answer "refuted": true.`;

function buildPrompt(template: string, vars: Record<string, string>): string {
  const rendered = renderTemplate(template, vars);
  // A template with no slot for the finding cannot verify it; append the contract.
  if (/\{\{TITLE\}\}/.test(template)) return rendered;
  return `${rendered.trim()}\n\n${renderTemplate(OUTPUT_CONTRACT, vars)}\n`;
}

interface Attempt {
  verification: Verification | null;
  cost: CostBreakdown | null;
  called: boolean;
}

async function verifyOne(
  c: Cluster,
  index: number,
  m: ModelConfig,
  key: string,
  o: VerifyOptions,
  repoInstructions: string,
): Promise<Attempt> {
  const rt = resolveModelRuntime(m);
  // Index-suffixed: two clusters on one file can share an id-shaped title hash, and two
  // concurrent verifications must never write each other's verdict file.
  const scratchDir = join(o.scratchRoot, 'verify', `${index}-${c.id}`);
  await mkdir(scratchDir, { recursive: true });

  const promptPath = join(scratchDir, 'prompt.md');
  const findingsPath = join(scratchDir, 'verdict.json');
  const excerpt = diffExcerpt(o.diff, c.path, c.line);
  const prompt = buildPrompt(o.promptTemplate, {
    SCRATCH: scratchDir,
    FINDINGS_PATH: findingsPath,
    REPO_DIR: o.repoDir,
    BASE_SHA: o.diff.baseSha,
    HEAD_SHA: o.diff.headSha,
    REPO_INSTRUCTIONS: repoInstructions,
    PATH: c.path,
    LINE: String(c.line),
    SEVERITY: c.severity,
    TITLE: c.title,
    BODY: c.body,
    // `verify.md` calls it CODE_EXCERPT; `{{DIFF}}` is filled too so a template written
    // against the shared placeholder vocabulary still renders.
    CODE_EXCERPT: excerpt,
    DIFF: excerpt,
  });
  await writeFile(promptPath, prompt, 'utf8');

  const ctx: RunContext = {
    repoDir: o.repoDir,
    scratchDir,
    findingsPath,
    promptPath,
    prompt,
    model: rt.harnessModel,
    args: m.args ?? {},
    env: childEnv(m, key),
    timeoutMs: m.timeout_seconds ? m.timeout_seconds * 1000 : VERIFY_TIMEOUT_MS,
    budgetUsd: null,
    maxTurns: m.max_turns ?? VERIFY_MAX_TURNS,
  };

  const result = await runHarness(getHarness(m.harness), ctx, o.signal);
  for (const d of result.diagnostics) log.debug(`verify ${c.id}: ${d}`);

  const cost = computeCost({
    pricingKey: rt.pricingKey,
    usage: result.usage,
    reportedCostUsd: result.reportedCostUsd,
    pricing: o.pricing,
  });

  let written = '';
  try {
    written = await readFile(findingsPath, 'utf8');
  } catch {
    written = '';
  }
  const judged = readJudgement(extractJson(written)) ?? readJudgement(extractJson(result.rawText));
  if (judged) {
    return {
      verification: { refuted: judged.refuted, reason: judged.reason, byModel: rt.label, cost },
      cost,
      called: true,
    };
  }

  // The load-bearing distinction, and the subtle one. A verifier that ANSWERED but
  // answered mushily counts against the finding — ambiguity resolves to refuted, which is
  // the asymmetry we are buying. A verifier that never answered at all (missing binary,
  // timeout, dead network) is not evidence of anything, so `verification` stays null:
  // `applyPublishRules` then suppresses a solo P0/P1 as below the agreement threshold
  // rather than branding a possibly-real defect 'refuted on verification'.
  const spoke = written.trim().length > 0 || result.rawText.trim().length > 0;
  const crashed = result.diagnostics.some((d) => /failed to run|timed out/i.test(d));
  if (!spoke || crashed) {
    log.warn(`verify ${c.id}: no answer from ${rt.label}, left unverified`);
    return { verification: null, cost, called: true };
  }

  return {
    verification: {
      refuted: true,
      reason: 'verifier response could not be parsed; ambiguity defaults to refuted',
      byModel: rt.label,
      cost,
    },
    cost,
    called: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bounded concurrency
// ─────────────────────────────────────────────────────────────────────────────

/** Tiny fixed-size pool. Results keep the input order; a worker never rejects. */
async function pool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) continue;
      out[index] = await worker(item, index);
    }
  });

  await Promise.all(runners);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

function sumCosts(parts: CostBreakdown[]): CostBreakdown {
  if (parts.length === 0) return { ...ZERO_COST };
  let usd = 0;
  let known = 0;
  let longContext = false;
  for (const p of parts) {
    if (p.usd !== null) {
      usd += p.usd;
      known++;
    }
    longContext = longContext || p.longContext;
  }
  if (known === 0) return { usd: null, source: 'unknown', longContext };
  const source = parts.every((p) => p.source === 'reported') ? 'reported' : 'estimated';
  const cost: CostBreakdown = { usd, source, longContext };
  if (known < parts.length) cost.note = `${parts.length - known} verification(s) reported no usage`;
  return cost;
}

export async function verifyClusters(clusters: Cluster[], o: VerifyOptions): Promise<VerifyResult> {
  const m = o.modelRun;
  if (!m) return { clusters, cost: { ...ZERO_COST }, calls: 0 };

  const key = o.secrets[m.secret];
  if (!hasKey(key)) {
    log.info(`verify: skipped (no ${m.secret})`);
    return { clusters, cost: { ...ZERO_COST }, calls: 0 };
  }

  const selected = clusters.filter((c) =>
    needsVerification(c, o.verifySolo, o.minimumAgreement),
  );
  if (selected.length === 0) return { clusters, cost: { ...ZERO_COST }, calls: 0 };

  log.step(`Verifying ${selected.length} finding(s) adversarially`);

  const instructions = await loadAgentInstructions(
    o.repoDir,
    o.diff.baseSha,
    o.diff.files.filter((f) => !f.ignored).map((f) => f.path),
  );
  for (const problem of instructions.problems) log.debug(`verify instructions: ${problem}`);

  const attempts = await pool<Cluster, Attempt>(selected, CONCURRENCY, async (c, index) => {
    if (o.signal?.aborted) return { verification: null, cost: null, called: false };
    try {
      return await verifyOne(c, index, m, key, o, instructions.rendered);
    } catch (e) {
      // Never throw, and never let an infrastructure failure convict a finding.
      log.warn(`verify ${c.id}: ${e instanceof Error ? e.message : String(e)}`);
      return { verification: null, cost: null, called: false };
    }
  });

  // Keyed by object identity, not `id`: two clusters can hash to the same id and only one
  // of them was actually verified.
  const byCluster = new Map<Cluster, Attempt>();
  selected.forEach((c, i) => {
    const attempt = attempts[i];
    if (attempt) byCluster.set(c, attempt);
  });

  const costs: CostBreakdown[] = [];
  let calls = 0;
  for (const attempt of attempts) {
    if (!attempt?.called) continue;
    calls++;
    if (attempt.cost) costs.push(attempt.cost);
  }

  return {
    clusters: clusters.map((c) => {
      const attempt = byCluster.get(c);
      return attempt ? { ...c, verification: attempt.verification } : c;
    }),
    cost: sumCosts(costs),
    calls,
  };
}
