/**
 * Stages 2 and 3 of consensus: block findings by file and line window, then merge within
 * a block by weighted lexical and identifier similarity. Both stages are free — no model call happens
 * here, which is the whole point: the agreement signal was already paid for during
 * fan-out and every other tool on the market throws it away.
 *
 * Anything the arithmetic cannot decide becomes an `AmbiguousPair` for `referee.ts`;
 * nothing is dropped.
 */

import { createHash } from 'node:crypto';

import type { AnchorStatus, AttributedFinding, Cluster, Severity } from '../types.js';

export interface AmbiguousPair {
  a: AttributedFinding;
  b: AttributedFinding;
  jaccard: number;
}

export interface ClusterOptions {
  lineWindow: number;
  mergeThreshold: number;
  distinctThreshold: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tokenization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deliberately short. Negations (`not`, `no`, `never`) are NOT stopwords: "the guard is
 * checked" and "the guard is not checked" are opposite claims about the same line, and
 * dropping the negation would merge them into one bogus cluster.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'this', 'that', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'to', 'of', 'in', 'on', 'at', 'for',
  'with', 'from', 'by', 'as', 'it', 'its', 'so', 'than', 'when', 'which', 'will', 'would',
  'can', 'could', 'should', 'may', 'might', 'do', 'does', 'did', 'has', 'have', 'had',
  'we', 'you', 'they', 'there', 'here', 'into', 'out', 'up', 'down', 'also', 'very',
  'such', 'any', 'all', 'each', 'other', 'both', 'because', 'while', 'about', 'over',
]);

/**
 * Keeps `snake_case`, `camelCase`, `a.b.c` and `call()` intact as single tokens — those
 * are the highest-signal words in a finding and splitting them on punctuation destroys
 * exactly the evidence we are trying to weigh.
 */
const TOKEN_RE = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?|\d+(?:\.\d+)?/g;

function isIdentifier(token: string): boolean {
  if (!/[A-Za-z]/.test(token)) return false; // `1.5` is a number, not a symbol
  return (
    token.includes('_') ||
    token.includes('.') ||
    token.endsWith('()') ||
    /[a-z0-9][A-Z]/.test(token)
  );
}

/** Token → weight. Identifiers count twice; that is the "identifiers 2x" rule. */
function weigh(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of text.match(TOKEN_RE) ?? []) {
    const key = raw.toLowerCase();
    if (STOPWORDS.has(key)) continue;
    counts.set(key, (counts.get(key) ?? 0) + (isIdentifier(raw) ? 2 : 1));
  }
  return counts;
}

/** Weighted-multiset Jaccard: `Σ min(a,b) / Σ max(a,b)`. */
export function jaccard(a: string, b: string): number {
  const left = weigh(a);
  const right = weigh(b);
  if (left.size === 0 || right.size === 0) return 0;

  let intersection = 0;
  let union = 0;
  for (const [token, weight] of left) {
    const other = right.get(token) ?? 0;
    intersection += Math.min(weight, other);
    union += Math.max(weight, other);
  }
  for (const [token, weight] of right) {
    if (!left.has(token)) union += weight;
  }
  return union === 0 ? 0 : intersection / union;
}

/**
 * The code symbols a finding names, which is the closest thing it has to a fingerprint.
 *
 * Dotted paths are indexed both whole and by their last segment, because models are
 * inconsistent about the receiver: one writes `ctx.lost_task_ownership` where another
 * writes plain `lost_task_ownership` for the same field. Treating those as unrelated
 * symbols is how two models agreeing word-for-word about a field end up looking like
 * strangers. Keeping the full path too means `a.close` and `b.close` still differ.
 */
function identifiers(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.match(TOKEN_RE) ?? []) {
    if (!isIdentifier(raw)) continue;
    const token = raw.toLowerCase().replace(/\(\)$/, '');
    out.add(token);
    const dot = token.lastIndexOf('.');
    if (dot > 0 && dot < token.length - 1) out.add(token.slice(dot + 1));
  }
  return out;
}

function setJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Minimum symbols before containment is distinctive rather than coincidental.
 *
 * One shared symbol is worthless — containment is trivially 1.0 and half the findings in a
 * file mention `ctx`. Two exact matches is a different story when they are names like
 * `lost_task_ownership` and `_finalize_stream_result`, and findings only ever get compared
 * once they are already in the same file and line window. Measured on two real PRs, moving
 * this from 3 to 2 merged a genuinely unanimous finding that had been split in two, and
 * moved no unrelated pair above the merge threshold.
 */
