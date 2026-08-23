import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiMutation } from '../src/lib/api';

describe('apiMutation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('turns a plain-text expired-session response into an actionable error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Unauthorized', { status: 401 })));

    await expect(apiMutation('/api/usage/cap', 'PATCH', { capMicroUsd: 1_000_000 }))
      .rejects.toThrow('Sign in to continue.');
  });
});
