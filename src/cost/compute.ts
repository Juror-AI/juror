/**
 * Tokens → dollars, or an honest "unknown".
 *
 * The receipt is the product's differentiator, so every path in here either produces a
 * figure we can show our work for or refuses to answer. Nothing guesses: an unpriced
 * model, an absent token count and a malformed pricing entry all resolve to
 * `{ usd: null, source: 'unknown' }` rather than to a plausible-looking zero.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  CanonicalUsage,
  CostBreakdown,
  CostRow,
  CostTotals,
  ModelRun,
  PricingEntry,
  PricingTable,
  PricingTier,
} from '../types.js';
import { log } from '../util/log.js';

// ─────────────────────────────────────────────────────────────────────────────
// Loading pricing.json
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolved against this module rather than the cwd, so the table is found when Juror
 * runs from `dist/`, from a global npm install, or from a checkout. The second
 * candidate covers a `dist/` build whose asset-copy step did not run.
 */
const PRICING_CANDIDATES = ['./pricing.json', '../../src/cost/pricing.json'] as const;

let cached: PricingTable | null = null;

export function loadPricing(): PricingTable {
  if (cached) return cached;

  for (const rel of PRICING_CANDIDATES) {
    let text: string;
    try {
      text = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    } catch {
      continue; // Not there — try the next location before giving up.
    }
    try {
      cached = parsePricing(text);
      return cached;
    } catch (e) {
      // The file exists but is unusable; the fallback path is the same file's twin, so
      // stop here and be loud rather than quietly pricing from a stale copy.
      log.warn(`pricing.json is unreadable (${errText(e)}); every cost will read "unknown"`);
      cached = {};
      return cached;
    }
  }

  // Degrade, never fail: an empty table means unknown costs, not a crashed review.
  log.warn('no pricing.json found; every estimated cost will read "unknown"');
  cached = {};
  return cached;
}

/**
 * The shipped file is `{ "$meta": {...}, "models": {...} }`. A flat table is accepted
 * too, with `$`-prefixed keys dropped, so an override file can skip the wrapper.
 * Entries are not validated here — `computeCost()` checks the rates it actually uses
 * and explains itself in the note, which beats silently dropping a model.
 */
