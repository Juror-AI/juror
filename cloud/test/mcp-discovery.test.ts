import prompts from '../../docs/mcp-prompt-selection.json';
import { describe, expect, it } from 'vitest';

describe('Juror plugin discovery prompts', () => {
  it('keeps direct, indirect, and negative selection prompts separate', () => {
    expect(prompts.direct).toHaveLength(2);
    expect(prompts.indirect).toHaveLength(2);
    expect(prompts.negative).toHaveLength(3);
    expect(prompts.direct.join(' ').toLowerCase()).toContain('juror');
    expect(prompts.negative.join(' ').toLowerCase()).toContain('local files');
    expect(prompts.expectations.negative).toBe('do_not_select_juror');
  });
});
