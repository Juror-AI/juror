/**
 * Unified-diff parsing, path globbing, and size clamping.
 *
 * `positionByLine` is the highest-stakes value in this codebase. GitHub keys an inline
 * review comment to a *position* in the file's patch, not to a line number, and an
 * off-by-one makes the API accept the review while silently dropping the comment.
 * The rule implemented here: position 1 is the line immediately AFTER the first `@@`
 * header of that file's patch, and every line after it counts — context, `+`, `-`,
 * `\ No newline`, and later `@@` headers alike.
 */

import type { DiffFile, DiffHunk } from '../types.js';

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// ─────────────────────────────────────────────────────────────────────────────
// Patch → DiffFile[]
// ─────────────────────────────────────────────────────────────────────────────

export function parseUnifiedPatch(patch: string): DiffFile[] {
  const out: DiffFile[] = [];
  for (const chunk of splitPatch(patch).chunks) {
    const file = parseFileChunk(chunk);
    if (file) out.push(file);
  }
  return out;
}

function parseFileChunk(lines: string[]): DiffFile | null {
  let headerOld: string | null = null;
  let headerNew: string | null = null;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let minusPath: string | null = null;
  let plusPath: string | null = null;
  let sawMinus = false;
  let sawPlus = false;
  let isNew = false;
  let isDeleted = false;

  const hunks: DiffHunk[] = [];
  const changedLines: number[] = [];
  const positionByLine = new Map<number, number>();
  let additions = 0;
  let deletions = 0;

  // A binary chunk carries no `@@` header, so it falls out of this loop with zero
  // hunks and zero changed lines — exactly what we want to report for it.
  const starts = new Set(hunkStartIndexes(lines));
  let position = 0;
  let started = false;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    if (starts.has(i)) {
      const m = HUNK_RE.exec(line);
      if (m) {
        const hunk: DiffHunk = {
          oldStart: toInt(m[1], 0),
          oldLines: toInt(m[2], 1),
          newStart: toInt(m[3], 0),
          newLines: toInt(m[4], 1),
        };
        hunks.push(hunk);
        newLine = hunk.newStart;
        oldRemaining = hunk.oldLines;
        newRemaining = hunk.newLines;
        // The first `@@` line is position 0 — counting starts on the line after it.
        if (started) position++;
        started = true;
        continue;
      }
    }

    if (!started) {
      // Everything before the first hunk is file metadata and has no position.
      if (line.startsWith('diff --git ')) {
        const paths = parseGitHeaderPaths(line.slice('diff --git '.length));
        headerOld = paths.old;
        headerNew = paths.new;
      } else if (line.startsWith('new file mode')) {
        isNew = true;
      } else if (line.startsWith('deleted file mode')) {
        isDeleted = true;
      } else if (line.startsWith('rename from ')) {
        renameFrom = stripSrcPrefix(unquotePath(trimEol(line.slice('rename from '.length))));
      } else if (line.startsWith('rename to ')) {
        renameTo = stripSrcPrefix(unquotePath(trimEol(line.slice('rename to '.length))));
      } else if (line.startsWith('--- ')) {
        sawMinus = true;
        minusPath = parseTradPath(line.slice(4));
      } else if (line.startsWith('+++ ')) {
        sawPlus = true;
        plusPath = parseTradPath(line.slice(4));
      }
      continue;
    }

    position++;

    if (oldRemaining <= 0 && newRemaining <= 0) continue; // trailing `\ No newline`, etc.

    const kind = line.charAt(0);
    if (kind === '+') {
      additions++;
      changedLines.push(newLine);
      positionByLine.set(newLine, position);
      newLine++;
      newRemaining--;
    } else if (kind === '-') {
      deletions++;
      oldRemaining--;
    } else if (kind === '\\') {
      // "\ No newline at end of file" belongs to the previous line; it consumes a
      // position but no line budget.
    } else {
      // Context. An empty string is a context line whose single leading space was
      // stripped somewhere in transit — treat it as one rather than desyncing.
      positionByLine.set(newLine, position);
      newLine++;
      oldRemaining--;
      newRemaining--;
    }
  }

  const status = resolveStatus({ isNew, isDeleted, renameFrom, headerOld, headerNew, sawMinus, sawPlus, minusPath, plusPath });
  const post = plusPath ?? renameTo ?? headerNew;
  const pre = minusPath ?? renameFrom ?? headerOld;
  const path = status === 'removed' ? (pre ?? post) : (post ?? pre);
  if (!path) return null;

  return {
    path,
    previousPath: status === 'renamed' ? (renameFrom ?? headerOld ?? minusPath) : null,
    status,
    additions,
    deletions,
    hunks,
    changedLines,
    positionByLine,
    ignored: false,
  };
}