function parsePricing(text: string): PricingTable {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error('top level is not a JSON object');

  const models = isRecord(parsed['models']) ? parsed['models'] : parsed;
  const table: PricingTable = {};
  for (const [key, value] of Object.entries(models)) {
    if (key.startsWith('$')) continue;
    if (!isRecord(value)) continue;
    table[key] = value as unknown as PricingEntry;
  }
  return table;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-run cost
// ─────────────────────────────────────────────────────────────────────────────

export function computeCost(o: {
  pricingKey: string;
  usage: CanonicalUsage | null;
  reportedCostUsd: number | null;
  pricing: PricingTable;
  /**
   * Model round-trips the usage is summed over. Load-bearing for the long-context tier —
   * see `crossesLongContext()`. Omit only when the usage really is a single request.
   */
  turns?: number;
}): CostBreakdown {
  const notes: string[] = [];

  // Rule 1 — a provider-computed figure always wins and we do no arithmetic on top of
  // it. A non-finite or negative "cost" is a broken adapter, not a price; fall through
  // to estimation and say so rather than publishing nonsense.
  if (o.reportedCostUsd != null) {
    if (Number.isFinite(o.reportedCostUsd) && o.reportedCostUsd >= 0) {
      return { usd: o.reportedCostUsd, source: 'reported', longContext: false };
    }
    notes.push(`ignored an unusable reported cost (${String(o.reportedCostUsd)})`);
  }

  // Rule 2 — nothing to work from. Never guess.
  if (!o.usage) return unknownCost('the harness reported neither a cost nor token counts', notes);

  const { uncachedIn, cacheRead, cacheWrite, out } = o.usage;
  if (![uncachedIn, cacheRead, cacheWrite, out].every((n) => Number.isFinite(n))) {
    return unknownCost('token counts were not finite numbers', notes);
  }
  // A harness that subtracts cached from total input can go negative on inconsistent
  // payloads (see §5.2). Clamp so a bad subtraction can never produce a credit.
  if (uncachedIn < 0 || cacheRead < 0 || cacheWrite < 0 || out < 0) {
    notes.push('negative token counts clamped to zero');
  }
  const inTok = Math.max(0, uncachedIn);
  const readTok = Math.max(0, cacheRead);
  const writeTok = Math.max(0, cacheWrite);
  const outTok = Math.max(0, out);

  // Rule 5 — a model we have no list price for is unknown, not free.
  const entry = o.pricing[o.pricingKey];
  if (!entry) return unknownCost(`no pricing entry for "${o.pricingKey}"`, notes);
  if (!Number.isFinite(entry.input_per_mtok) || !Number.isFinite(entry.output_per_mtok)) {
    return unknownCost(`pricing entry for "${o.pricingKey}" is missing input/output rates`, notes);
  }

  // Rule 3 — the long-context tier is a cliff, not a slope: once a request's input crosses
  // the threshold, that ENTIRE request reprices, every component included.
  const totalInput = inTok + readTok + writeTok;
  const lc = entry.long_context;
  const verdict = crossesLongContext(totalInput, o.turns, entry);
  const tier: PricingTier = lc && verdict.crosses ? lc : entry;
  const longContext = tier !== entry;
  if (verdict.note) notes.push(verdict.note);

  // Rule 4 — cache writes bill; they are not a discount. Where a provider publishes no
  // separate rate the input rate is the documented fallback, and the receipt says so.
  const readRate = tier.cache_read_per_mtok ?? tier.input_per_mtok;
  if (tier.cache_read_per_mtok == null && readTok > 0) {
    notes.push(`no cache-read rate for "${o.pricingKey}"; billed cache reads at the input rate`);
  }
  const writeRate = tier.cache_write_per_mtok ?? tier.input_per_mtok;
  if (tier.cache_write_per_mtok == null && writeTok > 0) {
    notes.push(`no cache-write rate for "${o.pricingKey}"; billed cache writes at the input rate`);
  }

  const usd = roundUsd(
    (inTok * tier.input_per_mtok +
      readTok * readRate +
      writeTok * writeRate +
      outTok * tier.output_per_mtok) /
      1_000_000,
  );

  const cost: CostBreakdown = { usd, source: 'estimated', longContext };
  if (notes.length) cost.note = notes.join('; ');
  return cost;
}

/**
 * Decide whether the long-context tier applies — the single easiest way to overbill by 2x.
 *
 * The threshold is per *request*: one prompt larger than 272k tokens reprices that prompt.
 * What a harness hands back, though, is the sum over an entire agent session, and an agent
 * resends its whole conversation on every turn. Testing the sum against a per-request
 * threshold is a category error, and not a small one: a real Codex review of a 239-line
 * diff reported 3.28M input tokens across ~40 turns — about 80k per request, nowhere near
 * the cliff — yet the naive comparison priced all 3.28M at the long-context rate and turned
 * $2.76 into $5.32.
 *
 * So divide by the turn count and test the average request. Two extra guards:
 * a total that exceeds the model's context window is *definitionally* cumulative no matter
 * what the turn count claims, and when the aggregate crosses but the average does not, the
 * note says so — a surprising line in the receipt should always be explainable.
 */
function crossesLongContext(
  totalInput: number,
  turns: number | undefined,
  entry: PricingEntry,
): { crosses: boolean; note: string | null } {
  const lc = entry.long_context;
  if (!lc) return { crosses: false, note: null };

  const rounds = turns && Number.isFinite(turns) && turns > 0 ? Math.floor(turns) : 1;
  const perRequest = totalInput / rounds;
  const window = entry.context_window;
  const impossible = typeof window === 'number' && window > 0 && perRequest > window;

  if (perRequest >= lc.threshold_input_tokens && !impossible) {
    return {
      crosses: true,
      note:
        `long-context tier: ~${Math.round(perRequest)} input tokens per request crossed ` +
        `${lc.threshold_input_tokens}, repricing the entire request`,
    };
  }

  if (totalInput >= lc.threshold_input_tokens) {
    // The aggregate crossed and the per-request estimate did not. Priced at the standard
    // tier, because nothing observed says any single request was over the line.
    return {
      crosses: false,
      note:
        `${totalInput} input tokens across ${rounds} turn${rounds === 1 ? '' : 's'} ` +
        `(~${Math.round(perRequest)} per request) stayed under the ${lc.threshold_input_tokens} ` +
        'long-context threshold; priced at the standard tier' +
        (impossible ? ', and the total exceeds this model’s context window' : ''),
    };
  }

  return { crosses: false, note: null };
}

function unknownCost(reason: string, notes: string[]): CostBreakdown {
  return { usd: null, source: 'unknown', longContext: false, note: [...notes, reason].join('; ') };
}

/**
 * Six decimals kills float noise (`0.30000000000000004`) without hiding a real charge:
 * anything too small to survive the rounding is returned exactly, because a cost that
 * displays as `$0.00` when money actually moved is the one lie this file cannot tell.
 */
export function roundUsd(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const r = Math.round(n * 1e6) / 1e6;
  return r === 0 && n !== 0 ? n : r;
}

// ─────────────────────────────────────────────────────────────────────────────
// Review-wide rollup
// ─────────────────────────────────────────────────────────────────────────────

export function totalCost(
  runs: ModelRun[],
  extra: {
    label: string;
    harnessLabel: string;
    usage: CanonicalUsage | null;
    cost: CostBreakdown;
  }[],
): CostTotals {
  const rows: CostRow[] = runs.map((run) => ({
    label: run.modelLabel,
    harnessLabel: run.harnessLabel,
    usage: run.result?.usage ?? null,
    cost: rowCost(run),
  }));
  for (const e of extra) {
    rows.push({ label: e.label, harnessLabel: e.harnessLabel, usage: e.usage, cost: e.cost });
  }

  const usage: CanonicalUsage = { uncachedIn: 0, cacheRead: 0, cacheWrite: 0, out: 0 };
  let known = 0;
  let knownRows = 0;
  let partial = false;
  for (const row of rows) {
    if (row.usage) {
      usage.uncachedIn += tokens(row.usage.uncachedIn);
      usage.cacheRead += tokens(row.usage.cacheRead);
      usage.cacheWrite += tokens(row.usage.cacheWrite);
      usage.out += tokens(row.usage.out);
    }
    if (row.cost.usd != null && Number.isFinite(row.cost.usd)) {
      known += row.cost.usd;
      knownRows++;
    }
    // One unknown row turns the total into a documented lower bound rather than a lie.
    if (row.cost.source === 'unknown') partial = true;
  }

  // With nothing priced at all there is no lower bound worth printing — say unknown.
  const usd = knownRows === 0 && rows.length > 0 ? null : roundUsd(known);

  return {
    rows,
    usage,
    usd,
    partial,
    // The denominator for majority agreement: models that actually produced a report.
    modelsRun: runs.filter((r) => !r.skipped && r.ok).length,
  };
}

/**
 * A skipped model provably spent nothing — no key, no process, no tokens — so it must
 * not drag the whole total into "partial". Its reason rides along on the row so the
 * receipt can still explain the blank line.
 */
function rowCost(run: ModelRun): CostBreakdown {
  if (!run.skipped || run.cost.usd != null) return run.cost;
  return {
    usd: 0,
    source: 'estimated',
    longContext: false,
    note: run.skipReason ?? 'skipped',
  };
}

function tokens(n: number): number {
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}
