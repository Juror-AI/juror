import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { mcpResourceUrl, oauthIssuerUrl } from '../worker/auth';

describe('Juror MCP contract', () => {
  it('uses the canonical protected resource and OAuth issuer', () => {
    const env = { APP_URL: 'https://app.juror.dev', LEGACY_APP_URL: '' };
    expect(mcpResourceUrl(env)).toBe('https://app.juror.dev/mcp');
    expect(oauthIssuerUrl(env)).toBe('https://app.juror.dev/api/auth');
  });

  it('declares the bounded v1 tool set, annotations, and no legacy SSE transport', async () => {
    const source = await readFile(new URL('../worker/mcp.ts', import.meta.url), 'utf8');
    for (const tool of ['juror_list_workspaces', 'juror_overview', 'juror_list_repositories', 'juror_list_findings', 'juror_get_finding_detail', 'juror_list_runs', 'juror_get_run', 'juror_prepare_review', 'juror_start_review', 'juror_prepare_rerun', 'juror_rerun_review']) {
      expect(source).toContain(`registerTool('${tool}'`);
    }
    expect(source).toContain("legacy: 'reject'");
    expect(source).toContain('readOnlyHint: true');
    expect(source).toContain('readOnlyHint: false');
    expect(source).toContain('juror.read');
    expect(source).toContain('juror.reviews.write');
    expect(source).toContain('resourceUri: REVIEW_CARD_URI');
    expect(source).toContain("request('ui/initialize'");
    expect(source).toContain("'ui/notifications/tool-result'");
    expect(source).toContain("'ui/open-link'");
    expect(source).toContain('hasActiveMcpSession');
    expect(source).not.toContain("registerTool('juror_cancel");
  });

  it('requires workspace selection and an expiring, atomically consumed intent for writes', async () => {
    const source = await readFile(new URL('../worker/review-service.ts', import.meta.url), 'utf8');
    expect(source).toContain('workspace_id = ?');
    expect(source).toContain('Date.now() + 5 * 60_000');
    expect(source).toContain('consumed_at IS NULL AND expires_at > ?');
    expect(source).toContain('pull_request_changed');
    expect(source).toContain('detectJurorWorkflow');
  });

  it('uses public-only DCR, PKCE S256, short-lived tokens, and a signed-in session for revocation', async () => {
    const [auth, worker] = await Promise.all([
      readFile(new URL('../worker/auth.ts', import.meta.url), 'utf8'),
      readFile(new URL('../worker/index.ts', import.meta.url), 'utf8'),
    ]);
    expect(auth).toContain('accessTokenExpiresIn: 300');
    expect(auth).toContain("grantTypes: ['authorization_code', 'refresh_token']");
    expect(auth).toContain('clientRegistrationRequirePKCE: true');
    expect(worker).toContain('normalizePublicDcrRegistration');
    expect(worker).toContain('PKCE S256 only');
    expect(worker).toContain("'/.well-known/openai-apps-challenge'");
    expect(worker).toContain("'cache-control': 'no-store'");
  });
});
