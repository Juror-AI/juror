import { describe, expect, it } from 'vitest';

import { defaultConfig } from '../src/config.js';
import { runReview } from '../src/review.js';
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
