/**
 * The privileged edge of the pipeline — the only module that holds `GITHUB_TOKEN`.
 *
 * §11: no model process ever reaches this code. Everything that arrives here from a model
 * is attacker-influenced text, so error paths quote the *response*, never the request, and
 * every message is passed through `redact()` before it can reach a log or a comment.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { log, redact } from '../util/log.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────

export interface PullMeta {
  number: number;
  title: string;
  body: string;
  baseSha: string;
  headSha: string;
  baseRef: string;
  headRef: string;
  draft: boolean;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  /** Number of commits GitHub associates with the PR before merge. */
  commitCount: number;
  htmlUrl: string;
  baseRepo: string;
  headRepo: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: { login: string };
}

export interface ReviewComment extends IssueComment {
  path: string;
  line: number | null;
}

export interface ReviewCommentInput {
  path: string;
  line: number;
  side: 'RIGHT';
  body: string;
}

export interface CreateReviewOptions {
  commitId: string;
  body: string;
  comments: ReviewCommentInput[];
}

export interface GitHubClientOptions {
  token: string;
  /** Defaults to `GITHUB_API_URL` (GHES sets it) then github.com. */
  apiBase?: string;
  /** `owner/name`. */
  repo: string;
  /** Juror's version, for the User-Agent. */
  version?: string;
  /** Optional transport for callers that need a different connection policy. */
  fetchImpl?: GitHubFetch;
  /** Cancel requests and retry backoff when the owning command is terminating. */
  signal?: AbortSignal;
}

export type GitHubFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * The surface `publishReview` depends on. Publishing is the one place where a wrong call
 * is publicly visible, so it is tested against a hand-rolled fake rather than the network;
 * `GitHubClient` satisfies this interface and is what production passes.
 */
export interface GitHubApi {
  readonly repo: string;
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
  getPull(n: number): Promise<PullMeta>;
  /** Authoritative diff retained by GitHub for a specific pull request. */
  getPullDiff(n: number): Promise<string>;
  /** Immutable three-dot comparison for one captured pull-request snapshot. */
  getCompareDiff(baseSha: string, headSha: string): Promise<string>;
  /** Ordered commit parents, first-parent first. */
  getCommitParents(sha: string): Promise<string[]>;
  /** Authoritative graph relationship from base to head. */
  getCommitRelationship(baseSha: string, headSha: string): Promise<CommitRelationship>;
  listIssueComments(n: number): Promise<IssueComment[]>;
  listReviewComments(n: number): Promise<ReviewComment[]>;
  createIssueComment(n: number, body: string): Promise<{ id: number }>;
  updateIssueComment(id: number, body: string): Promise<void>;
  createReview(n: number, o: CreateReviewOptions): Promise<void>;
}

export type CommitRelationship = 'ahead' | 'behind' | 'diverged' | 'identical';

/** Carries the status and parsed body so `publish.ts` can tell a 422 from a 403. */
export class GitHubApiError extends Error {
  readonly status: number;
  readonly path: string;
  /** Parsed error payload when the response carried JSON, else `null`. */
  readonly body: unknown;
  /** Response text, redacted and length-capped. */
  readonly rawBody: string;

  constructor(status: number, path: string, message: string, body: unknown, rawBody: string) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.path = path;
    this.body = body;
    this.rawBody = rawBody;
  }
}

export function isGitHubApiError(e: unknown): e is GitHubApiError {
  return e instanceof GitHubApiError;
}

// ─────────────────────────────────────────────────────────────────────────────
// Retry policy
// ─────────────────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 500;
/** A bogus `Retry-After` must not park a CI job for an hour. */
const MAX_BACKOFF_MS = 30_000;
const MAX_ERROR_BODY_CHARS = 2_000;
/** Enough for any PR conversation we would realistically have to scan for the sticky. */
const MAX_COMMENT_PAGES = 10;
const PER_PAGE = 100;

function backoffMs(attempt: number): number {
  const base = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
  return base + Math.floor(Math.random() * 250);
}

/** `Retry-After` is either delta-seconds or an HTTP-date; GitHub sends both in practice. */
function parseRetryAfter(raw: string | null): number | null {
  if (!raw) return null;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds)) return Math.min(MAX_BACKOFF_MS, Math.max(0, seconds * 1000));
  const when = Date.parse(raw);
  if (!Number.isNaN(when)) return Math.min(MAX_BACKOFF_MS, Math.max(0, when - Date.now()));
  return null;
}