const MIN_IDENTIFIERS_FOR_CONTAINMENT = 2;

/**
 * How much of the smaller finding's symbol set the larger one covers.
 *
 * Jaccard is the wrong shape here because the two sides are not the same size. Models
 * write to wildly different lengths: on a real PR, one juror described a defect in 90
 * words citing five symbols and another spent 240 words citing fifteen. They agreed
 * completely — every symbol the short one named appeared in the long one — yet Jaccard
 * scored 0.33, because the long finding's extra vocabulary inflates the union it divides by.
 * Containment asks the question we actually care about: does everything one juror pointed
 * at appear in what the other pointed at?
 *
 * Guarded, because containment is trivially 1.0 when the smaller set has one element.
 * Below a few symbols there is not enough evidence for it to mean anything, so fall back
 * to Jaccard and let the referee decide.
 */
function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const smaller = Math.min(a.size, b.size);
  if (smaller < MIN_IDENTIFIERS_FOR_CONTAINMENT) return setJaccard(a, b);
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / smaller;
}

/**
 * How likely two findings are the same defect.
 *
 * Prose Jaccard alone does not work, and the failure is not subtle. Measured on three
 * models that independently found one clipboard bug, pairwise prose similarity came out
 * at 0.23–0.33 — below the "distinct" threshold — because independent writers share only
 * a quarter of their vocabulary even when they agree completely. Consensus would have
 * reported one unanimous bug as three separate single-model findings: precisely inverted.
 *
 * The identifiers each finding cites are far steadier than the sentences around them, and
 * comparing them by containment rather than by overlap survives the length asymmetry that
 * broke the prose channel. Measured across two real PRs, that blend scores every
 * same-defect pair at 0.55–0.75 and every unrelated pair at 0.04–0.39 — a gap wide enough
 * to merge the obvious cases for free and hand the rest to the referee.
 *
 * Prose still carries a third of the weight, because two findings can name the same
 * symbols for entirely different reasons and the sentences are what separate those.
 */
export function similarity(a: string, b: string): number {
  return 0.35 * jaccard(a, b) + 0.65 * containment(identifiers(a), identifiers(b));
}

// ─────────────────────────────────────────────────────────────────────────────
// Cluster assembly
// ─────────────────────────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const ANCHOR_RANK: Record<AnchorStatus, number> = {
  exact: 0,
  snapped: 1,
  'outside-diff': 2,
  'unknown-file': 3,
};

