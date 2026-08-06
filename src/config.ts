/**
 * `.juror.yml` loading, validation, and the shipped defaults.
 *
 * A bad config must never stop a review: every validator falls back to the default for
 * that key and appends a human-readable line to `problems`, which the CLI prints and the
 * receipt can surface. Nothing in this file throws except `loadPromptTemplate`, where a
 * missing template means the install itself is broken.
 */

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { HarnessId, JurorConfig, ModelConfig, ReviewPreset } from './types.js';
import { SEVERITIES } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG_FILENAMES = ['.juror.yml', '.juror.yaml', '.github/juror.yml', '.github/juror.yaml'];

const HARNESS_IDS: readonly HarnessId[] = [
  'claude-code',
  'codex',
  'grok-build',
  'kimi-code',
  'opencode',
  'generic-openai',
];

/**
 * The env var each harness reads by default. Having this table is what lets a user add a
 * model with two lines (`id` + `harness`) instead of remembering which provider key the
 * CLI underneath happens to want.
 */
const DEFAULT_SECRET: Record<HarnessId, string> = {
  'claude-code': 'ANTHROPIC_API_KEY',
  codex: 'OPENAI_API_KEY',
  'grok-build': 'XAI_API_KEY',
  'kimi-code': 'FIREWORKS_API_KEY',
  opencode: 'FIREWORKS_API_KEY',
  'generic-openai': 'OPENAI_API_KEY',
};

const SUPPRESSED_MODES = ['collapsed', 'hidden', 'inline'] as const;
const ON_EXCEED_MODES = ['partial', 'skip'] as const;
const PUBLISH_MODES = ['all', 'consensus'] as const;

export const REVIEW_PRESETS = ['fast', 'balanced', 'high', 'ultra'] as const satisfies readonly ReviewPreset[];

const BUILTIN_MODELS: Record<string, ModelConfig> = {
  'claude-opus-5': {
    id: 'claude-opus-5',
    harness: 'claude-code',
    enabled: true,
    secret: 'ANTHROPIC_API_KEY',
    label: 'Opus 5',
  },
  'gpt-5.6-sol': {
    id: 'gpt-5.6-sol',
    harness: 'codex',
    enabled: true,
    secret: 'OPENAI_API_KEY',
    label: 'GPT-5.6 Sol',
    args: { reasoning_effort: 'high' },
  },
  'gpt-5.6-terra': {
    id: 'gpt-5.6-terra',
    harness: 'codex',
    enabled: true,
    secret: 'OPENAI_API_KEY',
    label: 'GPT-5.6 Terra',
    args: { reasoning_effort: 'max' },
  },
  'grok-4.5': {
    id: 'grok-4.5',
    harness: 'grok-build',
    enabled: true,
    secret: 'XAI_API_KEY',
    label: 'Grok 4.5',
    args: { reasoning_effort: 'high' },
  },
  'kimi-k3': {
    id: 'kimi-k3',
    harness: 'kimi-code',
    enabled: true,
    secret: 'FIREWORKS_API_KEY',
    label: 'Kimi K3',
    base_url: 'https://api.fireworks.ai/inference/v1',
    harness_model: 'accounts/fireworks/models/kimi-k3',
    pricing_key: 'accounts/fireworks/models/kimi-k3',
    args: { reasoning_effort: 'max', context_window: 1_040_000 },
  },
  'deepseek-v4-flash-0731': {
    id: 'deepseek-v4-flash-0731',
    harness: 'opencode',
    enabled: true,
    secret: 'FIREWORKS_API_KEY',
    label: 'DeepSeek V4 Flash',
    harness_model: 'fireworks-ai/accounts/fireworks/models/deepseek-v4-flash-0731',
    pricing_key: 'accounts/fireworks/models/deepseek-v4-flash-0731',
    args: { variant: 'high' },
  },
};

