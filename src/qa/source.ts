/** Bounded, read-only source inspection for the isolated QA planning agent. */

import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { redact } from '../util/log.js';

const MAX_SOURCE_CALLS = 20;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_READ_CHARS = 100_000;
const MAX_SEARCH_FILES = 20_000;
const MAX_SEARCH_BYTES = 50 * 1024 * 1024;
const MAX_MATCH_TEXT = 500;
const FORBIDDEN_DIRECTORIES = new Set(['.git', '.hg', '.svn']);
const SKIPPED_DIRECTORIES = new Set([
  ...FORBIDDEN_DIRECTORIES,
  'coverage',
  'dist',
  'node_modules',
  'vendor',
]);
const INSPECTABLE_EXTENSIONS = new Set([
  '.astro',
  '.c',
  '.cc',
  '.cjs',
  '.cpp',
  '.cs',
  '.css',
  '.dart',
  '.elm',
  '.ex',
  '.exs',
  '.fs',
  '.fsx',
  '.go',
  '.gql',
  '.graphql',
  '.h',
  '.hbs',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.jsx',
  '.kt',
  '.kts',
  '.less',
  '.lua',
  '.md',
  '.mdx',
  '.mjs',
  '.php',
  '.proto',
  '.py',
  '.rb',
  '.rs',
  '.sass',
  '.scala',
  '.scss',
  '.svelte',
  '.swift',
  '.ts',
  '.tsx',
  '.vue',
]);
const SENSITIVE_FILENAMES = [
  /^\./,
  /(?:^|[._-])credentials?(?:[._-]|$)/i,
  /(?:^|[._-])secrets?(?:[._-]|$)/i,
  /(?:^|[._-])passw(?:or)?d(?:[._-]|$)/i,
  /(?:^|[._-])private[._-]?keys?(?:[._-]|$)/i,
  /(?:^|[._-])service[._-]?accounts?(?:[._-]|$)/i,
  /^auth\.json$/i,
  /^id_(?:dsa|ecdsa|ed25519|rsa)(?:\.pub)?$/i,
];
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const AUTH_SCHEME_VALUE = /\b(Bearer|Basic)[ \t]+[A-Za-z0-9._~+/-]{8,}={0,2}/gi;
const CREDENTIALED_URL = /\b(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi;
const SENSITIVE_ASSIGNMENT = new RegExp(
  '((?:["\'`])?\\b(?:' + [
    'api[_-]?key',
    'access[_-]?(?:key(?:[_-]?id)?|token)',
    'authorization',
    'client[_-]?(?:id|secret)',
    'connection[_-]?string',
    'cookie',
    'credentials?',
    'database[_-]?url',
    'dsn',
    'encryption[_-]?key',
    'passw(?:or)?d',
    'private[_-]?key',
    'refresh[_-]?token',
    'secrets?',
    'session(?:[_-]?(?:id|key|secret|token))?',
    'tokens?',
  ].join('|') + ')\\b(?:["\'`])?\\s*[:=]\\s*)' +
  '(?:"(?:\\\\.|[^"\\\\\\r\\n])*"|\'(?:\\\\.|[^\'\\\\\\r\\n])*\'|`(?:\\\\.|[^`\\\\\\r\\n])*`|[^\\s,;#}\\]]+)',
  'gi',
);

export interface QaSourceReadResult {
  path: string;
  start_line: number;
  end_line: number;
  total_lines: number;
  content: string;
  truncated: boolean;
}

export interface QaSourceSearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface QaSourceSearchResult {
  matches: QaSourceSearchMatch[];
  files_scanned: number;
  bytes_scanned: number;
  truncated: boolean;
}

function sourcePathParts(value: string, allowRoot = false): string[] {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || value.includes('\\')
    || /[\0\r\n]/.test(value)
    || path.posix.isAbsolute(value)
  ) {
    throw new Error('Source path must be a clean repository-relative POSIX path');
  }
  if (allowRoot && (value === '' || value === '.')) return [];
  const parts = value.split('/');
  if (parts.length === 0 || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Source path must not contain empty, current, or parent segments');
  }
  return parts;
}

async function safeSourceEntry(
  root: string,
  relativePath: string,
  kind: 'file' | 'directory',
): Promise<{ absolute: string; relative: string }> {
  const rootPath = await realpath(root);
  const parts = sourcePathParts(relativePath, kind === 'directory');
  if (parts.some((part) => FORBIDDEN_DIRECTORIES.has(part))) {
    throw new Error('Source inspection does not expose version-control metadata');
  }
  let current = rootPath;
  for (const part of parts) {
    current = path.join(current, part);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw new Error('Source inspection does not follow symbolic links');
  }
  const metadata = await lstat(current);
  if (kind === 'file' ? !metadata.isFile() : !metadata.isDirectory()) {
    throw new Error(`Source path is not a regular ${kind}`);
  }
  const relative = path.relative(rootPath, current).split(path.sep).join('/');
  if (relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error('Source path resolved outside the checkout');
  }
  return { absolute: current, relative: relative || '.' };
}

function sourceText(buffer: Buffer): string | null {
  if (buffer.includes(0)) return null;
  return redact(buffer.toString('utf8'))
    .replace(PRIVATE_KEY_BLOCK, '[redacted private key]')
    .replace(JWT, '[redacted jwt]')
    .replace(AUTH_SCHEME_VALUE, (_match, scheme: string) => `${scheme} [redacted]`)
    .replace(CREDENTIALED_URL, '$1[redacted]@')
    .replace(SENSITIVE_ASSIGNMENT, '$1"[redacted]"');
}

