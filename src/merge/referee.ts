/**
 * Stage 4: the only model call in the consensus pipeline, and only for pairs Jaccard
 * could not decide. Calls are made per *block*, not per pair — a typical PR produces
 * zero to two of them.
 *
 * Every failure path returns the input clusters untouched. A referee that times out,
 * babbles, or has no key must never cost us a finding.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  AttributedFinding,
  Cluster,
  CostBreakdown,
  ModelConfig,
  PricingTable,
  RunContext,
} from '../types.js';
import { renderTemplate, resolveModelRuntime } from '../config.js';
import { computeCost } from '../cost/compute.js';
import { getHarness } from '../harness/registry.js';
import { runHarness } from '../harness/runner.js';
import { log } from '../util/log.js';
import type { AmbiguousPair } from './cluster.js';
import { buildCluster } from './cluster.js';

export interface RefereeOptions {
  modelRun: ModelConfig | null;
  pricing: PricingTable;
  secrets: Record<string, string | undefined>;
  repoDir: string;
  scratchRoot: string;
  promptTemplate: string;
  enabled: boolean;
}

export interface RefereeResult {
  clusters: Cluster[];
  cost: CostBreakdown;
  calls: number;
}

const ZERO_COST: CostBreakdown = { usd: 0, source: 'estimated', longContext: false };

/** Mirrors the default `consensus.line_window`; ambiguous pairs came out of such a block. */
const BLOCK_WINDOW = 8;

/** A referee prompt is ~1k tokens. Anything past this is a pathological block. */
const MAX_CANDIDATES_PER_BLOCK = 8;
const REFEREE_TIMEOUT_MS = 120_000;
// No step cap by default; the short referee wall-clock timeout is the safety boundary.
const REFEREE_MAX_TURNS = 0;

/** Ambient variables a CLI needs to start; deliberately excludes `NODE_OPTIONS`. */
const ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM'];

// ─────────────────────────────────────────────────────────────────────────────
// Identity + grouping
// ─────────────────────────────────────────────────────────────────────────────

/** `sourceId` is assigned before clustering and survives every canonical rewrite. */
function keyOf(f: AttributedFinding): string {
  return f.sourceId;
}

/** String-keyed union-find, used both to group pairs into blocks and to apply merges. */
class Groups {
  private readonly parent = new Map<string, string>();

