import { describe, expect, it } from 'vitest';
import { hmacHex, timingSafeEqual, verifyHmacHeader } from '../worker/crypto';
import { verifyStripeSignature } from '../worker/stripe';
import { requireAdmin } from '../worker/auth';
import { HTTPException } from 'hono/http-exception';
import { readFile } from 'node:fs/promises';
import { unsafeQaOrigin } from '../worker/qa-security';

describe('webhook security boundaries', () => {
  it('accepts only the matching GitHub HMAC', async () => {
    const body = JSON.stringify({ action: 'opened' });
    const signature = await hmacHex('webhook-secret', body);
    await expect(verifyHmacHeader('webhook-secret', body, `sha256=${signature}`)).resolves.toBe(true);
    await expect(verifyHmacHeader('webhook-secret', `${body}x`, `sha256=${signature}`)).resolves.toBe(false);
    await expect(verifyHmacHeader('webhook-secret', body, null)).resolves.toBe(false);
  });

  it('enforces Stripe timestamp tolerance and signature', async () => {
    const body = JSON.stringify({ id: 'evt_1' });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await hmacHex('stripe-secret', `${timestamp}.${body}`);
    await expect(verifyStripeSignature('stripe-secret', body, `t=${timestamp},v1=${signature}`)).resolves.toBe(true);
    await expect(verifyStripeSignature('stripe-secret', body, `t=${timestamp},v1=${signature},v1=${'0'.repeat(64)}`)).resolves.toBe(true);
    await expect(verifyStripeSignature('stripe-secret', body, `t=${timestamp - 601},v1=${signature}`)).resolves.toBe(false);
  });

  it('uses a length-independent comparison and enforces admin-only mutations', () => {
    expect(timingSafeEqual('same', 'same')).toBe(true);
    expect(timingSafeEqual('same', 'different')).toBe(false);
    expect(() => requireAdmin({ userId: 'u', workspaceId: 'w', role: 'admin' })).not.toThrow();
    expect(() => requireAdmin({ userId: 'u', workspaceId: 'w', role: 'member' })).toThrow(HTTPException);
  });

  it('keeps live credentials in outbound handlers and always destroys the sandbox', async () => {
    const sandbox = await readFile(new URL('../worker/sandbox.ts', import.meta.url), 'utf8');
    const workflows = await readFile(new URL('../worker/workflows.ts', import.meta.url), 'utf8');
    const runner = await readFile(new URL('../runner/runner.mjs', import.meta.url), 'utf8');
    expect(sandbox).toContain('enableInternet = false');
    expect(sandbox).toContain("next.headers.set('authorization'");
    expect(sandbox).toContain("redirect: 'manual'");
    expect(workflows).toContain("GITHUB_TOKEN: 'injected-by-juror-outbound-handler'");
    expect(workflows).toMatch(/finally\s*{\s*await sandbox\.destroy\(\)/);
    expect(runner).toContain('x-access-token:${githubPlaceholder}@github.com');
    expect(runner).not.toContain('GITHUB_APP_PRIVATE_KEY');
  });

  it('admits only public HTTPS QA origins outside credential-bearing hosts', () => {
    const appUrl = 'https://juror-cloud.example.workers.dev';
    expect(unsafeQaOrigin(['https://staging.example.com'], appUrl)).toBeNull();
    for (const origin of [
      'http://staging.example.com',
      'https://localhost',
      'https://127.0.0.1',
      'https://[::1]',
      'https://service.internal',
      'https://api.openai.com',
      appUrl,
    ]) expect(unsafeQaOrigin([origin], appUrl)).toBe(origin);
  });
});
