import type {
  FindingDetailResponse,
  FindingListItem,
  OverviewResponse,
  RepositoryItem,
  RepositoryRef,
  RunDetailResponse,
  RunListItem,
  UsageResponse,
  WorkspaceSummary,
} from '../../shared/api';

export const workspace: WorkspaceSummary = {
  id: 'ws_juror',
  name: 'Juror AI',
  slug: 'juror-ai',
  role: 'admin',
};

export const repositories: RepositoryRef[] = [
  { id: 'repo_1', owner: 'juror-ai', name: 'juror', fullName: 'juror-ai/juror', private: false },
  { id: 'repo_2', owner: 'juror-ai', name: 'console', fullName: 'juror-ai/console', private: true },
  { id: 'repo_3', owner: 'juror-ai', name: 'gateway', fullName: 'juror-ai/gateway', private: true },
];

export const runs: RunListItem[] = [
  {
    id: 'run_1072', identity: 'review:923441:284:8f4ac21', kind: 'review', status: 'running', phase: 'Verifying findings',
    repository: repositories[0]!, prNumber: 284, sha: '8f4ac21', findings: 3, costMicroUsd: 1842000, durationMs: 182000,
    startedAt: '2026-08-21T11:42:00.000Z', githubUrl: 'https://github.com/juror-ai/juror/pull/284',
  },
  {
    id: 'run_1071', identity: 'qa:923442:96:b13c9a1', kind: 'qa', status: 'blocked', phase: 'Session bootstrap failed',
    repository: repositories[1]!, prNumber: 96, sha: 'b13c9a1', findings: 0, costMicroUsd: 612000, durationMs: 94000,
    startedAt: '2026-08-21T10:16:00.000Z', githubUrl: 'https://github.com/juror-ai/console/pull/96',
  },
  {
    id: 'run_1070', identity: 'review:923442:95:20a29c0', kind: 'review', status: 'succeeded', phase: 'Completed',
    repository: repositories[1]!, prNumber: 95, sha: '20a29c0', findings: 1, costMicroUsd: 2214000, durationMs: 261000,
    startedAt: '2026-08-21T09:38:00.000Z', githubUrl: 'https://github.com/juror-ai/console/pull/95',
  },
  {
    id: 'run_1069', identity: 'qa:923441:281:718da60', kind: 'qa', status: 'warning', phase: 'Product issue',
    repository: repositories[0]!, prNumber: 281, sha: '718da60', findings: 1, costMicroUsd: 1438000, durationMs: 318000,
    startedAt: '2026-08-20T17:24:00.000Z', githubUrl: 'https://github.com/juror-ai/juror/pull/281',
  },
  {
    id: 'run_1068', identity: 'review:923443:41:ec771fd', kind: 'review', status: 'succeeded', phase: 'Completed',
    repository: repositories[2]!, prNumber: 41, sha: 'ec771fd', findings: 0, costMicroUsd: 968000, durationMs: 126000,
    startedAt: '2026-08-20T14:03:00.000Z', githubUrl: 'https://github.com/juror-ai/gateway/pull/41',
  },
];

