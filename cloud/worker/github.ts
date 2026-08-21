import type { Env } from './env';

const encoder = new TextEncoder();

function base64UrlString(value: string): string {
  return btoa(value).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodePem(pem: string): ArrayBuffer {
  const normalized = pem.replace(/\\n/g, '\n').replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
}

export async function createGitHubAppJwt(env: Env): Promise<string> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) throw new Error('GitHub App credentials are not configured');
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlString(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64UrlString(JSON.stringify({ iat: now - 30, exp: now + 8 * 60, iss: env.GITHUB_APP_ID }));
  const key = await crypto.subtle.importKey('pkcs8', decodePem(env.GITHUB_APP_PRIVATE_KEY), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64UrlBytes(new Uint8Array(signature))}`;
}

export async function createInstallationToken(env: Env, installationId: number): Promise<string> {
  const jwt = await createGitHubAppJwt(env);
  const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${jwt}`,
      'user-agent': 'juror-cloud/1',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GitHub installation token failed (${response.status})`);
  const body = await response.json<{ token: string }>();
  return body.token;
}

export async function installationIdForRun(env: Env, runId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT i.github_installation_id AS installation_id FROM run r JOIN installation i ON i.workspace_id = r.workspace_id WHERE r.id = ?`)
    .bind(runId).first<{ installation_id: number }>();
  if (!row) throw new Error('No GitHub installation for run');
  return row.installation_id;
}

export async function githubApi(env: Env, installationId: number, path: string, init: RequestInit = {}): Promise<Response> {
  const token = await createInstallationToken(env, installationId);
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/vnd.github+json');
  headers.set('authorization', `Bearer ${token}`);
  headers.set('user-agent', 'juror-cloud/1');
  headers.set('x-github-api-version', '2022-11-28');
  return fetch(`https://api.github.com${path}`, { ...init, headers });
}
