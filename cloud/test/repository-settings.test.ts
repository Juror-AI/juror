import { describe, expect, it, vi } from 'vitest';
import { repositorySettingsSchema, resolveSecretHeadersCiphertext } from '../worker/repository-settings';

describe('repository settings secrets', () => {
  it('accepts an explicit scoped-header clear and removes the ciphertext', async () => {
    const input = repositorySettingsSchema.parse({ secretHeaders: null });
    const encrypt = vi.fn(async () => 'replacement-ciphertext');

    await expect(resolveSecretHeadersCiphertext(input.secretHeaders, 'stored-ciphertext', encrypt)).resolves.toBeNull();
    expect(encrypt).not.toHaveBeenCalled();
  });

  it('retains scoped-header ciphertext when the field is omitted', async () => {
    const input = repositorySettingsSchema.parse({});

    await expect(resolveSecretHeadersCiphertext(input.secretHeaders, 'stored-ciphertext', vi.fn())).resolves.toBe('stored-ciphertext');
  });
});
