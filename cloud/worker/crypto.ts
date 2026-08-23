import type { Env } from './env';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function asBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy.buffer;
}

function base64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) mismatch |= (a[index % a.length] ?? 0) ^ (b[index % b.length] ?? 0);
  return mismatch === 0;
}

export async function verifyHmacHeader(secret: string, body: string, signature: string | null, prefix = 'sha256='): Promise<boolean> {
  if (!signature?.startsWith(prefix)) return false;
  const expected = await hmacHex(secret, body);
  return timingSafeEqual(expected, signature.slice(prefix.length));
}

async function importMasterKey(value: string): Promise<CryptoKey> {
  const bytes = base64ToBytes(value);
  if (bytes.byteLength !== 32) throw new Error('QA_MASTER_KEY_B64 must decode to exactly 32 bytes');
  return crypto.subtle.importKey('raw', asBuffer(bytes), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

interface CipherEnvelopeV1 {
  version: 1;
  keyVersion: number;
  wrapIv: string;
  wrappedKey: string;
  dataIv: string;
  ciphertext: string;
}

async function wrapDataKey(masterKey: CryptoKey, dataKey: Uint8Array, workspaceId: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: asBuffer(iv), additionalData: encoder.encode(workspaceId) }, masterKey, asBuffer(dataKey));
  return JSON.stringify({ iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(encrypted)) });
}

async function unwrapDataKey(masterKey: CryptoKey, wrapped: string, workspaceId: string): Promise<Uint8Array> {
  const parsed = JSON.parse(wrapped) as { iv: string; ciphertext: string };
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: asBuffer(base64ToBytes(parsed.iv)), additionalData: encoder.encode(workspaceId) }, masterKey, asBuffer(base64ToBytes(parsed.ciphertext)));
  return new Uint8Array(plaintext);
}

async function getWorkspaceDataKey(env: Env, workspaceId: string): Promise<{ keyVersion: number; key: Uint8Array; wrapped: string }> {
  const master = await importMasterKey(env.QA_MASTER_KEY_B64);
  const existing = await env.DB.prepare('SELECT key_version, wrapped_data_key FROM workspace_data_key WHERE workspace_id = ?').bind(workspaceId).first<{ key_version: number; wrapped_data_key: string }>();
  if (existing) return { keyVersion: existing.key_version, key: await unwrapDataKey(master, existing.wrapped_data_key, workspaceId), wrapped: existing.wrapped_data_key };

  const generated = crypto.getRandomValues(new Uint8Array(32));
  const wrapped = await wrapDataKey(master, generated, workspaceId);
  await env.DB.prepare('INSERT OR IGNORE INTO workspace_data_key (workspace_id, key_version, wrapped_data_key, created_at) VALUES (?, 1, ?, ?)')
    .bind(workspaceId, wrapped, new Date().toISOString()).run();
  const winner = await env.DB.prepare('SELECT key_version, wrapped_data_key FROM workspace_data_key WHERE workspace_id = ?').bind(workspaceId).first<{ key_version: number; wrapped_data_key: string }>();
  if (!winner) throw new Error('Unable to create workspace data key');
  return { keyVersion: winner.key_version, key: await unwrapDataKey(master, winner.wrapped_data_key, workspaceId), wrapped: winner.wrapped_data_key };
}

export async function encryptWorkspaceSecret(env: Env, workspaceId: string, plaintext: string): Promise<string> {
  const { keyVersion, key, wrapped } = await getWorkspaceDataKey(env, workspaceId);
  const imported = await crypto.subtle.importKey('raw', asBuffer(key), 'AES-GCM', false, ['encrypt']);
  const dataIv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: asBuffer(dataIv), additionalData: encoder.encode(workspaceId) }, imported, encoder.encode(plaintext));
  const wrap = JSON.parse(wrapped) as { iv: string; ciphertext: string };
  const envelope: CipherEnvelopeV1 = { version: 1, keyVersion, wrapIv: wrap.iv, wrappedKey: wrap.ciphertext, dataIv: bytesToBase64(dataIv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
  return JSON.stringify(envelope);
}

export async function decryptWorkspaceSecret(env: Env, workspaceId: string, serialized: string): Promise<string> {
  const envelope = JSON.parse(serialized) as CipherEnvelopeV1;
  if (envelope.version !== 1) throw new Error('Unsupported secret envelope');
  const master = await importMasterKey(env.QA_MASTER_KEY_B64);
  const wrapped = JSON.stringify({ iv: envelope.wrapIv, ciphertext: envelope.wrappedKey });
  const dataKey = await unwrapDataKey(master, wrapped, workspaceId);
  const imported = await crypto.subtle.importKey('raw', asBuffer(dataKey), 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: asBuffer(base64ToBytes(envelope.dataIv)), additionalData: encoder.encode(workspaceId) }, imported, asBuffer(base64ToBytes(envelope.ciphertext)));
  return decoder.decode(plaintext);
}

export async function createSignedToken(secret: string, material: string): Promise<string> {
  const signatureHex = await hmacHex(secret, material);
  return base64Url(Uint8Array.from(signatureHex.match(/.{2}/g)!.map((hex) => Number.parseInt(hex, 16))));
}
