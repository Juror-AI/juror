import { isQaRunResult } from '../../src/qa/result-validator.js';
import type { Env } from './env';
import { decryptWorkspaceSecret } from './crypto';

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function variants(secrets: readonly string[]): string[] {
  const values = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    values.add(secret);
    values.add(encodeURIComponent(secret));
    values.add(base64(secret));
  }
  return [...values].filter(Boolean).sort((left, right) => right.length - left.length);
}

function safeMarker(values: readonly string[]): string {
  for (const candidate of ['[redacted]', '[secret removed]', '[credential omitted]']) {
    if (values.every((value) => !candidate.includes(value) && !value.includes(candidate))) return candidate;
  }
  for (let codePoint = 0xe000; codePoint <= 0xf8ff; codePoint += 1) {
    const candidate = String.fromCodePoint(codePoint);
    if (values.every((value) => !candidate.includes(value) && !value.includes(candidate))) return candidate;
  }
  throw new Error('Unable to select a collision-free QA redaction marker');
}

function replaceAll(value: string, sensitive: readonly string[], marker: string): string {
  let redacted = value;
  for (const secret of sensitive) redacted = redacted.split(secret).join(marker);
  return redacted;
}

/** Recursively redacts string values without ever rewriting schema object keys. */
export function redactSensitiveJson(value: unknown, secrets: readonly string[]): unknown {
  const sensitive = variants(secrets);
  if (!sensitive.length) return value;
  const marker = safeMarker(sensitive);
  const walk = (current: unknown): unknown => {
    if (typeof current === 'string') return replaceAll(current, sensitive, marker);
    if (Array.isArray(current)) return current.map(walk);
    if (current && typeof current === 'object') return Object.fromEntries(Object.entries(current).map(([key, item]) => [key, walk(item)]));
    return current;
  };
  return walk(value);
}

async function workspaceQaSecrets(env: Env, runId: string): Promise<string[]> {
  const row = await env.DB.prepare(`SELECT r.workspace_id, rs.qa_session_bootstrap_ciphertext, rs.qa_secret_headers_ciphertext, rs.qa_reset_hook_ciphertext FROM run r JOIN repository_settings rs ON rs.repository_id = r.repository_id WHERE r.id = ?`)
    .bind(runId).first<{ workspace_id: string; qa_session_bootstrap_ciphertext: string | null; qa_secret_headers_ciphertext: string | null; qa_reset_hook_ciphertext: string | null }>();
  if (!row) throw new Error('QA redaction context is missing');
  const secrets: string[] = [];
  if (row.qa_session_bootstrap_ciphertext) secrets.push(await decryptWorkspaceSecret(env, row.workspace_id, row.qa_session_bootstrap_ciphertext));
  if (row.qa_secret_headers_ciphertext) {
    const headers = JSON.parse(await decryptWorkspaceSecret(env, row.workspace_id, row.qa_secret_headers_ciphertext)) as Array<{ value?: unknown }>;
    for (const header of headers) if (typeof header.value === 'string') secrets.push(header.value);
  }
  if (row.qa_reset_hook_ciphertext) {
    const reset = JSON.parse(await decryptWorkspaceSecret(env, row.workspace_id, row.qa_reset_hook_ciphertext)) as { secretHeaders?: Array<{ value?: unknown }> };
    for (const header of reset.secretHeaders ?? []) if (typeof header.value === 'string') secrets.push(header.value);
  }
  return [...new Set(secrets.filter(Boolean))];
}

/** Fail closed before retention if redaction would damage the versioned QA contract. */
export async function sanitizeQaReportForRetention(env: Env, runId: string, reportJson: string): Promise<string> {
  const secrets = await workspaceQaSecrets(env, runId);
  if (!secrets.length) return reportJson;
  const sensitive = variants(secrets);
  const redacted = redactSensitiveJson(JSON.parse(reportJson), secrets);
  if (!isQaRunResult(redacted)) throw new Error('QA credential redaction invalidated the retained report contract');
  const serialized = JSON.stringify(redacted);
  if (sensitive.some((secret) => serialized.includes(secret))) throw new Error('QA credential survived trusted report redaction');
  return serialized;
}
