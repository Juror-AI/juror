import { describe, expect, it } from 'vitest';

import { defaultConfig } from '../src/config.js';
import { findModel, reviewPromptVars, runReview } from '../src/review.js';
import type { DiffContext, ModelConfig } from '../src/types.js';

describe('runReview empty diff', () => {
  it('returns a complete serializable no-op result instead of requiring a model', async () => {
    const diff: DiffContext = {
      patch: '',
      files: [],
      baseSha: 'base',
      headSha: 'head',
      sinceSha: null,
      totalAdditions: 0,
      totalDeletions: 0,
      ignoredPaths: [],
      truncated: false,
    };

    const result = await runReview({
      repoDir: process.cwd(),
      config: defaultConfig(),
      diff,
      secrets: {},
    });

    expect(result.published).toEqual([]);
    expect(result.totals).toMatchObject({ usd: 0, partial: false, modelsRun: 0 });
    expect(result.coverage.complete).toBe(true);
    expect(result.warnings.join(' ')).toContain('Nothing to review');
    expect(() => JSON.stringify(result)).not.toThrow();
  });
});

describe('review prompt context', () => {
  it('includes PR intent as explicitly untrusted metadata', () => {
    const diff: DiffContext = {
      patch: 'diff --git a/a.ts b/a.ts\n',
      files: [],
      baseSha: 'base',
      headSha: 'head',
      sinceSha: null,
      totalAdditions: 1,
      totalDeletions: 0,
      ignoredPaths: [],
      truncated: false,
    };

    const vars = reviewPromptVars(diff, '/repo', '(none)', {
      title: 'Stage shared modules',
      body: 'Copies are intentional until the follow-up rewires imports.',
    });

    expect(vars['PR_CONTEXT']).toContain('Stage shared modules');
    expect(vars['PR_CONTEXT']).toContain('Copies are intentional');
  });
});

describe('findModel secret-aware fallback', () => {
  const openai: ModelConfig = {
    id: 'gpt-5.6-luna',
    harness: 'codex',
    enabled: true,
    secret: 'JUROR_OPENAI_API_KEY',
    label: 'GPT-5.6 Luna',
  };
  const deepseek: ModelConfig = {
    id: 'deepseek-v4-flash-0731',
    harness: 'opencode',
    enabled: true,
    secret: 'JUROR_FIREWORKS_API_KEY',
    label: 'DeepSeek V4 Flash',
  };

  it('prefers the configured id when its secret is readable', () => {
    const config = {
      ...defaultConfig(),
      models: [openai, deepseek],
      consensus: {
        ...defaultConfig().consensus,
        referee_model: 'deepseek-v4-flash-0731',
      },
    };
    const warnings: string[] = [];
    const model = findModel(
      config,
      'deepseek-v4-flash-0731',
      { JUROR_FIREWORKS_API_KEY: 'fw-key', JUROR_OPENAI_API_KEY: 'oai-key' },
      warnings,
    );
    expect(model?.id).toBe('deepseek-v4-flash-0731');
    expect(warnings).toEqual([]);
  });

  it('falls back to the first enabled model with a readable secret and warns', () => {
    // Default fast preset pins deepseek as consensus; common onboarding only has OpenAI.
    const config = {
      ...defaultConfig(),
      models: [openai, deepseek],
      consensus: {
        ...defaultConfig().consensus,
        referee_model: 'deepseek-v4-flash-0731',
        verify_model: 'deepseek-v4-flash-0731',
      },
    };
    const warnings: string[] = [];
    const model = findModel(
      config,
      'deepseek-v4-flash-0731',
      { JUROR_OPENAI_API_KEY: 'oai-key-only' },
      warnings,
    );
    expect(model?.id).toBe('gpt-5.6-luna');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('deepseek-v4-flash-0731');
    expect(warnings[0]).toContain('gpt-5.6-luna');
    expect(warnings[0]).toMatch(/falling back/i);
  });

  it('returns null when id is null (referee/verify disabled)', () => {
    const warnings: string[] = [];
    expect(findModel(defaultConfig(), null, { JUROR_OPENAI_API_KEY: 'k' }, warnings)).toBeNull();
    expect(warnings).toEqual([]);
  });

  it('returns null when no enabled model has a readable secret', () => {
    const config = { ...defaultConfig(), models: [openai, deepseek] };
    const warnings: string[] = [];
    expect(findModel(config, 'deepseek-v4-flash-0731', {}, warnings)).toBeNull();
    expect(warnings).toEqual([]);
  });
});
