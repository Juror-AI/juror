#!/usr/bin/env node

/** Fail-closed host boundary for the immutable, non-semantic QA evidence payload. */

import { createHash } from 'node:crypto';
import {
  constants as fsConstants,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';

import { isQaRunResult } from '../src/qa/result-validator.js';

const MAX_CONTROL_BYTES = 16 * 1024 * 1024;
const ROOT_EVIDENCE_KINDS = new Map([
  ['plan.json', 'plan'],
  ['agent-events.ndjson', 'ledger'],
  ['agent-result.json', 'ledger'],
]);
const ATTEMPT_EVIDENCE_KINDS = new Map([
  ['attempt.json', 'ledger'],
  ['console.json', 'console'],
  ['failed-requests.json', 'network'],
  ['operations.ndjson', 'ledger'],
  ['final.png', 'screenshot'],
  ['trace.zip', 'trace'],
]);

class StageEvidenceError extends Error {
  constructor(code) {
    super(code);
    this.name = 'StageEvidenceError';
    this.code = code;
  }
}

function fail(code) {
  throw new StageEvidenceError(code);
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function artifactKind(relative) {
  const rootKind = ROOT_EVIDENCE_KINDS.get(relative);
  if (rootKind) return rootKind;
  const match = relative.match(
    /^scenarios\/[a-z0-9_-]+\/attempt-[12]\/([A-Za-z0-9][A-Za-z0-9.@_-]*)$/,
  );
  if (!match) return null;
  const name = match[1];
  return ATTEMPT_EVIDENCE_KINDS.get(name) ?? (name.endsWith('.webm') ? 'video' : null);
}

function canonicalEvidencePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.includes('\0')) {
    return false;
  }
  if (path.posix.isAbsolute(value) || path.posix.normalize(value) !== value) return false;
  return value.split('/').every((component) => component !== '' && component !== '.' && component !== '..');
}

function decodeCanaries(encoded) {
  if (!encoded?.trim()) return [];
  let parsed;
  try {
    const raw = Buffer.from(encoded.trim(), 'base64');
    if (raw.length > 128 * 1024) fail('invalid_secret_bundle');
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    fail('invalid_secret_bundle');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('invalid_secret_bundle');
  const values = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.length < 8) {
      fail('invalid_secret_bundle');
    }
    values.push(Buffer.from(value));
  }
  return values;
}

function containsCanary(body, canaries) {
  return canaries.some((canary) => canary.length > 0 && body.includes(canary));
}

function hasDuplicateJsonKeys(source) {
  let index = 0;

  function whitespace() {
    while (/\s/.test(source[index] ?? '')) index += 1;
  }

  function string() {
    const start = index;
    index += 1;
    while (index < source.length) {
      if (source[index] === '\\') {
        index += 2;
      } else if (source[index] === '"') {
        index += 1;
        return JSON.parse(source.slice(start, index));
      } else {
        index += 1;
      }
    }
    return '';
  }

  function value() {
    whitespace();
    if (source[index] === '{') return object();
    if (source[index] === '[') return array();
    if (source[index] === '"') {
      string();
      return false;
    }
    while (index < source.length && !/[\s,\]}]/.test(source[index])) index += 1;
    return false;
  }

  function object() {
    index += 1;
    whitespace();
    if (source[index] === '}') {
      index += 1;
      return false;
    }
    const keys = new Set();
    while (index < source.length) {
      whitespace();
      const key = string();
      const duplicate = keys.has(key);
      keys.add(key);
      whitespace();
      index += 1; // JSON.parse has already established that this is a colon.
      const nestedDuplicate = value();
      if (duplicate || nestedDuplicate) return true;
      whitespace();
      if (source[index] === '}') {
        index += 1;
        return false;
      }
      index += 1; // JSON.parse has already established that this is a comma.
    }
    return false;
  }

  function array() {
    index += 1;
    whitespace();
    if (source[index] === ']') {
      index += 1;
      return false;
    }
    while (index < source.length) {
      if (value()) return true;
      whitespace();
      if (source[index] === ']') {
        index += 1;
        return false;
      }
      index += 1; // JSON.parse has already established that this is a comma.
    }
    return false;
  }

  return value();
}

function parseStrictJson(body, errorCode) {
  let source;
  let parsed;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(body);
    parsed = JSON.parse(source);
  } catch {
    fail(errorCode);
  }
  if (hasDuplicateJsonKeys(source)) fail(errorCode);
  return parsed;
}

async function readControlFile(file, canaries) {
  const before = await lstat(file).catch(() => null);
  if (!before?.isFile() || before.isSymbolicLink() || before.size > MAX_CONTROL_BYTES) {
    fail('invalid_control_file');
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(file, fsConstants.O_RDONLY | noFollow).catch(() => null);
  if (!handle) fail('invalid_control_file');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      fail('invalid_control_file');
    }
    const body = await handle.readFile();
    if (body.length !== opened.size || containsCanary(body, canaries)) fail('invalid_control_file');
    const after = await handle.stat();
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      fail('control_file_changed_during_staging');
    }
    return body;
  } finally {
    await handle.close();
  }
}

async function inspectArtifactPath(requiredRoot, file) {
  const lexical = path.resolve(file);
  if (lexical === requiredRoot || !inside(requiredRoot, lexical)) fail('invalid_artifact_file');
  const components = path.relative(requiredRoot, lexical).split(path.sep);
  let cursor = requiredRoot;
  let finalStat = null;
  for (const [position, component] of components.entries()) {
    cursor = path.join(cursor, component);
    const stat = await lstat(cursor).catch(() => null);
    const final = position === components.length - 1;
    if (
      !stat ||
      stat.isSymbolicLink() ||
      (final ? !stat.isFile() : !stat.isDirectory())
    ) {
      fail('invalid_artifact_file');
    }
    finalStat = stat;
  }
  const resolved = await realpath(lexical).catch(() => null);
  if (resolved !== lexical) fail('invalid_artifact_file');
  return { lexical, stat: finalStat };
}