interface PresetDefinition {
  modelIds: readonly string[];
  consensusModel: string;
  args?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

const PRESET_DEFINITIONS: Record<ReviewPreset, PresetDefinition> = {
  fast: {
    modelIds: ['deepseek-v4-flash-0731', 'kimi-k3'],
    consensusModel: 'deepseek-v4-flash-0731',
    args: {
      'deepseek-v4-flash-0731': { variant: 'low' },
      'kimi-k3': { reasoning_effort: 'low', context_window: 1_040_000 },
    },
  },
  balanced: {
    modelIds: ['gpt-5.6-terra', 'grok-4.5', 'kimi-k3'],
    consensusModel: 'kimi-k3',
  },
  high: {
    modelIds: ['gpt-5.6-sol', 'claude-opus-5', 'grok-4.5'],
    consensusModel: 'grok-4.5',
  },
  ultra: {
    modelIds: [
      'gpt-5.6-terra',
      'gpt-5.6-sol',
      'claude-opus-5',
      'grok-4.5',
      'kimi-k3',
      'deepseek-v4-flash-0731',
    ],
    consensusModel: 'deepseek-v4-flash-0731',
  },
};

function cloneModel(model: ModelConfig, args?: Readonly<Record<string, unknown>>): ModelConfig {
  return {
    ...model,
    ...((model.args || args) ? { args: { ...model.args, ...args } } : {}),
  };
}

function modelsForPreset(preset: ReviewPreset): ModelConfig[] {
  const definition = PRESET_DEFINITIONS[preset];
  return definition.modelIds.map((id) => {
    const model = BUILTIN_MODELS[id];
    if (!model) throw new Error(`internal preset error: no built-in model named ${id}`);
    return cloneModel(model, definition.args?.[id]);
  });
}

export function parseReviewPreset(value: string): ReviewPreset | null {
  const normalized = value.trim().toLowerCase();
  return REVIEW_PRESETS.find((preset) => preset === normalized) ?? null;
}

/** Replace only the jury selection; unrelated config overrides remain intact. */
export function applyReviewPreset(config: JurorConfig, preset: ReviewPreset): JurorConfig {
  const definition = PRESET_DEFINITIONS[preset];
  const models = modelsForPreset(preset);
  const presetRef = (current: string | null): string | null =>
    current === null ? null : definition.consensusModel;

  return {
    ...config,
    preset,
    models,
    consensus: {
      ...config.consensus,
      verify_model: presetRef(config.consensus.verify_model),
      referee_model: presetRef(config.consensus.referee_model),
    },
  };
}

export function defaultConfig(): JurorConfig {
  const preset: ReviewPreset = 'balanced';
  const consensusModel = PRESET_DEFINITIONS[preset].consensusModel;
  return {
    version: 1,
    preset,
    models: modelsForPreset(preset),
    consensus: {
      min_agreement: 'all',
      verify_solo_findings: true,
      verify_model: consensusModel,
      referee_model: consensusModel,
      jaccard_merge_threshold: 0.55,
      jaccard_distinct_threshold: 0.3,
      line_window: 8,
    },
    review: {
      publish_mode: 'all',
      severity_floor: 'P3',
      max_inline_comments: 15,
      incremental: true,
      paths_ignore: [
        '**/*.lock',
        '**/package-lock.json',
        '**/uv.lock',
        'dist/**',
        'build/**',
        '**/*.generated.*',
        '**/*.min.js',
        '**/__snapshots__/**',
      ],
      anchor_tolerance: 3,
      max_diff_bytes: 400_000,
      per_model_timeout_seconds: 900,
      // Zero means unlimited. The wall-clock timeout remains the hard safety boundary;
      // positive values are still accepted for users who want an explicit agent-step cap.
      max_turns: 0,
    },
    budget: {
      // The ceiling is split evenly across the models that actually have a key, because an
      // even split is the only allocation that can honour a hard per-PR cap. That makes the
      // number less generous than it looks: at $2.00 with three models, each gets $0.67 —
      // and a single Opus 5 run over a 240-line diff in a large monorepo measured $0.69,
      // so the documented default would have killed the strongest juror mid-review.
      max_cost_usd_per_pr: 5.0,
      on_exceed: 'partial',
    },
    output: {
      sequence_diagram: true,
      cost_receipt: true,
      suppressed_findings: 'collapsed',
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading
// ─────────────────────────────────────────────────────────────────────────────

export function loadConfig(
  repoDir: string,
  overridePath?: string,
): { config: JurorConfig; problems: string[]; sourcePath: string | null } {
  const config = defaultConfig();
  const problems: string[] = [];

  const found = findConfigFile(repoDir, overridePath);
  if (!found.path) {
    if (overridePath) problems.push(`config file not found: ${overridePath} — using defaults`);
    return { config, problems, sourcePath: null };
  }

  let text: string;
  try {
    text = readFileSync(found.path, 'utf8');
  } catch (e) {
    problems.push(`could not read ${found.path}: ${errText(e)} — using defaults`);
    return { config, problems, sourcePath: null };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (e) {
    problems.push(`${found.path} is not valid YAML: ${errText(e)} — using defaults`);
    return { config, problems, sourcePath: found.path };
  }

  if (parsed === null || parsed === undefined) return { config, problems, sourcePath: found.path };
  if (!isRecord(parsed)) {
    problems.push(`${found.path} must be a YAML mapping at the top level — using defaults`);
    return { config, problems, sourcePath: found.path };
  }

  applyConfig(config, parsed, problems);
  return { config, problems, sourcePath: found.path };
}

function findConfigFile(repoDir: string, overridePath?: string): { path: string | null } {
  const candidates = overridePath
    ? // A user-typed `--config` is relative to where they typed it; fall back to the repo
      // so `--config .juror.ci.yml` also works when the CLI runs from elsewhere.
      [isAbsolute(overridePath) ? overridePath : resolve(overridePath), resolve(repoDir, overridePath)]
    : CONFIG_FILENAMES.map((f) => resolve(repoDir, f));

  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return { path: candidate };
    } catch {
      // Not there — try the next location.
    }
  }
  return { path: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation — every branch keeps the default and explains itself
// ─────────────────────────────────────────────────────────────────────────────

const TOP_KEYS = ['version', 'preset', 'models', 'consensus', 'review', 'budget', 'output'];

function applyConfig(config: JurorConfig, raw: Record<string, unknown>, problems: string[]): void {
  reportUnknown(raw, TOP_KEYS, '', problems);

  if ('version' in raw && raw['version'] !== 1) {
    problems.push(`version: expected 1, got ${fmt(raw['version'])} — treating this file as version 1`);
  }

  if ('preset' in raw) {
    const value = asString(raw['preset']);
    const preset = value ? parseReviewPreset(value) : null;
    if (preset) Object.assign(config, applyReviewPreset(config, preset));
    else {
      problems.push(
        `preset: expected one of ${REVIEW_PRESETS.join(', ')}, got ${fmt(raw['preset'])} — using ${config.preset}`,
      );
    }
  }

  if ('models' in raw) applyModels(config, raw['models'], problems);
  applyConsensus(config, raw['consensus'], problems);
  applyReview(config, raw['review'], problems);
  applyBudget(config, raw['budget'], problems);
  applyOutput(config, raw['output'], problems);
}

/**
 * A user-supplied `models:` list REPLACES the defaults rather than merging into them.
 * Partial-merging a list keyed by `id` surprises people — "I listed one model, why did it
 * run four?" — so the only thing we merge is the per-harness defaults for each entry.
 */
function applyModels(config: JurorConfig, raw: unknown, problems: string[]): void {
  if (!Array.isArray(raw)) {
    problems.push(`models: expected a list, got ${fmt(raw)} — keeping the current models`);
    return;
  }

  const models: ModelConfig[] = [];
  raw.forEach((entry, i) => {
    const model = coerceModel(entry, i, problems);
    if (model) models.push(model);
  });

  if (models.length === 0) {
    problems.push('models: no usable entries — keeping the current models');
    return;
  }
  config.models = models;
  config.preset = null;

  // A custom jury should still have working referee defaults. Explicit consensus values
  // are parsed immediately after this and therefore remain authoritative.
  const ids = new Set(models.map((model) => model.id));
  const fallback = models.find((model) => model.enabled)?.id ?? models[0]?.id ?? null;
  if (config.consensus.verify_model !== null && !ids.has(config.consensus.verify_model)) {
    config.consensus.verify_model = fallback;
  }
  if (config.consensus.referee_model !== null && !ids.has(config.consensus.referee_model)) {
    config.consensus.referee_model = fallback;
  }
}

const MODEL_KEYS = [
  'id',
  'harness',
  'enabled',
  'secret',
  'label',
  'harness_model',
  'pricing_key',
  'base_url',
  'args',
  'timeout_seconds',
  'max_turns',
];

function coerceModel(raw: unknown, index: number, problems: string[]): ModelConfig | null {
  const at = `models[${index}]`;
  if (!isRecord(raw)) {
    problems.push(`${at}: expected a mapping, got ${fmt(raw)} — dropped`);
    return null;
  }
  reportUnknown(raw, MODEL_KEYS, at, problems);

  const id = asString(raw['id']);
  if (!id) {
    problems.push(`${at}: missing a non-empty \`id\` — dropped`);
    return null;
  }

  const harnessRaw = asString(raw['harness']);
  const harness = HARNESS_IDS.find((h) => h === harnessRaw);
  if (!harness) {
    problems.push(
      `${at} (${id}): unknown harness ${fmt(raw['harness'])} — expected one of ${HARNESS_IDS.join(', ')}; dropped`,
    );
    return null;
  }

  let enabled = true;
  if ('enabled' in raw) {
    const b = asBoolean(raw['enabled']);
    if (b === null) problems.push(`${at} (${id}): enabled must be true or false, got ${fmt(raw['enabled'])} — using true`);
    else enabled = b;
  }

  const secret = asString(raw['secret']) ?? DEFAULT_SECRET[harness];
  if ('secret' in raw && !asString(raw['secret'])) {
    problems.push(`${at} (${id}): secret must be an env var NAME — using ${secret}`);
  }

  const model: ModelConfig = { id, harness, enabled, secret };

  const label = asString(raw['label']);
  if (label) model.label = label;
  const harnessModel = asString(raw['harness_model']);
  if (harnessModel) model.harness_model = harnessModel;
  const pricingKey = asString(raw['pricing_key']);
  if (pricingKey) model.pricing_key = pricingKey;
  const baseUrl = asString(raw['base_url']);
  if (baseUrl) model.base_url = baseUrl;

  if ('args' in raw) {
    if (isRecord(raw['args'])) model.args = raw['args'];
    else problems.push(`${at} (${id}): args must be a mapping, got ${fmt(raw['args'])} — ignored`);
  }

  const timeout = numberIn(raw['timeout_seconds'], `${at} (${id}).timeout_seconds`, 1, 86_400, problems);
  if (timeout !== null) model.timeout_seconds = Math.round(timeout);
  const maxTurns = numberIn(raw['max_turns'], `${at} (${id}).max_turns`, 0, 1000, problems);
  if (maxTurns !== null) model.max_turns = Math.round(maxTurns);

  return model;
}

const CONSENSUS_KEYS = [
  'min_agreement',
  'verify_solo_findings',
  'verify_model',
  'referee_model',
  'jaccard_merge_threshold',
  'jaccard_distinct_threshold',
  'line_window',
];

function applyConsensus(config: JurorConfig, raw: unknown, problems: string[]): void {
  const section = sectionOf(raw, 'consensus', problems);
  if (!section) return;
  reportUnknown(section, CONSENSUS_KEYS, 'consensus', problems);
  const c = config.consensus;

  if ('min_agreement' in section) {
    const v = section['min_agreement'];
    const s = asString(v);
    const n = asNumber(v);
    if (s === 'majority' || s === 'all') c.min_agreement = s;
    else if (n !== null && Number.isFinite(n) && n >= 1) c.min_agreement = Math.round(n);
    else
      problems.push(
        `consensus.min_agreement: expected \`majority\`, \`all\`, or a number >= 1, got ${fmt(v)} — using ${fmt(c.min_agreement)}`,
      );
  }

  const solo = boolean(section['verify_solo_findings'], 'consensus.verify_solo_findings', problems);
  if (solo !== null) c.verify_solo_findings = solo;

  if ('verify_model' in section) c.verify_model = modelRef(section['verify_model'], 'consensus.verify_model', c.verify_model, problems);
  if ('referee_model' in section) c.referee_model = modelRef(section['referee_model'], 'consensus.referee_model', c.referee_model, problems);

  const merge = numberIn(section['jaccard_merge_threshold'], 'consensus.jaccard_merge_threshold', 0, 1, problems);
  if (merge !== null) c.jaccard_merge_threshold = merge;
  const distinct = numberIn(section['jaccard_distinct_threshold'], 'consensus.jaccard_distinct_threshold', 0, 1, problems);
  if (distinct !== null) c.jaccard_distinct_threshold = distinct;

  if (c.jaccard_distinct_threshold > c.jaccard_merge_threshold) {
    problems.push(
      `consensus: jaccard_distinct_threshold (${c.jaccard_distinct_threshold}) is above jaccard_merge_threshold (${c.jaccard_merge_threshold}) — title-only similarity cannot reach the referee routing floor`,
    );
  }

  const window = numberIn(section['line_window'], 'consensus.line_window', 0, 500, problems);
  if (window !== null) c.line_window = Math.round(window);
}

const REVIEW_KEYS = [
  'publish_mode',
  'severity_floor',
  'max_inline_comments',
  'incremental',
  'paths_ignore',
  'anchor_tolerance',
  'max_diff_bytes',
  'per_model_timeout_seconds',
  'max_turns',
];

function applyReview(config: JurorConfig, raw: unknown, problems: string[]): void {
  const section = sectionOf(raw, 'review', problems);
  if (!section) return;
  reportUnknown(section, REVIEW_KEYS, 'review', problems);
  const r = config.review;

  if ('publish_mode' in section) {
    const s = asString(section['publish_mode']);
    const mode = PUBLISH_MODES.find((m) => m === s);
    if (mode) r.publish_mode = mode;
    else
      problems.push(
        `review.publish_mode: expected one of ${PUBLISH_MODES.join(', ')}, got ${fmt(section['publish_mode'])} — using ${r.publish_mode}`,
      );
  }

  if ('severity_floor' in section) {
    const s = asString(section['severity_floor'])?.toUpperCase();
    const sev = SEVERITIES.find((x) => x === s);
    if (sev) r.severity_floor = sev;
    else
      problems.push(
        `review.severity_floor: expected one of ${SEVERITIES.join(', ')}, got ${fmt(section['severity_floor'])} — using ${r.severity_floor}`,
      );
  }

  const maxInline = numberIn(section['max_inline_comments'], 'review.max_inline_comments', 0, 200, problems);
  if (maxInline !== null) r.max_inline_comments = Math.round(maxInline);

  const incremental = boolean(section['incremental'], 'review.incremental', problems);
  if (incremental !== null) r.incremental = incremental;

  if ('paths_ignore' in section) {
    const globs = asStringArray(section['paths_ignore']);
    if (globs) r.paths_ignore = globs;
    else problems.push(`review.paths_ignore: expected a list of glob strings, got ${fmt(section['paths_ignore'])} — using the defaults`);
  }

  const tolerance = numberIn(section['anchor_tolerance'], 'review.anchor_tolerance', 0, 100, problems);
  if (tolerance !== null) r.anchor_tolerance = Math.round(tolerance);

  const maxBytes = numberIn(section['max_diff_bytes'], 'review.max_diff_bytes', 1_000, 20_000_000, problems);
  if (maxBytes !== null) r.max_diff_bytes = Math.round(maxBytes);

  const timeout = numberIn(section['per_model_timeout_seconds'], 'review.per_model_timeout_seconds', 30, 86_400, problems);
  if (timeout !== null) r.per_model_timeout_seconds = Math.round(timeout);

  const maxTurns = numberIn(section['max_turns'], 'review.max_turns', 0, 1000, problems);
  if (maxTurns !== null) r.max_turns = Math.round(maxTurns);
}

function applyBudget(config: JurorConfig, raw: unknown, problems: string[]): void {
  const section = sectionOf(raw, 'budget', problems);
  if (!section) return;
  reportUnknown(section, ['max_cost_usd_per_pr', 'on_exceed'], 'budget', problems);

  const max = numberIn(section['max_cost_usd_per_pr'], 'budget.max_cost_usd_per_pr', 0, 10_000, problems);
  if (max !== null) config.budget.max_cost_usd_per_pr = max;

  if ('on_exceed' in section) {
    const s = asString(section['on_exceed']);
    const mode = ON_EXCEED_MODES.find((m) => m === s);
    if (mode) config.budget.on_exceed = mode;
    else
      problems.push(
        `budget.on_exceed: expected one of ${ON_EXCEED_MODES.join(', ')}, got ${fmt(section['on_exceed'])} — using ${config.budget.on_exceed}`,
      );
  }
}

function applyOutput(config: JurorConfig, raw: unknown, problems: string[]): void {
  const section = sectionOf(raw, 'output', problems);
  if (!section) return;
  reportUnknown(section, ['sequence_diagram', 'cost_receipt', 'suppressed_findings'], 'output', problems);

  const diagram = boolean(section['sequence_diagram'], 'output.sequence_diagram', problems);
  if (diagram !== null) config.output.sequence_diagram = diagram;
  const receipt = boolean(section['cost_receipt'], 'output.cost_receipt', problems);
  if (receipt !== null) config.output.cost_receipt = receipt;

  if ('suppressed_findings' in section) {
    const s = asString(section['suppressed_findings']);
    const mode = SUPPRESSED_MODES.find((m) => m === s);
    if (mode) config.output.suppressed_findings = mode;
    else
      problems.push(
        `output.suppressed_findings: expected one of ${SUPPRESSED_MODES.join(', ')}, got ${fmt(section['suppressed_findings'])} — using ${config.output.suppressed_findings}`,
      );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime resolution
// ─────────────────────────────────────────────────────────────────────────────

export function resolveModelRuntime(m: ModelConfig): { harnessModel: string; pricingKey: string; label: string } {
  return {
    harnessModel: m.harness_model ?? m.id,
    // Pricing tables are keyed the way the provider names the model, which is usually the
    // harness string rather than our short id.
    pricingKey: m.pricing_key ?? m.harness_model ?? m.id,
    label: m.label ?? prettifyId(m.id),
  };
}

function prettifyId(id: string): string {
  const tail = id.split('/').pop() ?? id;
  return (
    tail
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((w) => (w.charAt(0) ? w.charAt(0).toUpperCase() + w.slice(1) : w))
      .join(' ') || id
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt templates
// ─────────────────────────────────────────────────────────────────────────────

const PROMPT_CACHE = new Map<string, string>();

export function loadPromptTemplate(name: 'review' | 'referee' | 'verify'): string {
  const cached = PROMPT_CACHE.get(name);
  if (cached !== undefined) return cached;

  // Compiled code lives in `dist/`, where the build copies the templates alongside it;
  // running straight from `src/` (or from a dist that predates the copy step) has to reach
  // back into the source tree.
  const candidates = [
    new URL(`./prompts/${name}.md`, import.meta.url),
    new URL(`../src/prompts/${name}.md`, import.meta.url),
    new URL(`../../src/prompts/${name}.md`, import.meta.url),
  ];

  for (const url of candidates) {
    try {
      const text = readFileSync(fileURLToPath(url), 'utf8');
      PROMPT_CACHE.set(name, text);
      return text;
    } catch {
      // Try the next layout.
    }
  }
  throw new Error(`prompt template not found: prompts/${name}.md (looked next to ${import.meta.url})`);
}

export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  // Unknown placeholders are left verbatim — a hole in the prompt is easier to spot than a
  // silent empty string.
  return tpl.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (whole, key: string) => vars[key] ?? whole);
}

// ─────────────────────────────────────────────────────────────────────────────
// Small coercion helpers
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sectionOf(raw: unknown, name: string, problems: string[]): Record<string, unknown> | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) {
    problems.push(`${name}: expected a mapping, got ${fmt(raw)} — using the defaults`);
    return null;
  }
  return raw;
}

function reportUnknown(raw: Record<string, unknown>, known: string[], prefix: string, problems: string[]): void {
  for (const key of Object.keys(raw)) {
    if (known.includes(key)) continue;
    problems.push(`unknown key \`${prefix ? `${prefix}.` : ''}${key}\` — ignored`);
  }
}

function asString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function asBoolean(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  return null;
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) {
    const s = asString(item);
    if (!s) return null;
    out.push(s);
  }
  return out;
}

function boolean(v: unknown, at: string, problems: string[]): boolean | null {
  if (v === undefined) return null;
  const b = asBoolean(v);
  if (b === null) {
    problems.push(`${at}: expected true or false, got ${fmt(v)} — using the default`);
    return null;
  }
  return b;
}

function numberIn(v: unknown, at: string, min: number, max: number, problems: string[]): number | null {
  if (v === undefined) return null;
  const n = asNumber(v);
  if (n === null) {
    problems.push(`${at}: expected a number, got ${fmt(v)} — using the default`);
    return null;
  }
  if (n < min || n > max) {
    problems.push(`${at}: ${n} is outside ${min}–${max} — using the default`);
    return null;
  }
  return n;
}

/** `null` is a legal value here — it disables the referee/verify pass entirely. */
function modelRef(v: unknown, at: string, fallback: string | null, problems: string[]): string | null {
  if (v === null) return null;
  const s = asString(v);
  if (s) return s;
  problems.push(`${at}: expected a model id or null, got ${fmt(v)} — using ${fmt(fallback)}`);
  return fallback;
}

function fmt(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (v === null) return 'null';
  if (v === undefined) return 'nothing';
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
