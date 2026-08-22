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

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let remaining = length; remaining > 0; remaining >>>= 8) bytes.unshift(remaining & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function derValue(tag: number, value: Uint8Array): Uint8Array {
  const length = derLength(value.length);
  const encoded = new Uint8Array(1 + length.length + value.length);
  encoded[0] = tag;
  encoded.set(length, 1);
  encoded.set(value, 1 + length.length);
  return encoded;
}

function concatenate(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

/** Wrap GitHub's PKCS#1 RSA key in the PKCS#8 PrivateKeyInfo Web Crypto imports. */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaAlgorithm = Uint8Array.of(0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00);
  return derValue(0x30, concatenate(version, rsaAlgorithm, derValue(0x04, pkcs1)));
}

function decodePem(pem: string): ArrayBuffer {
  const normalized = pem.replace(/\\r/g, '').replace(/\\n/g, '\n');
  const pkcs1 = normalized.match(/-----BEGIN RSA PRIVATE KEY-----([\s\S]*?)-----END RSA PRIVATE KEY-----/);
  const pkcs8 = normalized.match(/-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/);
  const match = pkcs1 ?? pkcs8;
  if (!match?.[1]) throw new Error('GitHub App private key must be PKCS#1 or PKCS#8 PEM');
  const decoded = decodeBase64(match[1].replace(/\s/g, ''));
  const bytes = pkcs1 ? pkcs1ToPkcs8(decoded) : decoded;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
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
