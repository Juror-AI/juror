import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubApiError } from '../src/github/client.js';
import type { GitHubApi, IssueComment } from '../src/github/client.js';
import type { Cluster, DiffContext, JurorConfig, ReviewResult } from '../src/types.js';

const MARKER = '<!-- juror:summary:v1 -->';

// The renderer and the inline selector are other modules' contracts; this file is about the
// GitHub calls, so both are stubbed and driven from `state`.
const state = vi.hoisted(() => ({
  summary: '',
  comments: [] as { path: string; line: number; side: 'RIGHT'; body: string; cluster: unknown }[],
  overflow: [] as unknown[],
}));

vi.mock('../src/render/summary.js', () => ({
  STICKY_MARKER: '<!-- juror:summary:v1 -->',
  renderSummaryComment: () => state.summary,
  mdCell: (value: string) => value,
  mdText: (value: string) => value.trim(),
}));

vi.mock('../src/render/inline.js', () => ({
  selectInlineComments: () => ({ comments: state.comments, overflow: state.overflow }),
}));

const { publishFailureComment, publishReview, publishWorkingComment } =
  await import('../src/github/publish.js');

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeDiff(): DiffContext {
  return {
    patch: '',
    files: [
      {
        path: 'src/a.ts',
        previousPath: null,
        status: 'modified',
        additions: 1,
        deletions: 0,
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 }],
        changedLines: [10],
        positionByLine: new Map([[10, 3]]),
        ignored: false,
      },
    ],
    baseSha: 'base0',
    headSha: 'head0',
    sinceSha: null,
    totalAdditions: 1,
    totalDeletions: 0,
    ignoredPaths: [],
    truncated: false,
  };
}

function makeResult(): ReviewResult {
  return {
    diff: makeDiff(),
    runs: [],
    clusters: [],
    published: [],
    suppressed: [],
    coverage: {
      complete: true,
      rawFindings: 0,
      accountedFor: 0,
      uniqueFindings: 0,
      dispositions: [],
      problems: [],
    },
    verdict: { base: 3, penalty: 0, score: 3, votes: [], confirmed: { P0: 0, P1: 0, P2: 0, P3: 0 } },
    summary: {
      summary: 'A review.',
      highlights: [],
      fileOverviews: [],
      sequenceDiagram: null,
      confidenceReason: '',
    },
    totals: {
      rows: [],
      usage: { uncachedIn: 0, cacheRead: 0, cacheWrite: 0, out: 0 },
      usd: 0,
      partial: false,
      modelsRun: 0,
    },
    durationMs: 1000,
    warnings: [],
  };
}

// Both consumers of the config are stubbed out above, so only the shape has to exist.
const config = { review: { max_inline_comments: 10, severity_floor: 'P3' } } as unknown as JurorConfig;

function inline(path: string, line: number) {
  return {
    path,
    line,
    side: 'RIGHT' as const,
    body: `finding in ${path}`,
    cluster: { path, line } as unknown as Cluster,
  };
}

interface Fake {
  client: GitHubApi;
  store: IssueComment[];
  listIssueComments: ReturnType<typeof vi.fn>;
  createIssueComment: ReturnType<typeof vi.fn>;
  updateIssueComment: ReturnType<typeof vi.fn>;
  createReview: ReturnType<typeof vi.fn>;
}

/** A hand-rolled GitHub with just enough memory to catch a duplicated sticky comment. */
function makeFake(createReviewImpl?: () => Promise<void>): Fake {
  const store: IssueComment[] = [];
  let nextId = 100;

  const listIssueComments = vi.fn(async () => store.map((c) => ({ ...c })));
  const createIssueComment = vi.fn(async (_n: number, body: string) => {
    const created = { id: nextId++, body, user: { login: 'juror[bot]' } };
    store.push(created);
    return { id: created.id };
  });
  const updateIssueComment = vi.fn(async (id: number, body: string) => {
    const found = store.find((c) => c.id === id);
    if (!found) throw new GitHubApiError(404, '/x', 'GitHub API 404: Not Found', null, '');
    found.body = body;
  });
  const createReview = vi.fn(createReviewImpl ?? (async () => {}));

  const client = {
    repo: 'juror-dev/juror',
    request: vi.fn(async () => {
      throw new Error('publish must not reach for a raw request');
    }),
    getPull: vi.fn(async () => {
      throw new Error('unused');
    }),
    getPullDiff: vi.fn(async () => {
      throw new Error('unused');
    }),
    listIssueComments,
    createIssueComment,
    updateIssueComment,
    createReview,
  } as unknown as GitHubApi;

  return { client, store, listIssueComments, createIssueComment, updateIssueComment, createReview };
}

function options(client: GitHubApi, dryRun = false) {
  return { client, prNumber: 7, headSha: 'head0', config, version: '0.1.0', rolling: null, dryRun };
}