export const findings: FindingListItem[] = [
  {
    id: 'finding_retry_charge', fingerprint: 'af20bd39c9a7', title: 'Retry path can create a duplicate charge', status: 'open', source: 'review', severity: 'P1',
    repository: repositories[1]!, prNumber: 95, pathOrCheckpoint: 'src/billing/capture.ts', line: 118,
    agreement: { agreeing: 2, total: 3 }, reproducible: null, assignee: { id: 'u_1', name: 'Jay' },
    firstSeenAt: '2026-08-21T09:42:00.000Z', lastSeenAt: '2026-08-21T09:42:00.000Z',
  },
  {
    id: 'finding_session_expiry', fingerprint: '4fb8a1d0d223', title: 'Expired session redirects to an empty screen', status: 'open', source: 'qa', severity: 'P1',
    repository: repositories[0]!, prNumber: 281, pathOrCheckpoint: 'auth-expiry / checkpoint-3', line: null,
    agreement: null, reproducible: true, assignee: null,
    firstSeenAt: '2026-08-20T17:28:00.000Z', lastSeenAt: '2026-08-20T17:32:00.000Z',
  },
  {
    id: 'finding_signature', fingerprint: 'dde904a186c2', title: 'Webhook signature uses a non-constant-time comparison', status: 'open', source: 'review', severity: 'P2',
    repository: repositories[2]!, prNumber: 39, pathOrCheckpoint: 'src/webhooks/verify.ts', line: 51,
    agreement: { agreeing: 3, total: 3 }, reproducible: null, assignee: { id: 'u_2', name: 'Mina' },
    firstSeenAt: '2026-08-19T13:12:00.000Z', lastSeenAt: '2026-08-19T13:12:00.000Z',
  },
  {
    id: 'finding_reset_hook', fingerprint: 'a774e13df522', title: 'QA reset hook returned 403', status: 'open', source: 'qa', severity: 'P2',
    repository: repositories[1]!, prNumber: 96, pathOrCheckpoint: 'setup / reset-hook', line: null,
    agreement: null, reproducible: false, assignee: null,
    firstSeenAt: '2026-08-21T10:18:00.000Z', lastSeenAt: '2026-08-21T10:18:00.000Z',
  },
  {
    id: 'finding_cache_key', fingerprint: '1e2688be2a60', title: 'Cache key omits the selected organization', status: 'resolved', source: 'review', severity: 'P2',
    repository: repositories[1]!, prNumber: 91, pathOrCheckpoint: 'src/cache/key.ts', line: 27,
    agreement: { agreeing: 2, total: 3 }, reproducible: null, assignee: { id: 'u_1', name: 'Jay' },
    firstSeenAt: '2026-08-16T08:14:00.000Z', lastSeenAt: '2026-08-18T16:40:00.000Z',
  },
];

export const overview: OverviewResponse = {
  metrics: { criticalOpen: 2, qaProductIssues: 1, currentSpendMicroUsd: 27420000 },
  attention: findings.filter((item) => item.status === 'open' && (item.severity === 'P0' || item.severity === 'P1')).concat(findings[3]!),
  attentionRuns: runs.filter((run) => run.status === 'failed' || run.status === 'blocked'),
  running: runs.filter((run) => run.status === 'running'),
  recent: runs,
};

export const findingDetails: Record<string, FindingDetailResponse> = {
  finding_retry_charge: {
    ...findings[0]!,
    body: 'The capture retry creates a new idempotency key after a timeout, so a successful first request can be charged again when the response is lost.',
    claim: {
      trigger: 'The payment provider commits the charge but the client request times out.',
      mechanism: 'The retry branch generates a fresh idempotency key instead of reusing the attempt key.',
      consequence: 'The customer can be charged twice for one invoice.',
      fix: 'Persist the attempt key before the first request and reuse it for every retry of that capture.',
    },
    expected: null, actual: null, attempts: [], targetUrl: null, targetRevision: null,
    verification: { status: 'Confirmed', reason: 'The key is allocated inside the retry loop on every attempt.', model: 'Claude Opus' },
    githubUrl: 'https://github.com/juror-ai/console/pull/95#discussion_r1',
    diff: {
      oldPath: 'src/billing/capture.ts', newPath: 'src/billing/capture.ts', oldStart: 114, newStart: 114,
      lines: [
        { kind: 'context', oldLine: 114, newLine: 114, content: 'for (let attempt = 0; attempt < maxAttempts; attempt++) {' },
        { kind: 'deletion', oldLine: 115, newLine: null, content: '  const key = invoice.captureKey;' },
        { kind: 'addition', oldLine: null, newLine: 115, content: '  const key = crypto.randomUUID();' },
        { kind: 'context', oldLine: 116, newLine: 116, content: '  try {' },
        { kind: 'addition', oldLine: null, newLine: 117, content: '    await stripe.paymentIntents.capture(intentId, {}, {' },
        { kind: 'addition', oldLine: null, newLine: 118, content: '      idempotencyKey: key,' },
        { kind: 'context', oldLine: 117, newLine: 119, content: '    });' },
      ],
    },
  },
  finding_session_expiry: {
    ...findings[1]!, body: 'The browser reaches a blank application shell after the session cookie expires.', claim: null,
    expected: 'Redirect to /login with a “Session expired” message.', actual: 'The shell renders without content and emits a 401 loop.',
    attempts: [
      { attempt: 1, status: 'failed', observed: 'Blank shell after 401 response.', screenshotUrl: '/qa-empty-state.svg' },
      { attempt: 2, status: 'failed', observed: 'Same 401 loop reproduced after reset.', screenshotUrl: '/qa-empty-state.svg' },
    ],
    targetUrl: 'https://staging.juror.dev/account',
    targetRevision: { expectedSha: '718da60f9c4d', observedSha: '718da60f9c4d', relation: 'exact', method: 'static-probe' },
    verification: null, githubUrl: 'https://github.com/juror-ai/juror/pull/281', diff: null,
  },
};

