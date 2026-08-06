import { describe, expect, it } from 'vitest';

import { harnessScratch } from '../src/harness/runner.js';

describe('harnessScratch', () => {
  it('separates model ids that normalize to the same filesystem slug', () => {
    expect(harnessScratch('/tmp/juror', 'foo/bar')).not.toBe(
      harnessScratch('/tmp/juror', 'foo-bar'),
    );
  });

  it('separates duplicate configured ids by their fan-out ordinal', () => {
    expect(harnessScratch('/tmp/juror', 'same', 0)).not.toBe(
      harnessScratch('/tmp/juror', 'same', 1),
    );
  });
});