function unprocessable(body: unknown): GitHubApiError {
  const raw = JSON.stringify(body);
  return new GitHubApiError(
    422,
    '/repos/juror-dev/juror/pulls/7/reviews',
    'GitHub API 422 on POST /repos/juror-dev/juror/pulls/7/reviews: Validation Failed',
    body,
    raw,
  );
}

beforeEach(() => {
  state.summary = `${MARKER}\n### Juror Review\n\nNothing alarming.`;
  state.comments = [];
  state.overflow = [];
});

// ─────────────────────────────────────────────────────────────────────────────

describe('live sticky status', () => {
  const statusOptions = (client: GitHubApi, dryRun = false) => ({
    client,
    prNumber: 7,
    headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    version: '0.1.0',
    modelLabels: ['DeepSeek V4 Flash', 'Sonnet 5'],
    jobUrl: 'https://github.com/juror-dev/juror/actions/runs/123',
    dryRun,
  });

  it('creates one animated working comment and replaces it with the final summary', async () => {
    const fake = makeFake();

    const workingId = await publishWorkingComment(statusOptions(fake.client));
    expect(workingId).toBe(100);
    expect(fake.store[0]?.body).toContain('Juror is reviewing');
    expect(fake.store[0]?.body).toContain('<img src="https://github.com/user-attachments/');
    expect(fake.store[0]?.body).toContain('DeepSeek V4 Flash');

    const final = await publishReview(makeResult(), options(fake.client));
    expect(final.summaryCommentId).toBe(100);
    expect(fake.createIssueComment).toHaveBeenCalledTimes(1);
    expect(fake.updateIssueComment).toHaveBeenCalledTimes(1);
    expect(fake.store.filter((comment) => comment.body.includes(MARKER))).toHaveLength(1);
    expect(fake.store[0]?.body).toContain('### Juror Review');
    expect(fake.store[0]?.body).not.toContain('Juror is reviewing');
  });

  it('replaces a working comment with a terminal failure state', async () => {
    const fake = makeFake();
    await publishWorkingComment(statusOptions(fake.client));

    const failedId = await publishFailureComment({
      ...statusOptions(fake.client),
      reason: 'reviewer process exited unexpectedly',
    });

    expect(failedId).toBe(100);
    expect(fake.store[0]?.body).toContain('### Juror review stopped');
    expect(fake.store[0]?.body).toContain('reviewer process exited unexpectedly');
    expect(fake.store[0]?.body).not.toContain('<img');
  });

  it('does not read or write comments in dry-run mode', async () => {
    const fake = makeFake();
    expect(await publishWorkingComment(statusOptions(fake.client, true))).toBeNull();
    expect(fake.listIssueComments).not.toHaveBeenCalled();
    expect(fake.createIssueComment).not.toHaveBeenCalled();
    expect(fake.updateIssueComment).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('publishReview — sticky summary', () => {
  it('creates the summary once and updates it on the next run', async () => {
    const fake = makeFake();
    fake.store.push({ id: 1, body: 'lgtm', user: { login: 'alice' } });

    const first = await publishReview(makeResult(), options(fake.client));
    expect(first.summaryCommentId).toBe(100);
    expect(fake.createIssueComment).toHaveBeenCalledTimes(1);
    expect(fake.updateIssueComment).not.toHaveBeenCalled();

    state.summary = `${MARKER}\n### Juror Review\n\nSecond pass.`;
    const second = await publishReview(makeResult(), options(fake.client));

    expect(second.summaryCommentId).toBe(100);
    expect(fake.createIssueComment).toHaveBeenCalledTimes(1);
    expect(fake.updateIssueComment).toHaveBeenCalledTimes(1);
    expect(fake.store.filter((c) => c.body.includes(MARKER))).toHaveLength(1);
    expect(fake.store.find((c) => c.id === 100)?.body).toContain('Second pass.');
  });

  it('re-adds the marker if the renderer ever drops it, so run two still upserts', async () => {
    const fake = makeFake();
    state.summary = '### Juror Review\n\nNo marker here.';

    await publishReview(makeResult(), options(fake.client));
    expect(fake.store[0]?.body.startsWith(MARKER)).toBe(true);

    await publishReview(makeResult(), options(fake.client));
    expect(fake.createIssueComment).toHaveBeenCalledTimes(1);
  });

  it('redacts secret-shaped text a model may have echoed into the summary', async () => {
    const fake = makeFake();
    // Prefix assembled so the repo never holds a key-shaped literal; see render.test.ts.
    const key = `sk-${'ant'}-api03-${'A1b2C3d4E5f6G7h8I9j0'.repeat(2)}`;
    state.summary = `${MARKER}\nfound a key: ${key}`;

    await publishReview(makeResult(), options(fake.client));

    const posted = String(fake.createIssueComment.mock.calls[0]?.[1]);
    expect(posted).not.toContain(key);
    expect(posted).toContain('[redacted]');
  });
});

describe('publishReview — batched inline review', () => {
  it('posts every comment in a single review', async () => {
    const fake = makeFake();
    state.comments = [inline('src/a.ts', 10), inline('src/a.ts', 11)];

    const out = await publishReview(makeResult(), options(fake.client));

    expect(fake.createReview).toHaveBeenCalledTimes(1);
    expect(fake.createReview.mock.calls[0]?.[1]).toMatchObject({
      commitId: 'head0',
      comments: [
        { path: 'src/a.ts', line: 10, side: 'RIGHT' },
        { path: 'src/a.ts', line: 11, side: 'RIGHT' },
      ],
    });
    expect(out.inlinePosted).toBe(2);
    expect(out.degradedToSummary).toBe(false);
  });

  it('drops the comment GitHub named and retries once', async () => {
    const rejection = unprocessable({
      message: 'Validation Failed',
      errors: [
        {
          resource: 'PullRequestReviewComment',
          field: 'line',
          message: 'src/b.ts: line must be part of the diff',
        },
      ],
    });
    let call = 0;
    const fake = makeFake(async () => {
      call += 1;
      if (call === 1) throw rejection;
    });
    state.comments = [inline('src/a.ts', 10), inline('src/b.ts', 99)];

    const out = await publishReview(makeResult(), options(fake.client));

    expect(fake.createReview).toHaveBeenCalledTimes(2);
    const retried = fake.createReview.mock.calls[1]?.[1] as { comments: { path: string }[] };
    expect(retried.comments).toHaveLength(1);
    expect(retried.comments[0]?.path).toBe('src/a.ts');
    expect(out.inlinePosted).toBe(1);
    expect(out.degradedToSummary).toBe(false);
    expect(out.warnings.join(' ')).toMatch(/dropped/);
  });

  it('retries exactly once and then falls back to summary-only', async () => {
    const rejection = unprocessable({
      message: 'Validation Failed',
      errors: ['src/b.ts: pull_request_review_thread.line must be part of the diff'],
    });
    const fake = makeFake(async () => {
      throw rejection;
    });
    state.comments = [inline('src/a.ts', 10), inline('src/b.ts', 99)];

    const out = await publishReview(makeResult(), options(fake.client));

    expect(fake.createReview).toHaveBeenCalledTimes(2);
    expect(out.inlinePosted).toBe(0);
    expect(out.degradedToSummary).toBe(true);
    // The point of the fallback: the summary still lands.
    expect(out.summaryCommentId).toBe(100);
    expect(fake.createIssueComment).toHaveBeenCalledTimes(1);
    expect(out.warnings.join(' ')).toMatch(/summary/i);
  });

  it('degrades without a second attempt when nothing can be dropped', async () => {
    const fake = makeFake(async () => {
      throw unprocessable({ message: 'Validation Failed', errors: [] });
    });
    // The comment sits on a line the position map knows about, so we have no basis for
    // guessing an offender — a blind identical retry would just burn a request.
    state.comments = [inline('src/a.ts', 10)];

    const out = await publishReview(makeResult(), options(fake.client));

    expect(fake.createReview).toHaveBeenCalledTimes(1);
    expect(out.degradedToSummary).toBe(true);
    expect(out.inlinePosted).toBe(0);
  });

  it('degrades instead of throwing when the review fails for a non-422 reason', async () => {
    const fake = makeFake(async () => {
      throw new GitHubApiError(403, '/x', 'GitHub API 403 on POST /x: Resource not accessible', null, '');
    });
    state.comments = [inline('src/a.ts', 10)];

    const out = await publishReview(makeResult(), options(fake.client));

    expect(fake.createReview).toHaveBeenCalledTimes(1);
    expect(out.degradedToSummary).toBe(true);
    expect(out.summaryCommentId).toBe(100);
  });
});

describe('publishReview — dry run', () => {
  it('performs no writes at all', async () => {
    const fake = makeFake();
    state.comments = [inline('src/a.ts', 10), inline('src/a.ts', 11)];

    const out = await publishReview(makeResult(), options(fake.client, true));

    expect(fake.createIssueComment).not.toHaveBeenCalled();
    expect(fake.updateIssueComment).not.toHaveBeenCalled();
    expect(fake.createReview).not.toHaveBeenCalled();
    expect(fake.listIssueComments).not.toHaveBeenCalled();
    expect(out).toMatchObject({
      summaryCommentId: null,
      inlinePosted: 2,
      degradedToSummary: false,
    });
  });

  it('still reports what could not be placed inline', async () => {
    const fake = makeFake();
    state.overflow = [{}, {}];

    const out = await publishReview(makeResult(), options(fake.client, true));

    expect(out.warnings.join(' ')).toMatch(/2 finding/);
  });
});
