import { describe, expect, it } from 'vitest';

import {
  preflightQaTestability,
  safeQaEarlyExitPattern,
} from '../src/qa/testability.js';

describe('QA changed-path testability preflight', () => {
  const rules = ['.github/**', 'docs/**', 'infrastructure/**', '**/*.tf'];

  it('returns a fixed neutral plan only when every changed path matches trusted rules', () => {
    const result = preflightQaTestability([
      '.github/workflows/lint.yml',
      'infrastructure/staging/main.tf',
    ], rules);

    expect(result).toMatchObject({
      schema_version: 1,
      testability: 'no_testable_surface',
      surfaces: [],
      scenarios: [],
    });
    expect(result?.no_testable_surface_reason).toContain('trusted early-exit rule');
  });

  it.each([
    [undefined, rules],
    [[], rules],
    [['docs/qa.md'], []],
    [['docs/qa.md', 'src/app.ts'], rules],
    [['/docs/qa.md'], rules],
    [['docs/../src/app.ts'], rules],
    [['docs/qa.md\ninfra/main.tf'], rules],
  ] as const)('fails open for an incomplete, mixed, or unsafe manifest', (files, patterns) => {
    expect(preflightQaTestability(files, patterns)).toBeNull();
  });

  it('does not skip browser-affecting product runtime paths', () => {
    expect(preflightQaTestability([
      'shared/file-types.ts',
      'web/src/file-picker.tsx',
      'server/mime-types.ts',
    ], rules)).toBeNull();
  });

  it.each([
    '!src/**',
    '/infra/**',
    '../infra/**',
    'infra/../src/**',
    'infra\\**',
    'infra/**\napps/**',
    '',
  ])('rejects unsafe or surprising early-exit patterns: %s', (pattern) => {
    expect(safeQaEarlyExitPattern(pattern)).toBe(false);
  });
});
