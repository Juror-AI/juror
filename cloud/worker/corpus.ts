import type { Env } from './env';

export type CorpusMode = 'off' | 'workspace_private' | 'shared';

type JsonObject = Record<string, unknown>;

export interface WebhookQueueMessage {
  kind: 'provider_webhook';
  provider: 'github' | 'stripe';
  deliveryId: string;
  eventName: string;
  receivedAt: string;
  payload: JsonObject;
}

export interface CorpusEventV1 {
  schemaVersion: 'corpus.event.v1';
  eventId: string;
  deliveryId: string;
  eventName: string;
  action: string;
  occurredAt: string;
  ingestedAt: string;
  workspaceId: string;
  repositoryId: string;
  repositoryVisibility: 'private' | 'public';
  consent: { mode: Exclude<CorpusMode, 'off'>; version: string; retentionDays: number };
  pullRequest: { number: number; state: string; baseSha: string | null; headSha: string | null; merged: boolean };
  subject: {
    kind: 'pull_request' | 'review' | 'review_comment' | 'conversation_comment' | 'review_thread';
    id: string;
    parentId: string | null;
    body: string | null;
    path: string | null;
    pathHash: string | null;
    line: number | null;
    state: string | null;
    deleted: boolean;
  };
  author: { pseudonym: string; kind: 'human' | 'bot' | 'juror' } | null;
  contentHash: string;
  redactionVersion: 'corpus-redaction.v1';
}

export interface CorpusQueueEventMessage {
  kind: 'corpus_event';
  event: CorpusEventV1;
}

export interface CorpusDeleteMessage {
  kind: 'corpus_delete';
  workspaceId: string;
  jobId: string;
}

export interface StripeMeterMessage {
  kind: 'stripe_meter';
  runId: string;
}

export interface WorkspaceDeleteMessage {
  kind: 'workspace_delete';
  workspaceId: string;
  jobId: string;
}

export type QueueMessage = WebhookQueueMessage | CorpusQueueEventMessage | CorpusDeleteMessage | StripeMeterMessage | WorkspaceDeleteMessage;