async function verifyArtifactFile(file, expectedSha256, canaries, requiredRoot) {
  const inspected = await inspectArtifactPath(requiredRoot, file);
  const before = inspected.stat;
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(inspected.lexical, fsConstants.O_RDONLY | noFollow).catch(() => null);
  if (!handle) fail('invalid_artifact_file');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      fail('invalid_artifact_file');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const longestCanary = canaries.reduce((longest, canary) => Math.max(longest, canary.length), 0);
    let carry = Buffer.alloc(0);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      const searchable = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
      if (containsCanary(searchable, canaries)) fail('artifact_contains_canary');
      const retained = Math.min(Math.max(0, longestCanary - 1), searchable.length);
      carry = retained > 0 ? Buffer.from(searchable.subarray(searchable.length - retained)) : Buffer.alloc(0);
      position += bytesRead;
    }
    const after = await handle.stat();
    if (position !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      fail('artifact_changed_during_staging');
    }
    if (hash.digest('hex') !== expectedSha256) fail('artifact_hash_mismatch');
  } finally {
    await handle.close();
  }
}

function validateMarker(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 3 &&
    keys.every((key) => ['schema_version', 'report_present', 'runtime_status'].includes(key)) &&
    value.schema_version === 1 &&
    value.report_present === true &&
    Number.isSafeInteger(value.runtime_status) &&
    value.runtime_status >= 0 &&
    value.runtime_status <= 255;
}

function validateLedger(report) {
  const ids = new Set();
  const paths = new Set();
  for (const artifact of report.artifacts) {
    if (
      ids.has(artifact.id) ||
      paths.has(artifact.path) ||
      artifact.sanitized !== true ||
      artifact.upload !== null ||
      !canonicalEvidencePath(artifact.path) ||
      artifactKind(artifact.path) !== artifact.kind
    ) {
      fail('invalid_artifact_ledger');
    }
    ids.add(artifact.id);
    paths.add(artifact.path);
    if (!/^[0-9a-f]{64}$/.test(artifact.sha256)) fail('invalid_artifact_ledger');
  }
  for (const attempt of report.attempts) {
    if (attempt.evidence_artifact_ids.some((id) => !ids.has(id))) fail('invalid_artifact_ledger');
  }
  return [...report.artifacts].sort((left, right) => left.path.localeCompare(right.path));
}

export async function stageEvidencePayload(evidenceDirectory, stagingDirectory, options = {}) {
  const evidence = path.resolve(evidenceDirectory);
  const staging = path.resolve(stagingDirectory);
  if (evidence === path.parse(evidence).root || staging === path.parse(staging).root) {
    fail('unsafe_staging_path');
  }
  const evidenceStat = await lstat(evidence).catch(() => null);
  if (!evidenceStat?.isDirectory() || evidenceStat.isSymbolicLink()) fail('invalid_evidence_directory');
  const evidenceRoot = await realpath(evidence);
  await mkdir(path.dirname(staging), { recursive: true, mode: 0o700 });
  const stagingParent = await realpath(path.dirname(staging));
  const physicalStaging = path.join(stagingParent, path.basename(staging));
  if (inside(evidenceRoot, physicalStaging) || inside(physicalStaging, evidenceRoot)) {
    fail('unsafe_staging_path');
  }

  // This exact Action-owned path must never retain files from a failed or previous attempt.
  await rm(staging, { recursive: true, force: true });
  const canaries = decodeCanaries(options.secretsB64 ?? process.env.JUROR_QA_SECRETS_B64);
  let temporary = null;
  try {
    const markerBody = await readControlFile(path.join(evidenceRoot, 'payload-status.json'), canaries);
    const marker = parseStrictJson(markerBody, 'invalid_payload_marker');
    if (!validateMarker(marker)) fail('incomplete_payload_marker');

    const reportBody = await readControlFile(path.join(evidenceRoot, 'report.json'), canaries);
    const report = parseStrictJson(reportBody, 'invalid_report');
    if (!isQaRunResult(report)) fail('invalid_report');
    const artifacts = validateLedger(report);
    for (const artifact of artifacts) {
      await verifyArtifactFile(
        path.join(evidenceRoot, ...artifact.path.split('/')),
        artifact.sha256,
        canaries,
        evidenceRoot,
      );
    }

    temporary = await mkdtemp(path.join(stagingParent, `.${path.basename(staging)}.tmp-`));
    for (const artifact of artifacts) {
      const source = path.join(evidenceRoot, ...artifact.path.split('/'));
      const destination = path.join(temporary, ...artifact.path.split('/'));
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
      await verifyArtifactFile(destination, artifact.sha256, canaries, temporary);
    }
    await rename(temporary, staging);
    temporary = null;
    return { directory: staging, files: artifacts.map((artifact) => artifact.path) };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (error instanceof StageEvidenceError) throw error;
    fail('evidence_staging_failed');
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  if (process.argv.length !== 4) fail('usage');
  await stageEvidencePayload(process.argv[2], process.argv[3]);
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  main().catch((error) => {
    const code = error instanceof StageEvidenceError ? error.code : 'evidence_staging_failed';
    process.stderr.write(`::error::QA evidence payload staging failed (${code})\n`);
    process.exitCode = 1;
  });
}