function inspectableFile(relativePath: string): boolean {
  const basename = path.posix.basename(relativePath);
  return INSPECTABLE_EXTENSIONS.has(path.posix.extname(basename).toLocaleLowerCase('en-US'))
    && !relativePath.split('/').some((part) =>
      SENSITIVE_FILENAMES.some((pattern) => pattern.test(part)));
}

export class QaSourceInspector {
  readonly #root: string;
  #calls = 0;

  constructor(root: string) {
    this.#root = root;
  }

  #admit(): void {
    this.#calls++;
    if (this.#calls > MAX_SOURCE_CALLS) {
      throw new Error(`QA source inspection is limited to ${MAX_SOURCE_CALLS} calls`);
    }
  }

  async read(relativePath: string, startLine = 1, maxLines = 200): Promise<QaSourceReadResult> {
    this.#admit();
    if (!Number.isInteger(startLine) || startLine < 1 || startLine > 1_000_000) {
      throw new Error('Source read start_line must be an integer from 1 through 1000000');
    }
    if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > 400) {
      throw new Error('Source read max_lines must be an integer from 1 through 400');
    }
    const entry = await safeSourceEntry(this.#root, relativePath, 'file');
    if (!inspectableFile(entry.relative)) {
      throw new Error('Source inspection accepts allowlisted source and documentation files only');
    }
    const metadata = await lstat(entry.absolute);
    if (metadata.size > MAX_FILE_BYTES) {
      throw new Error(`Source file exceeds the ${MAX_FILE_BYTES}-byte inspection limit`);
    }
    const text = sourceText(await readFile(entry.absolute));
    if (text === null) throw new Error('Source inspection accepts text files only');
    const lines = text.split(/\r?\n/);
    const requested = lines.slice(startLine - 1, startLine - 1 + maxLines);
    const delivered: string[] = [];
    let deliveredChars = 0;
    let characterTruncated = false;
    for (const line of requested) {
      const separatorLength = delivered.length === 0 ? 0 : 1;
      const remaining = MAX_READ_CHARS - deliveredChars - separatorLength;
      if (remaining < line.length) {
        if (delivered.length === 0) delivered.push(line.slice(0, MAX_READ_CHARS));
        characterTruncated = true;
        break;
      }
      delivered.push(line);
      deliveredChars += separatorLength + line.length;
    }
    const content = delivered.join('\n');
    const requestedEndLine = Math.min(lines.length, startLine - 1 + maxLines);
    const endLine = delivered.length === 0 ? startLine - 1 : startLine - 1 + delivered.length;
    return {
      path: entry.relative,
      start_line: startLine,
      end_line: endLine,
      total_lines: lines.length,
      content,
      truncated: requestedEndLine < lines.length || characterTruncated,
    };
  }

  async search(
    query: string,
    relativeDirectory = '',
    caseSensitive = false,
    maxResults = 20,
  ): Promise<QaSourceSearchResult> {
    this.#admit();
    if (
      typeof query !== 'string'
      || query.length < 1
      || query.length > 200
      || /[\0\r\n]/.test(query)
    ) {
      throw new Error('Source search query must contain 1-200 characters on one line');
    }
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 50) {
      throw new Error('Source search max_results must be an integer from 1 through 50');
    }
    const start = await safeSourceEntry(this.#root, relativeDirectory, 'directory');
    const matches: QaSourceSearchMatch[] = [];
    let filesScanned = 0;
    let bytesScanned = 0;
    let limitsReached = false;
    let skippedOversizedFile = false;
    const needle = caseSensitive ? query : query.toLocaleLowerCase('en-US');

    const walk = async (absoluteDirectory: string, relativePrefix: string): Promise<void> => {
      if (limitsReached || matches.length >= maxResults) return;
      const entries = (await readdir(absoluteDirectory, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
      for (const entry of entries) {
        if (limitsReached || matches.length >= maxResults) return;
        if (entry.isSymbolicLink()) continue;
        const absolute = path.join(absoluteDirectory, entry.name);
        const relative = relativePrefix === '.' ? entry.name : `${relativePrefix}/${entry.name}`;
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(absolute, relative);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!inspectableFile(relative)) continue;
        if (filesScanned >= MAX_SEARCH_FILES || bytesScanned >= MAX_SEARCH_BYTES) {
          limitsReached = true;
          return;
        }
        const metadata = await lstat(absolute);
        if (metadata.size > MAX_FILE_BYTES) {
          skippedOversizedFile = true;
          continue;
        }
        if (bytesScanned + metadata.size > MAX_SEARCH_BYTES) {
          limitsReached = true;
          continue;
        }
        filesScanned++;
        bytesScanned += metadata.size;
        const text = sourceText(await readFile(absolute));
        if (text === null) continue;
        for (const [index, line] of text.split(/\r?\n/).entries()) {
          const candidate = caseSensitive ? line : line.toLocaleLowerCase('en-US');
          if (!candidate.includes(needle)) continue;
          matches.push({ path: relative, line: index + 1, text: line.slice(0, MAX_MATCH_TEXT) });
          if (matches.length >= maxResults) return;
        }
      }
    };

    await walk(start.absolute, start.relative);
    return {
      matches,
      files_scanned: filesScanned,
      bytes_scanned: bytesScanned,
      truncated: limitsReached || skippedOversizedFile || matches.length >= maxResults,
    };
  }
}