export interface CorpusContext {
  workspaceId: string;
  repositoryId: string;
  private: boolean;
  mode: Exclude<CorpusMode, 'off'>;
  consentVersion: string;
  retentionDays: number;
  includePrBody: boolean;
  includePaths: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_BODY_CHARACTERS = 16_000;

function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

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

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', asBuffer(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function redactCorpusText(value: string): string {
  return value
    .slice(0, MAX_BODY_CHARACTERS)
    .replace(/<!--\s*juror:[\s\S]*?-->/gi, '')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, '[redacted-secret]')
    .replace(/\b(?:authorization|api[-_ ]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .trim();
}

function authorKind(author: JsonObject): 'human' | 'bot' | 'juror' {
  const login = string(author.login).toLowerCase();
  if (login.includes('juror')) return 'juror';
  return string(author.type).toLowerCase() === 'bot' || login.endsWith('[bot]') ? 'bot' : 'human';
}

function eventSubject(eventName: string, payload: JsonObject, includePrBody: boolean): { kind: CorpusEventV1['subject']['kind']; value: JsonObject } | null {
  if (eventName === 'pull_request') return { kind: 'pull_request', value: object(payload.pull_request) };
  if (eventName === 'pull_request_review') return { kind: 'review', value: object(payload.review) };
  if (eventName === 'pull_request_review_comment') return { kind: 'review_comment', value: object(payload.comment) };
  if (eventName === 'issue_comment' && Object.keys(object(object(payload.issue).pull_request)).length) return { kind: 'conversation_comment', value: object(payload.comment) };
  if (eventName === 'pull_request_review_thread') return { kind: 'review_thread', value: object(payload.thread ?? payload.review_thread) };
  if (eventName === 'pull_request' && !includePrBody) return null;
  return null;
}

export async function buildCorpusEvent(deliveryId: string, eventName: string, payload: JsonObject, context: CorpusContext): Promise<CorpusEventV1 | null> {
  const subject = eventSubject(eventName, payload, context.includePrBody);
  if (!subject) return null;
  const pull = object(payload.pull_request);
  const issue = object(payload.issue);
  const base = object(pull.base);
  const head = object(pull.head);
  const user = object(subject.value.user);
  const action = string(payload.action) || 'unknown';
  const deleted = action === 'deleted';
  const rawBody = subject.kind === 'pull_request' ? string(subject.value.body) : string(subject.value.body);
  const body = deleted || (subject.kind === 'pull_request' && !context.includePrBody) ? null : redactCorpusText(rawBody) || null;
  const rawPath = string(subject.value.path);
  const pathHash = rawPath ? await sha256(`${context.workspaceId}:${rawPath}`) : null;
  const authorId = number(user.id);
  const occurredAt = string(subject.value.updated_at) || string(subject.value.submitted_at) || string(subject.value.created_at) || string(payload.timestamp) || new Date().toISOString();
  const subjectId = String(subject.value.id ?? `${eventName}:${object(payload.repository).id ?? 'repository'}:${pull.number ?? issue.number ?? 'pr'}`);
  const eventId = await sha256(`${deliveryId}:${eventName}:${action}:${subjectId}:${occurredAt}`);
  const record: CorpusEventV1 = {
    schemaVersion: 'corpus.event.v1',
    eventId,
    deliveryId,
    eventName,
    action,
    occurredAt,
    ingestedAt: new Date().toISOString(),
    workspaceId: context.workspaceId,
    repositoryId: context.repositoryId,
    repositoryVisibility: context.private ? 'private' : 'public',
    consent: { mode: context.mode, version: context.consentVersion, retentionDays: context.retentionDays },
    pullRequest: {
      number: number(pull.number) ?? number(issue.number) ?? 0,
      state: string(pull.state) || string(issue.state) || 'unknown',
      baseSha: string(base.sha) || null,
      headSha: string(head.sha) || null,
      merged: Boolean(pull.merged),
    },
    subject: {
      kind: subject.kind,
      id: subjectId,
      parentId: subject.value.in_reply_to_id === undefined ? null : String(subject.value.in_reply_to_id),
      body,
      path: context.includePaths && rawPath ? rawPath : null,
      pathHash,
      line: number(subject.value.line) ?? number(subject.value.original_line),
      state: string(subject.value.state) || (subject.kind === 'review_thread' ? action : null),
      deleted,
    },
    author: authorId === null ? null : { pseudonym: await sha256(`${context.workspaceId}:author:${authorId}`), kind: authorKind(user) },
    contentHash: await sha256(body ?? ''),
    redactionVersion: 'corpus-redaction.v1',
  };
  return record;
}

export async function maybeEnqueueCorpusEvent(env: Env, deliveryId: string, eventName: string, payload: JsonObject): Promise<boolean> {
  if (!['pull_request', 'pull_request_review', 'pull_request_review_comment', 'pull_request_review_thread', 'issue_comment'].includes(eventName)) return false;
  const repository = object(payload.repository);
  const repositoryId = number(repository.id);
  if (repositoryId === null) return false;
  const row = await env.DB.prepare(`SELECT repo.id AS repository_id, repo.workspace_id, repo.is_private, rs.training_enabled, cp.mode, cp.consent_version, cp.retention_days, cp.include_pr_body, cp.include_paths FROM repository repo JOIN repository_settings rs ON rs.repository_id = repo.id JOIN workspace_corpus_policy cp ON cp.workspace_id = repo.workspace_id WHERE repo.github_repository_id = ?`)
    .bind(repositoryId).first<{ repository_id: string; workspace_id: string; is_private: number; training_enabled: number; mode: CorpusMode; consent_version: string; retention_days: number; include_pr_body: number; include_paths: number }>();
  if (!row || !row.training_enabled || row.mode === 'off') return false;
  const event = await buildCorpusEvent(deliveryId, eventName, payload, {
    workspaceId: row.workspace_id,
    repositoryId: row.repository_id,
    private: Boolean(row.is_private),
    mode: row.mode,
    consentVersion: row.consent_version,
    retentionDays: row.retention_days,
    includePrBody: Boolean(row.include_pr_body),
    includePaths: Boolean(row.include_paths),
  });
  if (!event) return false;
  await env.CORPUS_QUEUE.send({ kind: 'corpus_event', event } satisfies CorpusQueueEventMessage, { contentType: 'json' });
  return true;
}

async function importMasterKey(env: Env): Promise<CryptoKey> {
  const value = env.CORPUS_MASTER_KEY_B64;
  if (!value) throw new Error('CORPUS_MASTER_KEY_B64 is not configured');
  const bytes = base64ToBytes(value);
  if (bytes.byteLength !== 32) throw new Error('CORPUS_MASTER_KEY_B64 must decode to exactly 32 bytes');
  return crypto.subtle.importKey('raw', asBuffer(bytes), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function wrapDataKey(master: CryptoKey, dataKey: Uint8Array, workspaceId: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: asBuffer(iv), additionalData: encoder.encode(workspaceId) }, master, asBuffer(dataKey));
  return JSON.stringify({ iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) });
}

async function unwrapDataKey(master: CryptoKey, wrapped: string, workspaceId: string): Promise<Uint8Array> {
  const parsed = JSON.parse(wrapped) as { iv: string; ciphertext: string };
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: asBuffer(base64ToBytes(parsed.iv)), additionalData: encoder.encode(workspaceId) }, master, asBuffer(base64ToBytes(parsed.ciphertext)));
  return new Uint8Array(plaintext);
}

