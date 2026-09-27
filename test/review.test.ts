import { describe, expect, it } from 'vitest';

import { defaultConfig } from '../src/config.js';
import { findModel, reviewPromptVars, runReview } from '../src/review.js';
import type { DiffContext } from '../src/types.js';

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

describe('consensus model selection', () => {
  it('falls back to a keyed jury member when the configured model has no provider key', () => {
    const config = defaultConfig();
    const id = config.consensus.referee_model;
    const configured = config.models.find((m) => m.id === id)!;
    const keyed = config.models.find((m) => m.enabled && m.secret !== configured.secret)!;

    const warnings: string[] = [];
    expect(findModel(config, id, { [keyed.secret]: 'test-key' }, warnings)?.id).toBe(keyed.id);
    expect(findModel(config, id, { [keyed.secret]: 'test-key' }, warnings)?.id).toBe(keyed.id);
    expect(warnings).toEqual([
      `consensus model ${id} has no provider key (${configured.secret}); using ${keyed.id} instead`,
    ]);

    const quiet: string[] = [];
    expect(findModel(config, id, { [configured.secret]: 'test-key' }, quiet)?.id).toBe(id);
    expect(findModel(config, id, {}, quiet)).toBeNull();
    expect(quiet).toEqual([]);
  });
});