/** Severity first, then confidence; model id only to keep the order deterministic. */
function byQuality(a: AttributedFinding, b: AttributedFinding): number {
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (bySeverity !== 0) return bySeverity;
  if (b.confidence !== a.confidence) return b.confidence - a.confidence;
  return a.modelId.localeCompare(b.modelId);
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Stable across runs and across models, so an incremental re-review of the same PR
 * produces the same ids and the sticky comment diffs cleanly.
 */
function clusterId(path: string, title: string): string {
  return createHash('sha1').update(`${path}\u0000${normalizeTitle(title)}`).digest('hex').slice(0, 10);
}

/**
 * Collapse members into one cluster. Exported because `referee.ts` re-forms clusters
 * after a referee merge and must use identical canonical-field rules.
 */
export function buildCluster(
  members: AttributedFinding[],
  mergedBy: Cluster['mergedBy'],
  canonical?: { title?: string; body?: string } | null,
): Cluster {
  const ranked = [...members].sort(byQuality);
  const best = ranked[0];
  if (!best) throw new Error('buildCluster() called with no members');

  // Distinct models only. Two findings from one model are one voice, however loudly it
  // repeated itself — inflating agreement here would defeat the entire publish rule.
  const modelIds: string[] = [];
  const modelLabels: string[] = [];
  for (const m of ranked) {
    if (modelIds.includes(m.modelId)) continue;
    modelIds.push(m.modelId);
    modelLabels.push(m.modelLabel);
  }

  const anchor = ranked.reduce<AnchorStatus>(
    (acc, m) => (ANCHOR_RANK[m.anchor] < ANCHOR_RANK[acc] ? m.anchor : acc),
    best.anchor,
  );

  // Anchoring may have moved the start line; carry the range along by the same delta so a
  // multi-line finding keeps its length instead of pointing at an unrelated span.
  const drift = best.anchoredLine - best.line;
  const endLine =
    best.end_line === null ? null : Math.max(best.anchoredLine, best.end_line + drift);

  const title = canonical?.title?.trim() || best.title;
  const body = canonical?.body?.trim() || best.body;

  return {
    id: clusterId(best.path, title),
    path: best.path,
    line: best.anchoredLine,
    endLine,
    severity: best.severity,
    category: best.category,
    title,
    body,
    convention: best.convention,
    modelIds,
    modelLabels,
    agreement: modelIds.length,
    members: ranked,
    anchor,
    maxConfidence: ranked.reduce((max, m) => Math.max(max, m.confidence), 0),
    mergedBy,
    verification: null,
    published: false,
    suppressedReason: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Blocking + merge
// ─────────────────────────────────────────────────────────────────────────────

/** Index-keyed union-find; blocks are small, so the naive path-halving version is plenty. */
class UnionFind {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }

  find(i: number): number {
    let node = i;
    for (;;) {
      const parent = this.parent[node];
      if (parent === undefined || parent === node) return node;
      const grand = this.parent[parent] ?? parent;
      this.parent[node] = grand;
      node = grand;
    }
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

/** Sorted findings on one path split into runs no more than `window` lines apart. */
function blocksOf(sorted: AttributedFinding[], window: number): AttributedFinding[][] {
  const blocks: AttributedFinding[][] = [];
  let current: AttributedFinding[] = [];
  let previousLine = 0;

  for (const f of sorted) {
    if (current.length > 0 && f.anchoredLine - previousLine > window) {
      blocks.push(current);
      current = [];
    }
    current.push(f);
    previousLine = f.anchoredLine;
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

function text(f: AttributedFinding): string {
  return `${f.title} ${f.body}`;
}

/**
 * Score a pair without letting a terse title get drowned by two independently written
 * explanations.
 *
 * Models often use nearly identical titles and then justify the same defect with disjoint
 * operational details. Comparing title+body alone can push that pair just below the
 * distinct threshold, which means the referee never sees it and the same bug is printed
 * twice. The title is therefore a second candidate channel. It may raise a pair into the
 * ambiguous band, but is capped exactly at the merge threshold: a similar title alone can
 * ask the referee, never silently merge contradictory reports.
 */
function comparisonScore(
  a: AttributedFinding,
  b: AttributedFinding,
  mergeThreshold: number,
): number {
  const wholeFinding = similarity(text(a), text(b));
  const titleOnly = similarity(a.title, b.title);
  return Math.max(wholeFinding, Math.min(titleOnly, mergeThreshold));
}

export function clusterFindings(
  findings: AttributedFinding[],
  o: ClusterOptions,
): { clusters: Cluster[]; ambiguousPairs: AmbiguousPair[] } {
  const byPath = new Map<string, AttributedFinding[]>();
  for (const f of findings) {
    const bucket = byPath.get(f.path);
    if (bucket) bucket.push(f);
    else byPath.set(f.path, [f]);
  }

  const clusters: Cluster[] = [];
  const ambiguousPairs: AmbiguousPair[] = [];

  for (const path of [...byPath.keys()].sort()) {
    const sorted = [...(byPath.get(path) ?? [])].sort(
      (a, b) => a.anchoredLine - b.anchoredLine || byQuality(a, b),
    );

    for (const block of blocksOf(sorted, o.lineWindow)) {
      const uf = new UnionFind(block.length);

      for (let i = 0; i < block.length; i++) {
        const a = block[i];
        if (!a) continue;
        for (let j = i + 1; j < block.length; j++) {
          const b = block[j];
          if (!b) continue;
          const score = comparisonScore(a, b, o.mergeThreshold);
          if (score > o.mergeThreshold) uf.union(i, j);
          else if (score >= o.distinctThreshold) ambiguousPairs.push({ a, b, jaccard: score });
        }
      }

      // Merging is transitive: A~B and B~C put all three in one cluster even if A and C
      // scored below the threshold against each other.
      const groups = new Map<number, AttributedFinding[]>();
      for (let i = 0; i < block.length; i++) {
        const f = block[i];
        if (!f) continue;
        const root = uf.find(i);
        const group = groups.get(root);
        if (group) group.push(f);
        else groups.set(root, [f]);
      }

      for (const group of groups.values()) {
        clusters.push(buildCluster(group, group.length > 1 ? ['jaccard'] : ['singleton']));
      }
    }
  }

  return { clusters, ambiguousPairs };
}