async function workspaceDataKey(env: Env, workspaceId: string): Promise<{ version: number; key: Uint8Array }> {
  const master = await importMasterKey(env);
  const existing = await env.DB.prepare('SELECT key_version, wrapped_data_key FROM workspace_corpus_key WHERE workspace_id = ?').bind(workspaceId).first<{ key_version: number; wrapped_data_key: string }>();
  if (existing) return { version: existing.key_version, key: await unwrapDataKey(master, existing.wrapped_data_key, workspaceId) };
  const generated = crypto.getRandomValues(new Uint8Array(32));
  const wrapped = await wrapDataKey(master, generated, workspaceId);
  await env.DB.prepare('INSERT OR IGNORE INTO workspace_corpus_key (workspace_id, key_version, wrapped_data_key, created_at) VALUES (?, 1, ?, ?)').bind(workspaceId, wrapped, new Date().toISOString()).run();
  const winner = await env.DB.prepare('SELECT key_version, wrapped_data_key FROM workspace_corpus_key WHERE workspace_id = ?').bind(workspaceId).first<{ key_version: number; wrapped_data_key: string }>();
  if (!winner) throw new Error('Unable to create corpus data key');
  return { version: winner.key_version, key: await unwrapDataKey(master, winner.wrapped_data_key, workspaceId) };
}

async function gzip(value: string): Promise<Uint8Array> {
  const stream = new Blob([value]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(value: Uint8Array): Promise<string> {
  const stream = new Blob([asBuffer(value)]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

async function workspacePrefix(workspaceId: string): Promise<string> {
  return (await sha256(`juror-corpus:${workspaceId}`)).slice(0, 32);
}

async function encryptShard(env: Env, workspaceId: string, plaintext: string): Promise<{ ciphertext: ArrayBuffer; keyVersion: number; iv: string; sha256: string }> {
  const compressed = await gzip(plaintext);
  const data = await workspaceDataKey(env, workspaceId);
  const key = await crypto.subtle.importKey('raw', asBuffer(data.key), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: asBuffer(iv), additionalData: encoder.encode(workspaceId) }, key, asBuffer(compressed));
  return { ciphertext, keyVersion: data.version, iv: bytesToBase64(iv), sha256: await sha256(new Uint8Array(ciphertext)) };
}

async function decryptShard(env: Env, workspaceId: string, object: R2ObjectBody): Promise<string> {
  const keyVersion = Number(object.customMetadata?.keyVersion);
  const iv = object.customMetadata?.iv;
  if (!Number.isInteger(keyVersion) || !iv) throw new Error('Corpus object encryption metadata is invalid');
  const data = await workspaceDataKey(env, workspaceId);
  if (data.version !== keyVersion) throw new Error('Corpus key version is unavailable');
  const key = await crypto.subtle.importKey('raw', asBuffer(data.key), 'AES-GCM', false, ['decrypt']);
  const ciphertext = await object.arrayBuffer();
  const compressed = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: asBuffer(base64ToBytes(iv)), additionalData: encoder.encode(workspaceId) }, key, ciphertext);
  return gunzip(new Uint8Array(compressed));
}

export async function writeCorpusBatch(env: Env, events: CorpusEventV1[]): Promise<void> {
  const eligible: CorpusEventV1[] = [];
  for (const event of events) {
    const current = await env.DB.prepare(`SELECT cp.mode, cp.consent_version, rs.training_enabled FROM workspace_corpus_policy cp JOIN repository repo ON repo.workspace_id = cp.workspace_id JOIN repository_settings rs ON rs.repository_id = repo.id WHERE cp.workspace_id = ? AND repo.id = ?`)
      .bind(event.workspaceId, event.repositoryId).first<{ mode: CorpusMode; consent_version: string; training_enabled: number }>();
    if (current && current.mode !== 'off' && current.training_enabled && current.mode === event.consent.mode && current.consent_version === event.consent.version) eligible.push(event);
  }
  const byWorkspace = new Map<string, CorpusEventV1[]>();
  for (const event of eligible) byWorkspace.set(event.workspaceId, [...(byWorkspace.get(event.workspaceId) ?? []), event]);
  for (const [workspaceId, records] of byWorkspace) {
    records.sort((left, right) => left.eventId.localeCompare(right.eventId));
    const batchHash = await sha256(records.map((record) => record.eventId).join(':'));
    const timestamp = new Date(records[0]?.ingestedAt ?? Date.now());
    const prefix = await workspacePrefix(workspaceId);
    const key = `raw/v1/workspace=${prefix}/${timestamp.getUTCFullYear()}/${String(timestamp.getUTCMonth() + 1).padStart(2, '0')}/${String(timestamp.getUTCDate()).padStart(2, '0')}/${batchHash}.jsonl.gz.enc`;
    if (await env.CORPUS.head(key)) continue;
    const plaintext = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
    const encrypted = await encryptShard(env, workspaceId, plaintext);
    const object = await env.CORPUS.put(key, encrypted.ciphertext, {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { schema: 'corpus.event.v1', workspace: prefix, keyVersion: String(encrypted.keyVersion), iv: encrypted.iv, sha256: encrypted.sha256, encoding: 'gzip+aes-256-gcm' },
      sha256: encrypted.sha256,
    });
    if (!object) throw new Error('Corpus object write returned no metadata');
    await env.DB.prepare(`UPDATE workspace_corpus_policy SET stored_objects = stored_objects + 1, stored_bytes = stored_bytes + ?, last_ingested_at = ?, updated_at = ? WHERE workspace_id = ?`)
      .bind(object.size, new Date().toISOString(), new Date().toISOString(), workspaceId).run();
  }
}

export async function listAllKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    keys.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

export async function deleteWorkspaceCorpusObjects(env: Env, workspaceId: string): Promise<number> {
  const workspace = await workspacePrefix(workspaceId);
  const prefixes = [`raw/v1/workspace=${workspace}/`, `curated/v1/workspace=${workspace}/`, `snapshots/v1/workspace=${workspace}/`];
  const keys = (await Promise.all(prefixes.map((prefix) => listAllKeys(env.CORPUS, prefix)))).flat();
  for (let index = 0; index < keys.length; index += 1000) await env.CORPUS.delete(keys.slice(index, index + 1000));
  return keys.length;
}

export async function deleteWorkspaceCorpus(env: Env, workspaceId: string, jobId: string): Promise<void> {
  await env.DB.prepare(`UPDATE corpus_job SET status = 'running' WHERE id = ? AND workspace_id = ?`).bind(jobId, workspaceId).run();
  try {
    const deletedObjects = await deleteWorkspaceCorpusObjects(env, workspaceId);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM workspace_corpus_key WHERE workspace_id = ?').bind(workspaceId),
      env.DB.prepare(`UPDATE workspace_corpus_policy SET stored_objects = 0, stored_bytes = 0, last_ingested_at = NULL, updated_at = ? WHERE workspace_id = ?`).bind(new Date().toISOString(), workspaceId),
      env.DB.prepare(`UPDATE corpus_job SET status = 'succeeded', object_count = ?, completed_at = ? WHERE id = ?`).bind(deletedObjects, new Date().toISOString(), jobId),
    ]);
  } catch (error) {
    await env.DB.prepare(`UPDATE corpus_job SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`).bind(error instanceof Error ? error.message.slice(0, 500) : 'Unknown deletion error', new Date().toISOString(), jobId).run();
    throw error;
  }
}