/**
 * How long to wait before retrying, or `null` when the failure is the caller's fault.
 *
 * A 403 is normally fatal (bad token, no permission) but GitHub also serves the secondary
 * rate limit as 403 with either a `Retry-After` or an exhausted `x-ratelimit-remaining`,
 * and that one *is* worth waiting out.
 */
function retryDelayMs(res: Response, text: string, attempt: number): number | null {
  const retryAfter = parseRetryAfter(res.headers.get('retry-after'));

  if (res.status === 429 || res.status >= 500) return retryAfter ?? backoffMs(attempt);

  if (res.status === 403) {
    const exhausted = res.headers.get('x-ratelimit-remaining') === '0';
    const secondary = /secondary rate limit|abuse detection/i.test(text);
    if (!exhausted && !secondary) return null;
    if (retryAfter !== null) return retryAfter;
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) {
      const wait = reset * 1000 - Date.now();
      return Math.min(MAX_BACKOFF_MS, Math.max(backoffMs(attempt), wait));
    }
    return backoffMs(attempt);
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Client
// ─────────────────────────────────────────────────────────────────────────────

export class GitHubClient implements GitHubApi {
  readonly repo: string;
  readonly apiBase: string;
  /** Never logged, never interpolated into an error, never handed to a child process. */
  readonly #token: string;
  readonly #userAgent: string;
  readonly #fetch: GitHubFetch;
  readonly #signal?: AbortSignal;

  constructor(o: GitHubClientOptions) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(o.repo)) {
      throw new Error(`Expected repo as "owner/name", got "${o.repo}"`);
    }
    const base = o.apiBase || process.env.GITHUB_API_URL || 'https://api.github.com';
    this.repo = o.repo;
    this.apiBase = base.replace(/\/+$/, '');
    this.#token = o.token;
    this.#userAgent = o.version ? `juror/${o.version}` : 'juror';
    this.#fetch = o.fetchImpl ?? fetch;
    this.#signal = o.signal;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { text } = await this.#send(method, path, body, 'application/vnd.github+json');
    // 204 No Content and empty 200s are normal for PATCH/DELETE — do not feed '' to JSON.parse.
    if (text.trim() === '') return undefined as unknown as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(
        redact(`GitHub returned a non-JSON body for ${method} ${path}: ${snippet(text)}`),
      );
    }
  }

  async getPull(n: number): Promise<PullMeta> {
    const path = `/repos/${this.#repoPath()}/pulls/${n}`;
    return toPullMeta(await this.request<unknown>('GET', path), path);
  }

  async getPullDiff(n: number): Promise<string> {
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`Invalid pull request number ${n}`);
    const path = `/repos/${this.#repoPath()}/pulls/${n}`;
    const { text } = await this.#send('GET', path, undefined, 'application/vnd.github.v3.diff');
    return text;
  }

  async getCompareDiff(baseSha: string, headSha: string): Promise<string> {
    // Both sides are commit ids captured from `getPull()`. Unlike `/pulls/{n}`, this path
    // cannot start returning a newer diff if the author pushes while the request is in flight.
    const comparison = `${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}`;
    const path = `/repos/${this.#repoPath()}/compare/${comparison}`;
    const { text } = await this.#send(
      'GET',
      path,
      undefined,
      'application/vnd.github.v3.diff',
    );
    return text;
  }

  async getCommitParents(sha: string): Promise<string[]> {
    if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error('Commit SHA must be 40 hexadecimal characters');
    const path = `/repos/${this.#repoPath()}/commits/${encodeURIComponent(sha)}`;
    const payload = asRecord(await this.request<unknown>('GET', path));
    const parents = payload?.parents;
    if (!Array.isArray(parents)) throw new Error(`Unexpected commit payload from ${path}`);
    const shas = parents
      .map((parent) => asString(asRecord(parent)?.sha).toLowerCase())
      .filter((parent) => /^[0-9a-f]{40}$/.test(parent));
    if (shas.length !== parents.length) throw new Error(`Unexpected parent SHA in ${path}`);
    return shas;
  }

  async getCommitRelationship(baseSha: string, headSha: string): Promise<CommitRelationship> {
    if (!/^[0-9a-f]{40}$/i.test(baseSha) || !/^[0-9a-f]{40}$/i.test(headSha)) {
      throw new Error('Commit relationship requires two full 40-character SHAs');
    }
    const comparison = `${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}`;
    // We need only the graph status. GitHub includes up to 300 changed-file patches only on the
    // first paginated page, so ask for the second one and a single commit while retaining the
    // top-level relationship fields.
    const path = `/repos/${this.#repoPath()}/compare/${comparison}?per_page=1&page=2`;
    const payload = asRecord(await this.request<unknown>('GET', path));
    const status = asString(payload?.status);
    if (status !== 'ahead' && status !== 'behind' && status !== 'diverged' && status !== 'identical') {
      throw new Error(`Unexpected commit relationship from ${path}`);
    }
    return status;
  }

  async listIssueComments(n: number): Promise<IssueComment[]> {
    const out: IssueComment[] = [];
    // The sticky comment can be buried under a long conversation, so page rather than
    // trusting the first 30 results — missing it means posting a duplicate summary.
    for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
      const path = `/repos/${this.#repoPath()}/issues/${n}/comments?per_page=${PER_PAGE}&page=${page}`;
      const batch = await this.request<unknown>('GET', path);
      if (!Array.isArray(batch)) break;
      for (const item of batch) {
        const rec = asRecord(item);
        if (!rec) continue;
        const id = asNumber(rec.id, -1);
        if (id < 0) continue;
        out.push({
          id,
          body: asString(rec.body),
          user: { login: asString(asRecord(rec.user)?.login) },
        });
      }
      if (batch.length < PER_PAGE) break;
    }
    return out;
  }

  async listReviewComments(n: number): Promise<ReviewComment[]> {
    const out: ReviewComment[] = [];
    for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
      const path = `/repos/${this.#repoPath()}/pulls/${n}/comments?per_page=${PER_PAGE}&page=${page}`;
      const batch = await this.request<unknown>('GET', path);
      if (!Array.isArray(batch)) break;
      for (const item of batch) {
        const rec = asRecord(item);
        if (!rec) continue;
        const id = asNumber(rec.id, -1);
        if (id < 0) continue;
        const rawLine = rec.line ?? rec.original_line;
        out.push({
          id,
          body: asString(rec.body),
          user: { login: asString(asRecord(rec.user)?.login) },
          path: asString(rec.path),
          line: typeof rawLine === 'number' && Number.isFinite(rawLine) ? rawLine : null,
        });
      }
      if (batch.length < PER_PAGE) break;
    }
    return out;
  }

  async createIssueComment(n: number, body: string): Promise<{ id: number }> {
    const path = `/repos/${this.#repoPath()}/issues/${n}/comments`;
    const res = await this.request<unknown>('POST', path, { body });
    return { id: asNumber(asRecord(res)?.id, -1) };
  }

  async updateIssueComment(id: number, body: string): Promise<void> {
    await this.request<unknown>('PATCH', `/repos/${this.#repoPath()}/issues/comments/${id}`, {
      body,
    });
  }

  async createReview(n: number, o: CreateReviewOptions): Promise<void> {
    // `event: 'COMMENT'` and one call: the PR author gets a single notification instead of
    // one per finding. 'REQUEST_CHANGES' would also block the merge queue, which is not
    // ours to do.
    await this.request<unknown>('POST', `/repos/${this.#repoPath()}/pulls/${n}/reviews`, {
      commit_id: o.commitId,
      event: 'COMMENT',
      ...(o.body ? { body: o.body } : {}),
      comments: o.comments.map((c) => ({
        path: c.path,
        line: c.line,
        side: c.side,
        body: c.body,
      })),
    });
  }

  /** Each segment is encoded separately so the `owner/name` slash survives. */
  #repoPath(): string {
    return this.repo.split('/').map(encodeURIComponent).join('/');
  }

  #headers(accept: string, hasBody: boolean): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.#token}`,
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': this.#userAgent,
    };
    if (hasBody) h['Content-Type'] = 'application/json';
    return h;
  }

  async #send(
    method: string,
    path: string,
    body: unknown,
    accept: string,
  ): Promise<{ res: Response; text: string }> {
    const url = path.startsWith('http') ? path : `${this.apiBase}${path.startsWith('/') ? '' : '/'}${path}`;
    const hasBody = body !== undefined;
    let lastNetworkError: unknown = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      this.#signal?.throwIfAborted();
      let res: Response;
      let text: string;
      try {
        res = await this.#fetch(url, {
          method,
          headers: this.#headers(accept, hasBody),
          body: hasBody ? JSON.stringify(body) : undefined,
          ...(this.#signal ? { signal: this.#signal } : {}),
        });
        text = await res.text();
      } catch (e) {
        this.#signal?.throwIfAborted();
        // DNS, TLS, socket reset: transient often enough to be worth the same budget.
        lastNetworkError = e;
        if (attempt === MAX_ATTEMPTS) break;
        await sleep(backoffMs(attempt), undefined, this.#signal ? { signal: this.#signal } : {});
        continue;
      }

      if (res.ok) return { res, text };

      const wait = retryDelayMs(res, text, attempt);
      if (wait === null || attempt === MAX_ATTEMPTS) throw apiError(res, text, method, path);
      log.debug(
        `github: ${res.status} on ${method} ${path}; retrying in ${Math.round(wait / 100) / 10}s (${attempt}/${MAX_ATTEMPTS})`,
      );
      await sleep(wait, undefined, this.#signal ? { signal: this.#signal } : {});
    }

    throw new Error(
      redact(
        `GitHub request failed after ${MAX_ATTEMPTS} attempts: ${method} ${path}: ${messageOf(lastNetworkError)}`,
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Error and payload narrowing
// ─────────────────────────────────────────────────────────────────────────────

function apiError(res: Response, text: string, method: string, path: string): GitHubApiError {
  let parsed: unknown = null;
  try {
    parsed = text.trim() === '' ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  const rec = asRecord(parsed);
  const detail = asString(rec?.message) || res.statusText || 'no message';
  const errors = summarizeErrors(rec?.errors);
  const message = redact(
    `GitHub API ${res.status} on ${method} ${path}: ${detail}${errors ? ` (${errors})` : ''}`,
  );
  return new GitHubApiError(res.status, path, message, parsed, redact(snippet(text)));
}

/** `errors` is a list of strings on some endpoints and of objects on others. */
function summarizeErrors(v: unknown): string {
  if (!Array.isArray(v)) return '';
  const parts: string[] = [];
  for (const e of v) {
    if (typeof e === 'string') {
      parts.push(e);
      continue;
    }
    const rec = asRecord(e);
    if (!rec) continue;
    const field = asString(rec.field);
    const msg = asString(rec.message) || asString(rec.code);
    parts.push([field, msg].filter(Boolean).join(': '));
  }
  return parts.filter(Boolean).slice(0, 5).join('; ');
}

function snippet(text: string): string {
  return text.length > MAX_ERROR_BODY_CHARS ? `${text.slice(0, MAX_ERROR_BODY_CHARS)}…` : text;
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : 'unknown error';
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asNumber(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function toPullMeta(v: unknown, path: string): PullMeta {
  const o = asRecord(v);
  const base = asRecord(o?.base);
  const head = asRecord(o?.head);
  if (!o || !base || !head) throw new Error(`Unexpected pull payload from ${path}`);
  const commitCount = asNumber(o.commits);
  return {
    number: asNumber(o.number),
    title: asString(o.title),
    body: asString(o.body),
    baseSha: asString(base.sha),
    headSha: asString(head.sha),
    baseRef: asString(base.ref),
    headRef: asString(head.ref),
    draft: o.draft === true,
    state: o.state === 'closed' ? 'closed' : 'open',
    merged: o.merged === true || typeof o.merged_at === 'string',
    mergedAt: typeof o.merged_at === 'string' ? o.merged_at : null,
    mergeCommitSha: typeof o.merge_commit_sha === 'string' && o.merge_commit_sha ? o.merge_commit_sha : null,
    commitCount: Number.isSafeInteger(commitCount) && commitCount > 0 ? commitCount : 0,
    htmlUrl: asString(o.html_url),
    baseRepo: asString(asRecord(base.repo)?.full_name),
    headRepo: asString(asRecord(head.repo)?.full_name),
  };
}
