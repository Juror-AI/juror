export type RunKind = 'review' | 'qa';
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'warning' | 'failed' | 'cancelled' | 'blocked';
export type FindingStatus = 'open' | 'resolved' | 'ignored';
export type FindingSource = 'review' | 'qa';
export type Severity = 'P0' | 'P1' | 'P2' | 'P3';

export interface RepositoryRef {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
}

export interface FindingListItem {
  id: string;
  fingerprint: string;
  title: string;
  status: FindingStatus;
  source: FindingSource;
  severity: Severity;
  repository: RepositoryRef;
  prNumber: number;
  pathOrCheckpoint: string;
  line: number | null;
  agreement: { agreeing: number; total: number } | null;
  reproducible: boolean | null;
  assignee: { id: string; name: string; avatarUrl?: string } | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface RunListItem {
  id: string;
  identity: string;
  kind: RunKind;
  status: RunStatus;
  phase: string;
  repository: RepositoryRef;
  prNumber: number;
  sha: string;
  findings: number;
  costMicroUsd: number;
  durationMs: number | null;
  startedAt: string;
  githubUrl: string;
}

export interface OverviewResponse {
  metrics: {
    criticalOpen: number;
    qaProductIssues: number;
    currentSpendMicroUsd: number;
  };
  attention: FindingListItem[];
  attentionRuns: RunListItem[];
  running: RunListItem[];
  recent: RunListItem[];
}

export interface FindingDetailResponse extends FindingListItem {
  body: string;
  claim: { trigger: string; mechanism: string; consequence: string; fix: string } | null;
  expected: string | null;
  actual: string | null;
  attempts: Array<{ attempt: 1 | 2; status: string; observed: string; screenshotUrl?: string }>;
  targetUrl: string | null;
  targetRevision: { expectedSha: string | null; observedSha: string | null; relation: string; method: string } | null;
  verification: { status: string; reason: string; model: string } | null;
  githubUrl: string;
  diff: {
    oldPath: string;
    newPath: string;
    oldStart: number;
    newStart: number;
    lines: Array<{ kind: 'context' | 'addition' | 'deletion'; oldLine: number | null; newLine: number | null; content: string }>;
  } | null;
}

export interface RunEventItem {
  sequence: number;
  timestamp: string;
  phase: string;
  status: 'pending' | 'running' | 'succeeded' | 'warning' | 'failed' | 'cancelled';
  message: string;
  durationMs?: number;
}

export interface RunDetailResponse extends RunListItem {
  events: RunEventItem[];
  warnings: string[];
  receipt: Array<{ label: string; amountMicroUsd: number }>;
  terminal: Array<{ timestamp: string; level: 'info' | 'warn' | 'error'; message: string }>;
}

export interface RepositoryItem extends RepositoryRef {
  defaultBranch: string;
  connectionStatus: 'healthy' | 'attention' | 'suspended';
  hostedAutomationBlocked: boolean;
  reviewEnabled: boolean;
  reviewPreset: 'starter' | 'fast' | 'balanced' | 'high' | 'ultra';
  publishMode: 'all' | 'consensus';
  severityFloor: Severity;
  qaEnabled: boolean;
  qaReady: boolean;
  qaTarget: string | null;
  allowedOrigins: string[];
  hasSessionBootstrap: boolean;
  hasSecretHeaders: boolean;
  hasResetHook: boolean;
  evidencePolicy: { screenshot: 'all' | 'failure' | 'off'; trace: 'all' | 'failure' | 'off'; video: 'all' | 'failure' | 'off' };
  latestRun: RunListItem | null;
}

export interface UsageResponse {
  role: 'admin' | 'member';
  billingState: 'trial' | 'active' | 'past_due' | 'paused';
  hasBillingCustomer: boolean;
  trialRemainingMicroUsd: number;
  currentSpendMicroUsd: number;
  reservedMicroUsd: number;
  capMicroUsd: number;
  projectedInvoiceMicroUsd: number;
  warningAt80Percent: boolean;
  breakdown: Array<{ kind: RunKind | 'sandbox' | 'storage' | 'service_fee'; amountMicroUsd: number; percentage: number }>;
  invoices: Array<{ id: string; period: string; amountMicroUsd: number; status: 'paid' | 'open' | 'void'; url: string | null }>;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  role: 'admin' | 'member';
  avatarUrl?: string;
}

export interface ShellContextResponse {
  workspace: WorkspaceSummary;
  repositories: RepositoryRef[];
  criticalOpen: number;
  liveRuns: number;
  qaEnabled: number;
}

export interface SettingsResponse {
  workspace: { id: string; name: string; slug: string };
  role: 'admin' | 'member';
  members: Array<{ id: string; name: string; email: string; image: string | null; role: 'admin' | 'member' }>;
  training: {
    mode: 'off' | 'workspace_private' | 'shared';
    consentVersion: string;
    retentionDays: number;
    includePrBody: boolean;
    includePaths: boolean;
    consentedAt: string | null;
    storedObjects: number;
    storedBytes: number;
    lastIngestedAt: string | null;
    repositories: Array<{ id: string; fullName: string; enabled: boolean }>;
    latestJob: { id: string; kind: 'delete'; status: 'queued' | 'running' | 'succeeded' | 'failed'; objectCount: number; error: string | null; createdAt: string; completedAt: string | null } | null;
  };
}

export interface OnboardingStatusResponse { hasGithub: boolean; hasWorkspace: boolean; workspaceId: string | null }
export interface GitHubInstallationChoice {
  id: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
  repositories: Array<{ id: number; fullName: string; private: boolean; archived: boolean; defaultBranch: string }>;
}
export interface OnboardingInstallationsResponse { installations: GitHubInstallationChoice[]; state: string }
export type ReviewPresetId = 'starter' | 'fast' | 'balanced' | 'high' | 'ultra';
export interface ReadinessResponse { ready: boolean; checks: { github: boolean; google: boolean; reviews: boolean; qa: boolean; billing: boolean; corpus: boolean; costs: boolean }; reviewPresets: Record<ReviewPresetId, boolean> }

export interface ApiEnvelope<T> {
  data: T;
  requestId: string;
}