export async function runCorpusRetention(env: Env): Promise<void> {
  const policies = await env.DB.prepare(`SELECT workspace_id, retention_days FROM workspace_corpus_policy WHERE stored_objects > 0`).all<{ workspace_id: string; retention_days: number }>();
  for (const policy of policies.results) {
    const prefix = `raw/v1/workspace=${await workspacePrefix(policy.workspace_id)}/`;
    const cutoff = Date.now() - policy.retention_days * 24 * 60 * 60 * 1000;
    let cursor: string | undefined;
    let deletedObjects = 0;
    let deletedBytes = 0;
    do {
      const page = await env.CORPUS.list({ prefix, cursor, limit: 1000 });
      const expired = page.objects.filter((object) => object.uploaded.getTime() <= cutoff);
      if (expired.length) {
        await env.CORPUS.delete(expired.map((object) => object.key));
        deletedObjects += expired.length;
        deletedBytes += expired.reduce((total, object) => total + object.size, 0);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    if (deletedObjects) await env.DB.prepare(`UPDATE workspace_corpus_policy SET stored_objects = MAX(0, stored_objects - ?), stored_bytes = MAX(0, stored_bytes - ?), updated_at = ? WHERE workspace_id = ?`)
      .bind(deletedObjects, deletedBytes, new Date().toISOString(), policy.workspace_id).run();
  }
}

export async function corpusExportResponse(env: Env, workspaceId: string): Promise<Response> {
  const prefix = `raw/v1/workspace=${await workspacePrefix(workspaceId)}/`;
  const keys = await listAllKeys(env.CORPUS, prefix);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const key of keys) {
          const object = await env.CORPUS.get(key);
          if (!object) continue;
          controller.enqueue(encoder.encode(await decryptShard(env, workspaceId, object)));
        }
        controller.close();
      } catch (error) { controller.error(error); }
    },
  });
  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'content-disposition': `attachment; filename="juror-corpus-${new Date().toISOString().slice(0, 10)}.jsonl"`, 'cache-control': 'private, no-store' } });
}