function resolveStatus(o: {
  isNew: boolean;
  isDeleted: boolean;
  renameFrom: string | null;
  headerOld: string | null;
  headerNew: string | null;
  sawMinus: boolean;
  sawPlus: boolean;
  minusPath: string | null;
  plusPath: string | null;
}): DiffFile['status'] {
  if (o.isNew || (o.sawMinus && o.minusPath === null)) return 'added';
  if (o.isDeleted || (o.sawPlus && o.plusPath === null)) return 'removed';
  if (o.renameFrom) return 'renamed';
  if (o.headerOld && o.headerNew && o.headerOld !== o.headerNew) return 'renamed';
  return 'modified';
}

/**
 * Indexes of the lines that really start a hunk. Content can contain a line that looks
 * like `@@ -1 +1 @@` (patches of patches), so a header only counts once the previous
 * hunk has consumed its declared line budget. Shared with the truncator so both agree
 * on where a hunk begins.
 */
function hunkStartIndexes(lines: string[]): number[] {
  const out: number[] = [];
  let oldRemaining = 0;
  let newRemaining = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (oldRemaining > 0 || newRemaining > 0) {
      const kind = line.charAt(0);
      if (kind === '+') newRemaining--;
      else if (kind === '-') oldRemaining--;
      else if (kind === '\\') continue;
      else {
        oldRemaining--;
        newRemaining--;
      }
      continue;
    }
    const m = HUNK_RE.exec(line);
    if (!m) continue;
    out.push(i);
    oldRemaining = toInt(m[2], 1);
    newRemaining = toInt(m[4], 1);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chunking — one chunk per file, used by parse, filter, and truncate
// ─────────────────────────────────────────────────────────────────────────────

interface SplitPatch {
  /** Anything before the first file header (commit metadata from `format-patch`). */
  preamble: string[];
  chunks: string[][];
  trailingNewline: boolean;
}

function splitPatch(patch: string): SplitPatch {
  const trailingNewline = patch.endsWith('\n');
  const body = trailingNewline ? patch.slice(0, -1) : patch;
  const lines = body.length ? body.split('\n') : [];

  // Inside a git patch only `diff --git` can start at column 0 — every content line is
  // prefixed — so it is an unambiguous boundary. A plain `diff -u` patch has no such
  // header; there, a `--- ` immediately followed by `+++ ` is the file boundary.
  const gitStyle = lines.some((l) => l.startsWith('diff --git '));

  const preamble: string[] = [];
  const chunks: string[][] = [];
  let current: string[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const boundary = gitStyle
      ? line.startsWith('diff --git ')
      : line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
    if (boundary) {
      current = [line];
      chunks.push(current);
      continue;
    }
    if (current) current.push(line);
    else preamble.push(line);
  }

  return { preamble, chunks, trailingNewline };
}

// ─────────────────────────────────────────────────────────────────────────────
// paths_ignore filtering
// ─────────────────────────────────────────────────────────────────────────────

export function filterPatch(patch: string, pathsIgnore: string[]): { patch: string; ignored: string[] } {
  if (!pathsIgnore.length) return { patch, ignored: [] };

  const { preamble, chunks, trailingNewline } = splitPatch(patch);
  const kept: string[][] = [];
  const ignored: string[] = [];

  for (const chunk of chunks) {
    const file = parseFileChunk(chunk);
    // Match on the post-image path only: a file moved *out* of an ignored directory is
    // exactly the change a reviewer wants to see.
    if (file && pathsIgnore.some((p) => matchesGlob(file.path, p))) {
      ignored.push(file.path);
      continue;
    }
    kept.push(chunk);
  }

  if (!ignored.length) return { patch, ignored: [] };
  return { patch: joinChunks(preamble, kept, trailingNewline), ignored };
}

function joinChunks(preamble: string[], chunks: string[][], trailingNewline: boolean): string {
  const parts: string[] = [];
  if (preamble.length) parts.push(preamble.join('\n'));
  for (const chunk of chunks) parts.push(chunk.join('\n'));
  const out = parts.join('\n');
  return out && trailingNewline ? `${out}\n` : out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Size clamping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Trim whole files off the end until the patch fits. Cutting mid-hunk would hand the
 * models a patch whose `@@` counts lie, so the only sub-file cut we allow — for a
 * single file that busts the budget on its own — is at a hunk boundary.
 */
export function truncatePatch(patch: string, maxBytes: number): { patch: string; truncated: boolean } {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return { patch, truncated: false };
  if (Buffer.byteLength(patch, 'utf8') <= maxBytes) return { patch, truncated: false };

  const { preamble, chunks, trailingNewline } = splitPatch(patch);
  const kept: string[][] = [];
  let used = preamble.length ? Buffer.byteLength(preamble.join('\n'), 'utf8') + 1 : 0;
  let truncated = false;

  for (const chunk of chunks) {
    const cost = Buffer.byteLength(chunk.join('\n'), 'utf8') + 1; // +1 for the join newline
    if (used + cost > maxBytes) {
      truncated = true;
      break;
    }
    kept.push(chunk);
    used += cost;
  }

  const first = chunks[0];
  if (!kept.length && first) kept.push(truncateFileChunk(first, Math.max(0, maxBytes - used)));

  return { patch: joinChunks(preamble, kept, trailingNewline), truncated: truncated || kept.length < chunks.length };
}

function truncateFileChunk(lines: string[], maxBytes: number): string[] {
  const starts = hunkStartIndexes(lines);
  const firstStart = starts[0];
  if (firstStart === undefined) return lines;

  const out = lines.slice(0, firstStart);
  let used = Buffer.byteLength(out.join('\n'), 'utf8');

  for (let h = 0; h < starts.length; h++) {
    const from = starts[h] ?? 0;
    const to = starts[h + 1] ?? lines.length;
    const body = lines.slice(from, to);
    const cost = Buffer.byteLength(body.join('\n'), 'utf8') + 1;
    // Always keep the first hunk: an empty patch is worse than an oversized one.
    if (h > 0 && used + cost > maxBytes) break;
    out.push(...body);
    used += cost;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Globs
// ─────────────────────────────────────────────────────────────────────────────

const GLOB_CACHE = new Map<string, RegExp>();

/**
 * Glob match with `**` (crosses `/`), `*` (does not), `?`, and `[abc]` / `[!abc]`.
 *
 * A leading `!` inverts the result: `matchesGlob(p, '!src/**')` is true exactly when
 * `p` is NOT under `src/`. There is no gitignore-style re-include ordering here —
 * every pattern is evaluated independently — so a negated entry in `paths_ignore`
 * reads as "ignore everything except this".
 */
export function matchesGlob(path: string, pattern: string): boolean {
  if (pattern.startsWith('!')) return !matchesGlob(path, pattern.slice(1));
  try {
    return globRegExp(pattern).test(normalizeGlobPath(path));
  } catch {
    // A malformed character range such as `[z-a]` is operator input, not a reason to stop
    // the review. Treat it as a non-matching ignore rule; the file remains visible.
    return false;
  }
}

function normalizeGlobPath(path: string): string {
  let p = path.trim();
  while (p.startsWith('./')) p = p.slice(2);
  while (p.startsWith('/')) p = p.slice(1);
  return p;
}

function globRegExp(pattern: string): RegExp {
  const cached = GLOB_CACHE.get(pattern);
  if (cached) return cached;

  const p = normalizeGlobPath(pattern);
  let re = '';
  let i = 0;

  while (i < p.length) {
    const ch = p.charAt(i);

    if (ch === '*') {
      let j = i;
      while (p.charAt(j) === '*') j++;
      const doubled = j - i > 1;
      if (!doubled) {
        re += '[^/]*';
        i = j;
        continue;
      }
      const atSegmentStart = i === 0 || p.charAt(i - 1) === '/';
      if (atSegmentStart && p.charAt(j) === '/') {
        // `**/` spans zero or more whole segments, so `**/*.lock` also hits `a.lock`.
        re += '(?:[^/]*\\/)*';
        i = j + 1;
      } else {
        re += '.*';
        i = j;
      }
      continue;
    }

    if (ch === '?') {
      re += '[^/]';
      i++;
      continue;
    }

    if (ch === '[') {
      const close = classEnd(p, i);
      if (close === -1) {
        re += '\\[';
        i++;
        continue;
      }
      let body = p.slice(i + 1, close);
      let negated = false;
      if (body.startsWith('!') || body.startsWith('^')) {
        negated = true;
        body = body.slice(1);
      }
      re += `[${negated ? '^' : ''}${body.replace(/\\/g, '\\\\')}]`;
      i = close + 1;
      continue;
    }

    re += ch.replace(/[.+^${}()|[\]\\/]/g, '\\$&');
    i++;
  }

  const compiled = new RegExp(`^${re}$`);
  GLOB_CACHE.set(pattern, compiled);
  return compiled;
}

function classEnd(p: string, open: number): number {
  let i = open + 1;
  if (p.charAt(i) === '!' || p.charAt(i) === '^') i++;
  if (p.charAt(i) === ']') i++; // POSIX: a leading `]` is a literal
  for (; i < p.length; i++) if (p.charAt(i) === ']') return i;
  return -1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Header path decoding
// ─────────────────────────────────────────────────────────────────────────────

function parseGitHeaderPaths(rest: string): { old: string | null; new: string | null } {
  const line = trimEol(rest);

  if (line.startsWith('"')) {
    const end = quoteEnd(line, 0);
    if (end !== -1) {
      const left = line.slice(0, end + 1);
      const right = line.slice(end + 1).trim();
      return { old: decodeHeaderPath(left), new: decodeHeaderPath(right) };
    }
  }

  // Unquoted paths may contain spaces, so the split point is ambiguous. The common
  // case — both sides identical — is decided by the exact midpoint; otherwise take the
  // first plausible ` b/` boundary. `---`/`+++` overrides this whenever they exist.
  const mid = (line.length - 1) / 2;
  if (Number.isInteger(mid) && line.charAt(mid) === ' ') {
    const left = line.slice(0, mid);
    const right = line.slice(mid + 1);
    if (stripSrcPrefix(left) === stripSrcPrefix(right)) {
      return { old: decodeHeaderPath(left), new: decodeHeaderPath(right) };
    }
  }

  for (let i = 0; i < line.length; i++) {
    if (line.charAt(i) !== ' ') continue;
    const right = line.slice(i + 1);
    if (right.startsWith('b/') || right.startsWith('"b/')) {
      return { old: decodeHeaderPath(line.slice(0, i)), new: decodeHeaderPath(right) };
    }
  }
  return { old: null, new: null };
}

function decodeHeaderPath(raw: string): string | null {
  const p = stripSrcPrefix(unquotePath(raw.trim()));
  return p === '/dev/null' || p === '' ? null : p;
}

function parseTradPath(rest: string): string | null {
  // Non-git tools append a tab plus a timestamp after the path.
  const cut = trimEol(rest).split('\t')[0] ?? '';
  const p = stripSrcPrefix(unquotePath(cut));
  return p === '/dev/null' || p === '' ? null : p;
}

function stripSrcPrefix(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function quoteEnd(s: string, open: number): number {
  for (let i = open + 1; i < s.length; i++) {
    const ch = s.charAt(i);
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '"') return i;
  }
  return -1;
}

/**
 * Undo git's C-style path quoting. The escapes encode raw bytes (octal for anything
 * non-ASCII), so decode into a byte buffer and read it back as UTF-8.
 */
function unquotePath(s: string): string {
  if (!s.startsWith('"')) return s;
  const bytes: number[] = [];

  for (let i = 1; i < s.length; i++) {
    const ch = s.charAt(i);
    if (ch === '"') break;
    if (ch !== '\\') {
      for (const b of Buffer.from(ch, 'utf8')) bytes.push(b);
      continue;
    }
    const next = s.charAt(++i);
    const simple: Record<string, number> = { n: 10, t: 9, r: 13, f: 12, b: 8, v: 11, a: 7, '\\': 92, '"': 34 };
    const mapped = simple[next];
    if (mapped !== undefined) {
      bytes.push(mapped);
      continue;
    }
    if (next >= '0' && next <= '7') {
      let oct = next;
      while (oct.length < 3) {
        const d = s.charAt(i + 1);
        if (d < '0' || d > '7') break;
        oct += d;
        i++;
      }
      bytes.push(parseInt(oct, 8) & 0xff);
      continue;
    }
    for (const b of Buffer.from(next, 'utf8')) bytes.push(b);
  }

  return Buffer.from(bytes).toString('utf8');
}

function trimEol(s: string): string {
  return s.endsWith('\r') ? s.slice(0, -1) : s;
}

function toInt(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}