export const runDetails: Record<string, RunDetailResponse> = Object.fromEntries(runs.map((run) => [run.id, {
  ...run,
  events: [
    { sequence: 1, timestamp: run.startedAt, phase: 'Queued', status: 'succeeded', message: 'Capacity reserved and run accepted.', durationMs: 90 },
    { sequence: 2, timestamp: run.startedAt, phase: 'Preparing', status: 'succeeded', message: 'Isolated runtime started.', durationMs: 7200 },
    { sequence: 3, timestamp: run.startedAt, phase: run.kind === 'review' ? 'Reviewing' : 'Running QA', status: run.status === 'running' ? 'running' : 'succeeded', message: run.kind === 'review' ? 'Three independent reviewers completed.' : 'Two deterministic attempts completed.', durationMs: 121000 },
    { sequence: 4, timestamp: run.startedAt, phase: run.phase, status: run.status === 'failed' ? 'failed' : run.status === 'blocked' || run.status === 'warning' ? 'warning' : run.status === 'running' ? 'running' : 'succeeded', message: run.phase, durationMs: 41800 },
  ],
  warnings: run.status === 'blocked' ? ['Session bootstrap returned 403. No reusable credentials entered the sandbox.'] : [],
  receipt: [
    { label: 'Models', amountMicroUsd: Math.round(run.costMicroUsd * 0.68) },
    { label: 'Sandbox', amountMicroUsd: Math.round(run.costMicroUsd * 0.11) },
    { label: 'Evidence storage', amountMicroUsd: Math.round(run.costMicroUsd * 0.01) },
    { label: 'Juror service fee', amountMicroUsd: Math.round(run.costMicroUsd * 0.2) },
  ],
  terminal: [
    { timestamp: run.startedAt, level: 'info', message: `Starting ${run.kind} for ${run.repository.fullName}#${run.prNumber}` },
    { timestamp: run.startedAt, level: 'info', message: `Revision ${run.sha} verified` },
    { timestamp: run.startedAt, level: run.status === 'blocked' ? 'warn' : 'info', message: run.status === 'blocked' ? 'QA blocked by target configuration' : 'Sanitized report persisted' },
  ],
} as RunDetailResponse]));

export const repositoryItems: RepositoryItem[] = repositories.map((repository, index) => ({
  ...repository,
  defaultBranch: 'main', connectionStatus: index === 1 ? 'attention' : 'healthy', executionMode: 'cloud', actionDetected: index === 2,
  reviewEnabled: true, reviewPreset: 'fast', publishMode: 'all', severityFloor: 'P3',
  qaEnabled: index === 0, qaReady: index === 0, qaTarget: index === 0 ? 'https://staging.juror.dev' : null,
  allowedOrigins: index === 0 ? ['https://staging.juror.dev'] : [],
  hasSessionBootstrap: false, hasSecretHeaders: false, hasResetHook: false,
  evidencePolicy: { screenshot: 'failure', trace: 'failure', video: 'failure' },
  latestRun: runs.find((run) => run.repository.id === repository.id) ?? null,
}));

export const usage: UsageResponse = {
  role: 'admin',
  billingState: 'active',
  hasBillingCustomer: true,
  trialRemainingMicroUsd: 0, currentSpendMicroUsd: 27420000, reservedMicroUsd: 1842000, capMicroUsd: 100000000,
  projectedInvoiceMicroUsd: 38600000, warningAt80Percent: false,
  breakdown: [
    { kind: 'review', amountMicroUsd: 16430000, percentage: 60 },
    { kind: 'qa', amountMicroUsd: 5484000, percentage: 20 },
    { kind: 'sandbox', amountMicroUsd: 2742000, percentage: 10 },
    { kind: 'storage', amountMicroUsd: 548000, percentage: 2 },
    { kind: 'service_fee', amountMicroUsd: 2196000, percentage: 8 },
  ],
  invoices: [
    { id: 'in_2026_07', period: 'July 2026', amountMicroUsd: 31840000, status: 'paid', url: '#' },
    { id: 'in_2026_06', period: 'June 2026', amountMicroUsd: 24120000, status: 'paid', url: '#' },
  ],
};