  find(k: string): string {
    let node = k;
    for (;;) {
      const parent = this.parent.get(node);
      if (parent === undefined || parent === node) return node;
      const grand = this.parent.get(parent) ?? parent;
      this.parent.set(node, grand);
      node = grand;
    }
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

interface Block {
  path: string;
  findings: AttributedFinding[];
}

/**
 * One call per block, not per pair. Pairs sharing a finding are obviously the same
 * block; pairs that merely sit within `BLOCK_WINDOW` lines of each other on the same
 * file are folded in too, which is the same rule Stage 2 used to build the block.
 */
function blocksOf(pairs: AmbiguousPair[]): Block[] {
  const groups = new Groups();
  const findings = new Map<string, AttributedFinding>();

  for (const p of pairs) {
    const ka = keyOf(p.a);
    const kb = keyOf(p.b);
    findings.set(ka, p.a);
    findings.set(kb, p.b);
    groups.union(ka, kb);
  }

  const byPath = new Map<string, AttributedFinding[]>();
  for (const f of findings.values()) {
    const bucket = byPath.get(f.path);
    if (bucket) bucket.push(f);
    else byPath.set(f.path, [f]);
  }
  for (const list of byPath.values()) {
    list.sort((a, b) => a.anchoredLine - b.anchoredLine);
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      if (prev && cur && cur.anchoredLine - prev.anchoredLine <= BLOCK_WINDOW) {
        groups.union(keyOf(prev), keyOf(cur));
      }
    }
  }

  const blocks = new Map<string, Block>();
  for (const path of [...byPath.keys()].sort()) {
    for (const f of byPath.get(path) ?? []) {
      const root = groups.find(keyOf(f));
      const block = blocks.get(root);
      if (block) block.findings.push(f);
      else blocks.set(root, { path, findings: [f] });
    }
  }
  return [...blocks.values()].filter((b) => b.findings.length > 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tolerant JSON
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Local and intentionally small: the referee's answer is not a `ModelReport`, so
 * `report.ts` cannot parse it, but it needs the same leniency about fences and prose.
 */
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

export interface RefereeMerge {
  ids: string[];
  canonical: { title?: string; body?: string } | null;
}

export interface RefereeVerdict {
  merges: RefereeMerge[];
  distinct: string[];
}

/**
 * Parse a complete partition of the candidate ids. A partial answer is rejected rather
 * than interpreted: leaving the input clusters untouched may show a duplicate, whereas
 * guessing from an incomplete merge can hide a real bug.
 */
export function readRefereeVerdict(
  raw: unknown,
  expectedIds: readonly string[],
): RefereeVerdict | null {
  if (!isRecord(raw)) return null;

  const allowed = new Set(expectedIds);
  const seen = new Set<string>();
  const merges: RefereeMerge[] = [];
  const rawMerges = raw['merges'];
  const rawDistinct = raw['distinct'];
  if (!Array.isArray(rawMerges) || !Array.isArray(rawDistinct)) return null;

  for (const group of rawMerges) {
    if (!isRecord(group) || !Array.isArray(group['ids'])) return null;
    const ids = group['ids'].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    if (ids.length < 2 || ids.length !== group['ids'].length) return null;
    if (
      group['same_trigger'] !== true ||
      group['same_mechanism'] !== true ||
      group['same_consequence'] !== true ||
      group['same_fix'] !== true
    ) {
      return null;
    }

    let canonical: { title?: string; body?: string } | null = null;
    const rawCanonical = group['canonical'];
    if (rawCanonical !== undefined && rawCanonical !== null) {
      if (!isRecord(rawCanonical)) return null;
      const title = typeof rawCanonical['title'] === 'string' ? rawCanonical['title'] : undefined;
      const body = typeof rawCanonical['body'] === 'string' ? rawCanonical['body'] : undefined;
      if (title !== undefined || body !== undefined) canonical = { title, body };
    }

    for (const id of ids) {
      if (!allowed.has(id) || seen.has(id)) return null;
      seen.add(id);
    }
    merges.push({ ids, canonical });
  }

  const distinct: string[] = [];
  for (const value of rawDistinct) {
    if (typeof value !== 'string' || !value || !allowed.has(value) || seen.has(value)) return null;
    seen.add(value);
    distinct.push(value);
  }

  if (seen.size !== allowed.size) return null;
  return { merges, distinct };
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
  // Exactly one provider key, same rule as fan-out.
  env[m.secret] = secret;
  return env;
}

const OUTPUT_CONTRACT = `## Output

Write STRICT JSON to {{FINDINGS_PATH}} and nothing else:

{
  "merges": [{
    "ids": ["f1", "f2"],
    "same_trigger": true,
    "same_mechanism": true,
    "same_consequence": true,
    "same_fix": true,
    "canonical": { "title": "noun phrase", "body": "1-3 sentences" }
  }],
  "distinct": ["f3"]
}

Every candidate id must occur exactly once, either in one merge or in "distinct".
Only merge when all four same_* fields are true. Never invent an id.`;

function buildPrompt(template: string, block: Block, ids: Map<string, string>, vars: Record<string, string>): string {
  const payload = block.findings.map((f) => ({
    id: ids.get(keyOf(f)) ?? '?',
    path: f.path,
    line: f.anchoredLine,
    severity: f.severity,
    title: f.title,
    body: f.body,
    claim: f.claim ?? null,
  }));

  const findingsJson = JSON.stringify(payload, null, 2);
  const rendered = renderTemplate(template, { ...vars, FINDINGS: findingsJson });

  // A template that never mentions the candidates cannot referee anything, so append
  // them plus the contract rather than making a call that is guaranteed to be useless.
  if (/\{\{FINDINGS\}\}/.test(template)) return rendered;
  return `${rendered.trim()}\n\n## Candidate findings\n\n${findingsJson}\n\n${renderTemplate(OUTPUT_CONTRACT, vars)}\n`;
}

async function refereeBlock(
  block: Block,
  index: number,
  m: ModelConfig,
  key: string,
  o: RefereeOptions,
): Promise<{
  verdict: RefereeVerdict | null;
  ids: Map<string, string>;
  cost: CostBreakdown;
}> {
  const findings = block.findings.slice(0, MAX_CANDIDATES_PER_BLOCK);
  const ids = new Map<string, string>();
  findings.forEach((f, i) => ids.set(keyOf(f), `f${i + 1}`));

  const rt = resolveModelRuntime(m);
  const scratchDir = join(o.scratchRoot, 'referee', String(index));
  await mkdir(scratchDir, { recursive: true });

  const promptPath = join(scratchDir, 'prompt.md');
  const findingsPath = join(scratchDir, 'referee.json');
  const prompt = buildPrompt(o.promptTemplate, { path: block.path, findings }, ids, {
    SCRATCH: scratchDir,
    FINDINGS_PATH: findingsPath,
    REPO_DIR: o.repoDir,
    PATH: block.path,
  });
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
    env: childEnv(m, key),
    providerKey: key,
    timeoutMs: m.timeout_seconds ? m.timeout_seconds * 1000 : REFEREE_TIMEOUT_MS,
    budgetUsd: null,
    maxTurns: m.max_turns ?? REFEREE_MAX_TURNS,
  };

  const result = await runHarness(getHarness(m.harness), ctx);
  for (const d of result.diagnostics) log.debug(`referee: ${d}`);

  // The file is the contract; stdout is the fallback for a model that answered inline.
  let written = '';
  try {
    written = await readFile(findingsPath, 'utf8');
  } catch {
    written = '';
  }
  const expectedIds = [...ids.values()];
  const verdict =
    readRefereeVerdict(extractJson(written), expectedIds) ??
    readRefereeVerdict(extractJson(result.rawText), expectedIds);
  return {
    verdict,
    ids,
    cost: computeCost({
      pricingKey: rt.pricingKey,
      usage: result.usage,
      reportedCostUsd: result.reportedCostUsd,
      pricing: o.pricing,
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Applying the verdict
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
  const partial = known < parts.length || parts.some((p) => p.partial === true);
  const source = parts.every((p) => p.source === 'reported') ? 'reported' : 'estimated';
  const cost: CostBreakdown = { usd, source, longContext, ...(partial ? { partial: true } : {}) };
  if (known < parts.length) cost.note = `${parts.length - known} referee call(s) reported no usage`;
  return cost;
}

/** Rebuild the cluster list, unioning any clusters the referee said were the same defect. */
export function applyMerges(
  clusters: Cluster[],
  merged: { verdict: RefereeVerdict; ids: Map<string, string> }[],
): Cluster[] {
  // finding key → index of the cluster that currently owns it.
  const owner = new Map<string, number>();
  clusters.forEach((c, i) => {
    for (const member of c.members) owner.set(keyOf(member), i);
  });

  const groups = new Groups();
  const canonical = new Map<number, { title?: string; body?: string }>();
  let touched = false;

  for (const { verdict, ids } of merged) {
    const byId = new Map<string, number>();
    for (const [key, id] of ids) {
      const index = owner.get(key);
      if (index !== undefined) byId.set(id, index);
    }

    for (const merge of verdict.merges) {
      const indices = merge.ids
        .map((id) => byId.get(id))
        .filter((i): i is number => i !== undefined);
      const first = indices[0];
      if (first === undefined) continue;
      for (const other of indices.slice(1)) {
        if (groups.find(String(first)) !== groups.find(String(other))) touched = true;
        groups.union(String(first), String(other));
      }
      if (merge.canonical) canonical.set(first, merge.canonical);
    }
  }

  if (!touched) return clusters;

  const buckets = new Map<string, number[]>();
  clusters.forEach((_, i) => {
    const root = groups.find(String(i));
    const bucket = buckets.get(root);
    if (bucket) bucket.push(i);
    else buckets.set(root, [i]);
  });

  const out: Cluster[] = [];
  for (const indices of buckets.values()) {
    const first = indices[0];
    if (first === undefined) continue;
    const head = clusters[first];
    if (!head) continue;
    if (indices.length === 1) {
      out.push(head);
      continue;
    }

    const members: AttributedFinding[] = [];
    const tags = new Set<Cluster['mergedBy'][number]>(['referee']);
    let override: { title?: string; body?: string } | null = null;
    for (const i of indices) {
      const c = clusters[i];
      if (!c) continue;
      members.push(...c.members);
      for (const t of c.mergedBy) if (t !== 'singleton') tags.add(t);
      override = override ?? canonical.get(i) ?? null;
    }
    out.push(buildCluster(members, [...tags], override));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function refereeClusters(
  pairs: AmbiguousPair[],
  clusters: Cluster[],
  o: RefereeOptions,
): Promise<RefereeResult> {
  const m = o.modelRun;
  if (!o.enabled || !m || pairs.length === 0) {
    return { clusters, cost: { ...ZERO_COST }, calls: 0 };
  }

  const key = o.secrets[m.secret];
  if (!hasKey(key)) {
    log.info(`referee: skipped (no ${m.secret})`);
    return { clusters, cost: { ...ZERO_COST }, calls: 0 };
  }

  const blocks = blocksOf(pairs);
  if (blocks.length === 0) return { clusters, cost: { ...ZERO_COST }, calls: 0 };

  log.step(`Refereeing ${pairs.length} ambiguous pair(s) in ${blocks.length} block(s)`);

  const verdicts: { verdict: RefereeVerdict; ids: Map<string, string> }[] = [];
  const costs: CostBreakdown[] = [];
  let calls = 0;

  for (const [index, block] of blocks.entries()) {
    try {
      const answer = await refereeBlock(block, index, m, key, o);
      calls++;
      costs.push(answer.cost);
      if (!answer.verdict) {
        log.warn(`referee: unparseable answer for ${block.path}, leaving pairs unmerged`);
        continue;
      }
      verdicts.push({ verdict: answer.verdict, ids: answer.ids });
    } catch (e) {
      // Degrade, never fail: an unmerged pair is two findings, not zero.
      log.warn(`referee: ${block.path} failed (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  if (verdicts.length === 0) return { clusters, cost: sumCosts(costs), calls };

  return {
    clusters: applyMerges(clusters, verdicts),
    cost: sumCosts(costs),
    calls,
  };
}
