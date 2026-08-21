import { describe, expect, it } from 'vitest';
import { hmacHex, timingSafeEqual, verifyHmacHeader } from '../worker/crypto';
import { verifyStripeSignature } from '../worker/stripe';
import { requireAdmin } from '../worker/auth';
import { HTTPException } from 'hono/http-exception';
import { readFile } from 'node:fs/promises';
import { unsafeQaOrigin } from '../worker/qa-security';
import { sandboxGithubRequestAllowed } from '../worker/github-egress';
import { renderHostedSummary } from '../worker/github-publish';
import type { HostedReviewReportV1 } from '../../src/cloud/types';
import { redactSensitiveJson } from '../worker/report-redaction';
import { qaTargetHosts } from '../worker/sandbox-network';

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
    expect(runner).not.toContain("'--post'");
    expect(runner).not.toContain('GITHUB_APP_PRIVATE_KEY');
  });

  it('never routes credential-bearing QA targets into review sandboxes', () => {
    const origins = ['https://staging.example.com', 'https://staging.example.com:443', 'https://api.example.com'];
    expect(qaTargetHosts('review', origins)).toEqual([]);
    expect(qaTargetHosts('qa', origins)).toEqual(['staging.example.com', 'api.example.com']);
  });

  it('limits Sandbox GitHub access to repository reads and git upload-pack', () => {
    const params = { runId: 'run_1', repository: 'Juror-AI/juror', prNumber: 74, revisionSha: 'a'.repeat(40), kind: 'review' as const };
    expect(sandboxGithubRequestAllowed(new Request('https://api.github.com/repos/Juror-AI/juror/pulls/74'), params)).toBe(true);
    expect(sandboxGithubRequestAllowed(new Request(`https://api.github.com/repos/Juror-AI/juror/compare/${'a'.repeat(40)}...${'b'.repeat(40)}`), params)).toBe(true);
    expect(sandboxGithubRequestAllowed(new Request('https://github.com/Juror-AI/juror.git/info/refs?service=git-upload-pack'), params)).toBe(true);
    expect(sandboxGithubRequestAllowed(new Request('https://github.com/Juror-AI/juror.git/git-upload-pack', { method: 'POST' }), params)).toBe(true);
    expect(sandboxGithubRequestAllowed(new Request('https://api.github.com/repos/Juror-AI/juror/issues/74/comments', { method: 'POST' }), params)).toBe(false);
    expect(sandboxGithubRequestAllowed(new Request('https://api.github.com/repos/other/repo/pulls/74'), params)).toBe(false);
    expect(sandboxGithubRequestAllowed(new Request('https://api.github.com/user'), params)).toBe(false);
  });

  it('defangs untrusted model text before trusted Worker publication', () => {
    const secret = `sk-proj-${'a'.repeat(40)}`;
    const report = {
      models: [{ skipped: false }],
      clusters: [],
      publishedFingerprints: [],
      summary: { summary: `<!-- juror-cloud:summary:v1 --> ping @octocat ${secret}` },
      verdict: { score: 4, confirmed: { P0: 0, P1: 0, P2: 0, P3: 0 } },
      totals: { usd: 1.25 },
    } as unknown as HostedReviewReportV1;
    const rendered = renderHostedSummary(report, 'https://cloud.example/runs/run_1');
    expect(rendered.match(/<!-- juror-cloud:summary:v1 -->/g)).toHaveLength(1);
    expect(rendered).toContain('&lt;!-- juror-cloud:summary:v1 -->');
    expect(rendered).toContain('@\u200boctocat');
    expect(rendered).not.toContain(secret);
  });

  it('redacts raw and encoded QA credentials from reflected semantic output', () => {
    const secret = 'qa secret/value+123';
    const reflected = { actual: `token=${secret}`, nested: [`encoded=${encodeURIComponent(secret)}`, `base64=${btoa(secret)}`] };
    const redacted = JSON.stringify(redactSensitiveJson(reflected, [secret]));
    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain(encodeURIComponent(secret));
    expect(redacted).not.toContain(btoa(secret));
    expect(redacted).toContain('[redacted]');
  });

  it('redacts QA reports before any retained report or evidence write', async () => {
    const workflows = await readFile(new URL('../worker/workflows.ts', import.meta.url), 'utf8');
    const redaction = workflows.indexOf('reportJson = await sanitizeQaReportForRetention');
    const retention = workflows.indexOf('await env.REPORTS.put');
    expect(redaction).toBeGreaterThan(-1);
    expect(retention).toBeGreaterThan(redaction);
  });

  it('recovers serialized QA admission through a durable queue and scheduled sweep', async () => {
    const workflows = await readFile(new URL('../worker/workflows.ts', import.meta.url), 'utf8');
    const queue = await readFile(new URL('../worker/queue.ts', import.meta.url), 'utf8');
    const wrangler = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
    expect(workflows).toContain("kind: 'qa_admission'");
    expect(workflows).toContain('sweepQueuedQaAdmissions');
    expect(queue).toContain("message.kind === 'qa_admission'");
    expect(wrangler).toContain('*/5 * * * *');
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
