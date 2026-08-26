import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Activity, ArrowLeft, ArrowRight, Ban, Check, CheckCircle2, ChevronRight, CircleAlert, CircleDollarSign,
  CircleX, Clock3, ExternalLink, FileCode2, Filter, GitBranch, Globe2, KeyRound, MoreHorizontal, Play,
  Plus, RefreshCw, RotateCcw, Search, Settings2, ShieldCheck, Sparkles, Square, TerminalSquare, Users,
  WalletCards, Workflow, X,
} from 'lucide-react';
import type { FindingDetailResponse, FindingListItem, GitHubInstallationChoice, OnboardingInstallationsResponse, OnboardingStatusResponse, OverviewResponse, ReadinessResponse, RepositoryItem, ReviewPresetId, RunDetailResponse, RunListItem, SettingsResponse, UsageResponse } from '../shared/api';
import { BrowserFrame, GitHubInlineComments, LiveRunBadge, RunStatusDot, TerminalLog } from './components/eldora';
import { Badge, Button, Card, EmptyState, PageHeader, SelectButton, SeverityBadge, SourceBadge, StatusBadge, Toggle } from './components/ui';
import { findingDetails, findings, overview, repositoryItems, runDetails, runs, usage } from './lib/demo';
import { apiMutation, useApiResource } from './lib/api';
import { linkGitHub, signInWith, signOut } from './lib/auth';
import { repositorySetupMutations } from './lib/onboarding';
import { cn, formatDuration, formatMoney, formatRelative, shortSha } from './lib/utils';

function SectionHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return <div className="section-header"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{action}</div>;
}

function Repo({ item }: { item: { owner: string; name: string } }) {
  return <span className="repo-name"><span>{item.owner}</span>/{item.name}</span>;
}

function AttentionRow({ finding }: { finding: FindingListItem }) {
  return <Link to={`/findings/${finding.id}`} className="attention-row">
    <SeverityBadge severity={finding.severity} />
    <div className="attention-copy"><strong>{finding.title}</strong><span><Repo item={finding.repository} /> · PR #{finding.prNumber} · {finding.pathOrCheckpoint}</span></div>
    <SourceBadge source={finding.source} />
    <div className="evidence-pill">{finding.source === 'review' ? `${finding.agreement?.agreeing}/${finding.agreement?.total} agree` : finding.reproducible ? '2/2 reproduced' : 'Blocked'}</div>
    <ChevronRight size={16} />
  </Link>;
}

function ActivityTable({ items = runs }: { items?: RunListItem[] }) {
  return <div className="table-wrap"><table className="data-table">
    <thead><tr><th>Run</th><th>Repository</th><th>Status</th><th>Findings</th><th>Cost</th><th>Started</th><th><span className="sr-only">Actions</span></th></tr></thead>
    <tbody>{items.map((run) => <tr key={run.id}>
      <td><Link className="run-cell" to={`/runs/${run.id}`}><span className={cn('source-icon', `source-icon-${run.kind}`)}>{run.kind === 'review' ? <FileCode2 size={15} /> : <Globe2 size={15} />}</span><span><strong>{run.kind === 'review' ? 'Review' : 'Post-merge QA'}</strong><small>PR #{run.prNumber} · <code>{shortSha(run.sha)}</code></small></span></Link></td>
      <td><Repo item={run.repository} /></td>
      <td><div className="status-cell"><RunStatusDot status={run.status} /><span>{run.phase}</span>{run.status === 'running' && <LiveRunBadge label="Live" />}</div></td>
      <td>{run.findings || <span className="muted">—</span>}</td>
      <td className="mono">{formatMoney(run.costMicroUsd)}</td>
      <td><span title={new Date(run.startedAt).toLocaleString()}>{formatRelative(run.startedAt)}</span></td>
      <td><a className="icon-link" href={run.githubUrl} target="_blank" rel="noreferrer" aria-label="View on GitHub"><ExternalLink size={15} /></a></td>
    </tr>)}</tbody>
  </table></div>;
}

export function OverviewPage() {
  const resource = useApiResource<OverviewResponse>('/api/overview', overview);
  const data = resource.data ?? { metrics: { criticalOpen: 0, qaProductIssues: 0, currentSpendMicroUsd: 0 }, attention: [], attentionRuns: [], running: [], recent: [] };
  useEffect(() => { if (data.running.length === 0) return; const timer = window.setInterval(resource.refresh, 5_000); return () => window.clearInterval(timer); }, [data.running.length]);
  return <>
    <PageHeader eyebrow={new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })} title="Operational inbox" description="Here’s what needs attention across your repositories." actions={<Link className="button button-primary button-default" to="/repositories"><Play size={15} /> Review now</Link>} />
    <div className="metric-grid">
      <Card className="metric-card"><div className="metric-icon metric-danger"><ShieldCheck size={18} /></div><div><span>Open P0/P1</span><strong>{data.metrics.criticalOpen}</strong><small>Needs team attention</small></div><Link to="/findings">View findings <ArrowRight size={13} /></Link></Card>
      <Card className="metric-card"><div className="metric-icon metric-cyan"><Globe2 size={18} /></div><div><span>QA product issues</span><strong>{data.metrics.qaProductIssues}</strong><small>Reproducible issues</small></div><Link to="/findings?source=qa">Open evidence <ArrowRight size={13} /></Link></Card>
      <Card className="metric-card"><div className="metric-icon metric-purple"><CircleDollarSign size={18} /></div><div><span>Current spend</span><strong>{formatMoney(data.metrics.currentSpendMicroUsd)}</strong><small>Current billing period</small></div><Link to="/usage">View usage <ArrowRight size={13} /></Link></Card>
    </div>
    <section className="page-section">
      <SectionHeader title="Needs attention" description="Critical findings, reproducible QA issues, and blocked runs." action={<Link className="text-link" to="/findings">View all <ArrowRight size={14} /></Link>} />
      <Card className="attention-list">{data.attention.map((finding) => <AttentionRow key={finding.id} finding={finding} />)}{data.attention.length === 0 && data.attentionRuns.length === 0 && <EmptyState icon={<CheckCircle2 />} title="All clear" description="No findings or runs currently need attention." />}</Card>{data.attentionRuns.length > 0 && <ActivityTable items={data.attentionRuns} />}
    </section>
    <section className="page-section">
      <SectionHeader title="Running now" description="Live progress from isolated Juror runtimes." />
      {data.running.map((run) => <Card className="live-run-card" key={run.id}>
        <div className="live-run-main"><span className={cn('source-icon', `source-icon-${run.kind}`)}>{run.kind === 'review' ? <FileCode2 size={17} /> : <Globe2 size={17} />}</span><div><div><strong>{run.kind === 'review' ? 'Reviewing' : 'Testing'} PR #{run.prNumber}</strong><LiveRunBadge label="Live" /></div><span><Repo item={run.repository} /> · <code>{shortSha(run.sha)}</code></span></div></div>
        <div className="live-phase"><span>Current phase</span><strong>{run.phase}</strong><div className="phase-track"><span style={{ width: '72%' }} /></div></div>
        <div className="live-meta"><span><Clock3 size={14} /> {formatDuration(run.durationMs)}</span><span>{run.findings} candidates</span></div>
        <Button variant="secondary" size="small" onClick={() => void apiMutation(`/api/runs/${run.id}/cancel`, 'POST').then(resource.refresh)}><Square size={12} /> Cancel</Button>
      </Card>)}{data.running.length === 0 && <Card><EmptyState icon={<Activity />} title="No live runs" description="New pull requests will appear here as soon as execution starts." /></Card>}
    </section>
    <section className="page-section"><SectionHeader title="Recent activity" action={<Link className="text-link" to="/runs">All runs <ArrowRight size={14} /></Link>} /><ActivityTable items={data.recent} /></section>
  </>;
}

type FindingFilter = 'all' | 'open' | 'resolved' | 'ignored';
export function FindingsPage() {
  const resource = useApiResource<FindingListItem[]>('/api/findings', findings);
  const records = resource.data ?? [];
  const [status, setStatus] = useState<FindingFilter>('open');
  const [source, setSource] = useState<'all' | 'review' | 'qa'>(() => new URLSearchParams(window.location.search).get('source') === 'qa' ? 'qa' : new URLSearchParams(window.location.search).get('source') === 'review' ? 'review' : 'all');
  const [severity, setSeverity] = useState<'all' | 'P0' | 'P1' | 'P2' | 'P3'>('all');
  const [query, setQuery] = useState('');
  const filtered = records.filter((finding) => (status === 'all' || finding.status === status) && (source === 'all' || finding.source === source) && (severity === 'all' || finding.severity === severity) && `${finding.title} ${finding.repository.fullName} ${finding.pathOrCheckpoint} ${finding.assignee?.name ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  return <>
    <PageHeader title="Findings" description="One inbox for review defects and reproducible QA issues." actions={<Button variant="secondary" onClick={resource.refresh}><RefreshCw size={14} /> Refresh</Button>} />
    <div className="toolbar">
      <div className="segmented">{(['open', 'resolved', 'ignored', 'all'] as const).map((item) => <button key={item} className={status === item ? 'active' : ''} onClick={() => setStatus(item)}>{item[0]!.toUpperCase() + item.slice(1)}{item === 'open' && <em>{records.filter((finding) => finding.status === 'open').length}</em>}</button>)}</div>
      <div className="search-field"><Search size={15} /><input aria-label="Search findings" placeholder="Search findings…" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
      <label className="select-button"><Filter size={14} /><select value={severity} onChange={(event) => setSeverity(event.target.value as typeof severity)} aria-label="Severity"><option value="all">All severities</option><option>P0</option><option>P1</option><option>P2</option><option>P3</option></select></label>
      <div className="segmented compact">{(['all', 'review', 'qa'] as const).map((item) => <button key={item} className={source === item ? 'active' : ''} onClick={() => setSource(item)}>{item === 'all' ? 'All sources' : item === 'review' ? 'Review' : 'QA'}</button>)}</div>
    </div>
    <div className="table-wrap findings-table"><table className="data-table">
      <thead><tr><th><input type="checkbox" aria-label="Select all findings" /></th><th>Finding</th><th>Severity</th><th>Source</th><th>Repository</th><th>Evidence</th><th>Assignee</th><th>Last seen</th></tr></thead>
      <tbody>{filtered.map((finding) => <tr key={finding.id}>
        <td><input type="checkbox" aria-label={`Select ${finding.title}`} /></td>
        <td><Link className="finding-title" to={`/findings/${finding.id}`}><strong>{finding.title}</strong><small>{finding.pathOrCheckpoint}{finding.line ? `:${finding.line}` : ''}</small></Link></td>
        <td><SeverityBadge severity={finding.severity} /></td><td><SourceBadge source={finding.source} /></td><td><Repo item={finding.repository} /><small className="table-sub">PR #{finding.prNumber}</small></td>
        <td><span className="evidence-pill">{finding.source === 'review' ? `${finding.agreement?.agreeing}/${finding.agreement?.total} models` : finding.reproducible ? '2/2 reproduced' : 'Not reproduced'}</span></td>
        <td>{finding.assignee ? <span className="assignee"><i>{finding.assignee.name[0]}</i>{finding.assignee.name}</span> : <span className="muted">Unassigned</span>}</td>
        <td>{formatRelative(finding.lastSeenAt)}</td>
      </tr>)}</tbody>
    </table>{filtered.length === 0 && <EmptyState icon={<CheckCircle2 />} title="Nothing here" description="No findings match the current filters." />}</div>
  </>;
}

export function FindingDetailPage() {
  const { findingId = '' } = useParams();
  const navigate = useNavigate();
  const fallback = findingDetails[findingId] ?? ({ ...findings.find((item) => item.id === findingId), body: 'Detailed evidence is unavailable.', claim: null, expected: null, actual: null, attempts: [], targetUrl: null, targetRevision: null, verification: null, githubUrl: '#', diff: null } as FindingDetailResponse);
  const resource = useApiResource<FindingDetailResponse>(`/api/findings/${findingId}`, fallback);
  const [loadedDiff, setLoadedDiff] = useState<FindingDetailResponse['diff']>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const finding = resource.data;
  if (!finding?.id) return <EmptyState icon={<CircleAlert />} title={resource.loading ? 'Loading finding…' : 'Finding not found'} description={resource.error ?? 'This finding may have expired or moved.'} />;
  const loadDiff = async () => {
    setDiffLoading(true); setDiffError(null);
    try {
      const response = await fetch(`/api/findings/${finding.id}/diff`, { credentials: 'include' });
      const payload = await response.json() as { data?: FindingDetailResponse['diff']; error?: { message?: string } };
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? 'The GitHub diff could not be loaded.');
      setLoadedDiff(payload.data);
    } catch (failure) {
      setDiffError(failure instanceof Error ? failure.message : 'The GitHub diff could not be loaded.');
    } finally {
      setDiffLoading(false);
    }
  };
  return <>
    <button className="back-link" onClick={() => navigate('/findings')}><ArrowLeft size={14} /> Findings</button>
    <div className="detail-header">
      <div className="detail-title-row"><SeverityBadge severity={finding.severity} /><SourceBadge source={finding.source} /><StatusBadge status={finding.status} /></div>
      <h1>{finding.title}</h1>
      <div className="detail-meta"><Repo item={finding.repository} /><span>PR #{finding.prNumber}</span><span>First seen {formatRelative(finding.firstSeenAt)}</span><span>Last seen {formatRelative(finding.lastSeenAt)}</span></div>
      <div className="detail-actions"><Button variant="secondary"><Users size={14} /> {finding.assignee?.name ?? 'Assign'}</Button><Button variant="secondary" onClick={() => void apiMutation(`/api/findings/${finding.id}`, 'PATCH', { status: 'ignored' }).then(resource.refresh)}><Ban size={14} /> Ignore</Button><Button onClick={() => void apiMutation(`/api/findings/${finding.id}`, 'PATCH', { status: 'resolved' }).then(resource.refresh)}><Check size={14} /> Resolve</Button><a href={finding.githubUrl} target="_blank" rel="noreferrer" className="button button-secondary button-default">View on GitHub <ExternalLink size={14} /></a></div>
    </div>
    <div className="detail-layout"><div className="detail-main">
      <Card className="finding-explanation"><div className="card-heading"><Sparkles size={16} /><h2>What Juror found</h2></div><p>{finding.body}</p></Card>
      {finding.claim && <Card><div className="card-heading"><Workflow size={16} /><h2>Causal analysis</h2></div><div className="claim-grid">
        {Object.entries(finding.claim).map(([key, value], index) => <div className="claim-row" key={key}><span>{index + 1}</span><div><strong>{key}</strong><p>{value}</p></div></div>)}
      </div></Card>}
      {finding.source === 'review' && <section><SectionHeader title="Code evidence" description="Fetched from GitHub on demand. The patch is not stored by Juror." action={!loadedDiff && !finding.diff ? <Button variant="secondary" size="small" disabled={diffLoading} onClick={() => void loadDiff()}>{diffLoading ? 'Loading…' : 'Load GitHub diff'}</Button> : undefined} />{diffError && <div className="setup-error"><CircleAlert size={15} />{diffError}</div>}{(loadedDiff ?? finding.diff) ? <GitHubInlineComments diff={(loadedDiff ?? finding.diff)!} title={finding.title} body={finding.body} /> : !diffLoading && !diffError && <p className="side-note">Load the current patch only when you need it.</p>}</section>}
      {finding.source === 'qa' && <>
        <Card><div className="card-heading"><ShieldCheck size={16} /><h2>Expected vs actual</h2></div><div className="expected-grid"><div><span>Expected</span><p>{finding.expected}</p></div><div><span>Actual</span><p>{finding.actual}</p></div></div></Card>
        <section><SectionHeader title="Reproduction evidence" description="Both attempts ran from a reset staging state." />{finding.attempts.map((attempt) => <div className="attempt-block" key={attempt.attempt}><div><Badge tone="red">Attempt {attempt.attempt}</Badge><span>{attempt.status}</span><p>{attempt.observed}</p></div>{attempt.screenshotUrl && <BrowserFrame url={finding.targetUrl ?? 'Configured staging target'} imageUrl={attempt.screenshotUrl} caption={`Attempt ${attempt.attempt}: ${attempt.observed}`} />}</div>)}</section>
      </>}
    </div><aside className="detail-side">
      <Card><h3>Evidence</h3>{finding.source === 'review' ? <><div className="side-stat"><span>Model agreement</span><strong>{finding.agreement?.agreeing}/{finding.agreement?.total}</strong></div><div className="agreement-bars"><i /><i /><i className={(finding.agreement?.agreeing ?? 0) < 3 ? 'muted-bar' : ''} /></div>{finding.verification && <div className="verification"><CheckCircle2 size={15} /><div><strong>{finding.verification.status}</strong><p>{finding.verification.reason}</p><span>{finding.verification.model}</span></div></div>}</> : <><div className="side-stat"><span>Reproducibility</span><strong>{finding.reproducible ? '2 / 2' : '0 / 2'}</strong></div>{finding.targetRevision && <div className="revision-proof"><CheckCircle2 size={15} /><div><strong>Target revision {finding.targetRevision.relation}</strong><code>{shortSha(finding.targetRevision.observedSha ?? finding.targetRevision.expectedSha ?? '')}</code></div></div>}</>}</Card>
      <Card><h3>Lifecycle</h3><div className="timeline-mini"><div className="done"><i /><span><strong>First reported</strong><small>{formatRelative(finding.firstSeenAt)}</small></span></div><div><i /><span><strong>Waiting for triage</strong><small>Dashboard-owned state</small></span></div></div><p className="side-note">A later probabilistic review will not auto-resolve this finding. GitHub must report the review thread resolved.</p></Card>
    </aside></div>
  </>;
}

export function RunsPage() {
  const resource = useApiResource<RunListItem[]>('/api/runs', runs);
  const records = resource.data ?? [];
  const [kind, setKind] = useState<'all' | 'review' | 'qa'>('all');
  const [status, setStatus] = useState<'all' | RunListItem['status']>('all');
  const [query, setQuery] = useState('');
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const filtered = records.filter((run) => (kind === 'all' || run.kind === kind) && (status === 'all' || run.status === status) && new Date(run.startedAt).getTime() >= cutoff && `${run.repository.fullName} ${run.prNumber} ${run.sha}`.toLowerCase().includes(query.toLowerCase()));
  return <><PageHeader title="Runs" description="Live and historical AI review and post-merge QA executions." actions={<Button><Play size={14} /> New run</Button>} />
    <div className="toolbar"><div className="segmented">{(['all', 'review', 'qa'] as const).map((item) => <button className={kind === item ? 'active' : ''} onClick={() => setKind(item)} key={item}>{item === 'all' ? 'All runs' : item === 'review' ? 'Review' : 'QA'}</button>)}</div><div className="search-field"><Search size={15} /><input placeholder="Search by repository, PR, or SHA…" value={query} onChange={(event) => setQuery(event.target.value)} /></div><label className="select-button"><select value={status} onChange={(event) => setStatus(event.target.value as typeof status)} aria-label="Run status"><option value="all">All statuses</option><option>queued</option><option>running</option><option>succeeded</option><option>warning</option><option>failed</option><option>cancelled</option><option>blocked</option></select></label><SelectButton>Last 30 days</SelectButton></div>
    <ActivityTable items={filtered} /></>;
}

export function RunDetailPage() {
  const { runId = '' } = useParams();
  const resource = useApiResource<RunDetailResponse>(`/api/runs/${runId}`, runDetails[runId]!);
  const run = resource.data;
  useEffect(() => {
    if (!run || !['queued', 'running'].includes(run.status)) return;
    const source = new EventSource(`/api/runs/${runId}/events`);
    source.addEventListener('run-event', resource.refresh);
    source.addEventListener('complete', () => { resource.refresh(); source.close(); });
    source.onerror = () => { source.close(); window.setTimeout(resource.refresh, 3_000); };
    return () => source.close();
  }, [runId, run?.status]);
  if (!run) return <EmptyState icon={<Activity />} title={resource.loading ? 'Loading run…' : 'Run not found'} description={resource.error ?? 'The run may have expired or moved.'} />;
  const total = run.receipt.reduce((sum, item) => sum + item.amountMicroUsd, 0);
  return <>
    <Link to="/runs" className="back-link"><ArrowLeft size={14} /> Runs</Link>
    <div className="detail-header run-detail-header"><div className="detail-title-row"><SourceBadge source={run.kind} /><StatusBadge status={run.status} />{run.status === 'running' && <LiveRunBadge />}</div><h1>{run.kind === 'review' ? 'AI review' : 'Post-merge QA'} · PR #{run.prNumber}</h1><div className="detail-meta"><Repo item={run.repository} /><code>{run.sha}</code><span>{formatDuration(run.durationMs)}</span><span>{formatMoney(run.costMicroUsd)}</span></div><div className="detail-actions">{run.status === 'running' ? <Button variant="danger" onClick={() => void apiMutation(`/api/runs/${run.id}/cancel`, 'POST').then(resource.refresh)}><Square size={13} /> Cancel run</Button> : <Button variant="secondary" onClick={() => void apiMutation(`/api/runs/${run.id}/rerun`, 'POST').then(resource.refresh)}><RotateCcw size={14} /> Rerun</Button>}<a href={run.githubUrl} target="_blank" rel="noreferrer" className="button button-secondary button-default">View on GitHub <ExternalLink size={14} /></a></div></div>
    <div className="run-layout"><div className="detail-main">
      <Card><div className="card-heading"><Activity size={16} /><h2>Progress</h2></div><div className="phase-timeline">{run.events.map((event, index) => <div className={cn('phase-event', `phase-${event.status}`)} key={event.sequence}><div className="phase-marker">{event.status === 'succeeded' ? <Check size={13} /> : event.status === 'running' ? <span /> : <CircleAlert size={13} />}</div><div><strong>{event.phase}</strong><p>{event.message}</p></div><span>{event.durationMs ? formatDuration(event.durationMs) : ''}</span>{index < run.events.length - 1 && <i />}</div>)}</div></Card>
      {run.warnings.length > 0 && <div className="warning-callout"><CircleAlert size={17} /><div><strong>Run needs configuration</strong>{run.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div><Link to="/repositories">Open setup <ArrowRight size={14} /></Link></div>}
      <section><SectionHeader title="Sanitized terminal output" description="Operational messages only. Model scratch text and chain-of-thought are never collected." /><TerminalLog rows={run.terminal} /></section>
    </div><aside className="detail-side">
      <Card><h3>Run summary</h3><div className="side-list"><div><span>Run ID</span><code>{run.id}</code></div><div><span>Trigger identity</span><code className="truncate-code">{run.identity}</code></div><div><span>Findings</span><strong>{run.findings}</strong></div><div><span>Started</span><span>{new Date(run.startedAt).toLocaleString()}</span></div></div></Card>
      <Card><h3>Cost receipt</h3><div className="receipt-list">{run.receipt.map((item) => <div key={item.label}><span>{item.label}</span><code>{formatMoney(item.amountMicroUsd)}</code></div>)}<div className="receipt-total"><strong>Total</strong><strong>{formatMoney(total)}</strong></div></div><p className="side-note">Direct costs plus a transparent 25% Juror service fee. Failed infrastructure and cancellations are not billed.</p></Card>
    </aside></div>
  </>;
}

function RepositoryRow({ repository, onSaved, presetReadiness }: { repository: RepositoryItem; onSaved: () => void; presetReadiness?: Record<ReviewPresetId, boolean> }) {
  const [expanded, setExpanded] = useState(false);
  const [reviewEnabled, setReviewEnabled] = useState(repository.reviewEnabled);
  const [qaEnabled, setQaEnabled] = useState(repository.qaEnabled);
  const [preset, setPreset] = useState(repository.reviewPreset);
  const [publishMode, setPublishMode] = useState(repository.publishMode);
  const [severityFloor, setSeverityFloor] = useState(repository.severityFloor);
  const [qaTarget, setQaTarget] = useState(repository.qaTarget ?? '');
  const [allowedOrigins, setAllowedOrigins] = useState(repository.allowedOrigins.join('\n'));
  const [sessionUrl, setSessionUrl] = useState('');
  const [sessionTargetOrigin, setSessionTargetOrigin] = useState(repository.qaTarget ? new URL(repository.qaTarget).origin : '');
  const [sessionReadyKey, setSessionReadyKey] = useState('juror_support_session');
  const [sessionSecret, setSessionSecret] = useState('');
  const [secretHeaders, setSecretHeaders] = useState('');
  const [resetUrl, setResetUrl] = useState('');
  const [resetMethod, setResetMethod] = useState<'POST' | 'PUT' | 'PATCH' | 'DELETE'>('POST');
  const [resetHeaders, setResetHeaders] = useState('');
  const [clearSessionBootstrap, setClearSessionBootstrap] = useState(false);
  const [clearSecretHeaders, setClearSecretHeaders] = useState(false);
  const [clearResetHook, setClearResetHook] = useState(false);
  const [screenshotEvidence, setScreenshotEvidence] = useState(repository.evidencePolicy.screenshot);
  const [traceEvidence, setTraceEvidence] = useState(repository.evidencePolicy.trace);
  const [videoEvidence, setVideoEvidence] = useState(repository.evidencePolicy.video);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reset = () => { setReviewEnabled(repository.reviewEnabled); setQaEnabled(repository.qaEnabled); setPreset(repository.reviewPreset); setPublishMode(repository.publishMode); setSeverityFloor(repository.severityFloor); setQaTarget(repository.qaTarget ?? ''); setAllowedOrigins(repository.allowedOrigins.join('\n')); setSessionUrl(''); setSessionTargetOrigin(repository.qaTarget ? new URL(repository.qaTarget).origin : ''); setSessionSecret(''); setSecretHeaders(''); setResetUrl(''); setResetHeaders(''); setClearSessionBootstrap(false); setClearSecretHeaders(false); setClearResetHook(false); setScreenshotEvidence(repository.evidencePolicy.screenshot); setTraceEvidence(repository.evidencePolicy.trace); setVideoEvidence(repository.evidencePolicy.video); setError(null); };
  const save = async () => {
    setSaving(true); setError(null);
    try {
      const parseSecretRows = (value: string) => value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => { const [name, secret, origins] = line.split('|').map((part) => part.trim()); if (!name || !secret || !origins) throw new Error('Secret header rows must use Name | value | origin[,origin].'); return { name, value: secret, origins: origins.split(',').map((origin) => origin.trim()).filter(Boolean) }; });
      const parseResetRows = (value: string) => value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => { const [name, secret, format = 'raw'] = line.split('|').map((part) => part.trim()); if (!name || !secret || !['bearer', 'raw'].includes(format)) throw new Error('Reset header rows must use Name | value | bearer/raw.'); return { name, value: secret, format: format as 'bearer' | 'raw' }; });
      const body: Record<string, unknown> = { reviewEnabled, reviewPreset: preset, publishMode, severityFloor, qaEnabled, qaTarget: qaTarget || null, allowedOrigins: allowedOrigins.split(/\s+/).filter(Boolean), evidencePolicy: { screenshot: screenshotEvidence, trace: traceEvidence, video: videoEvidence } };
      if (clearSessionBootstrap) body.sessionBootstrap = null;
      else if (sessionUrl || sessionSecret) {
        if (!sessionUrl || !sessionTargetOrigin || !sessionSecret) throw new Error('Session bootstrap URL, target origin, and secret are all required.');
        body.sessionBootstrap = { url: sessionUrl, targetOrigin: sessionTargetOrigin, readyStorageKey: sessionReadyKey, secret: sessionSecret };
      }
      if (clearSecretHeaders) body.secretHeaders = null;
      else if (secretHeaders.trim()) body.secretHeaders = parseSecretRows(secretHeaders);
      if (clearResetHook) body.resetHook = null;
      else if (resetUrl || resetHeaders) body.resetHook = { url: resetUrl, method: resetMethod, secretHeaders: parseResetRows(resetHeaders), expectedStatuses: [200, 204], timeoutSeconds: 15 };
      await apiMutation(`/api/repositories/${repository.id}`, 'PATCH', body);
      setClearSessionBootstrap(false); setClearSecretHeaders(false); setClearResetHook(false);
      onSaved();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Settings could not be saved.'); }
    finally { setSaving(false); }
  };
  const reviewNow = async () => {
    const raw = window.prompt('Open pull request number');
    if (!raw) return;
    const prNumber = Number.parseInt(raw, 10);
    if (!Number.isInteger(prNumber) || prNumber < 1) { setError('Enter a valid pull request number.'); return; }
    try { const run = await apiMutation<{ id: string }>(`/api/repositories/${repository.id}/review-now`, 'POST', { prNumber }); window.location.assign(`/runs/${run.id}`); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'The review could not be started.'); }
  };
  return <Card className={cn('repository-card', expanded && 'expanded')}>
    <div className="repository-summary">
      <div className="repository-identity"><span className="repo-avatar">{repository.name.slice(0, 2).toUpperCase()}</span><div><strong><Repo item={repository} /></strong><span><StatusBadge status={repository.connectionStatus} /> · default <code>{repository.defaultBranch}</code></span></div></div>
      <div className="repo-setting"><span>AI review</span><strong>{reviewEnabled ? repository.reviewPreset : 'Off'}</strong></div><div className="repo-setting"><span>Post-merge QA</span><strong>{qaEnabled ? (repository.qaReady ? 'Ready' : 'Setup needed') : 'Off'}</strong></div>
      <div className="repo-setting"><span>Latest run</span><strong>{repository.latestRun ? formatRelative(repository.latestRun.startedAt) : 'Never'}</strong></div>
      <Button variant="ghost" size="small" onClick={() => setExpanded(!expanded)}>{expanded ? 'Close' : 'Configure'} <Settings2 size={14} /></Button>
    </div>
    {expanded && <div className="repository-config">
      {repository.hostedAutomationBlocked && <div className="warning-callout compact-callout"><CircleAlert size={16} /><div><strong>Juror workflow check required</strong><p>Remove any existing Juror workflow. Juror will recheck when you save Cloud automation.</p></div><a className="button button-secondary button-small" href={`https://github.com/${repository.fullName}/tree/${repository.defaultBranch}/.github/workflows`} target="_blank" rel="noreferrer">Review workflows</a></div>}
      <div className="config-columns"><div><h3>Review</h3><Toggle checked={reviewEnabled} onChange={setReviewEnabled} label="Automated AI review" description="Run when a pull request opens or its head changes." />
        <label className="field"><span>Preset</span><select value={preset} onChange={(event) => setPreset(event.target.value as typeof preset)}>{(['starter', 'fast', 'balanced', 'high', 'ultra'] as const).map((option) => <option key={option} value={option} disabled={presetReadiness ? !presetReadiness[option] && option !== preset : false}>{option}{presetReadiness && !presetReadiness[option] ? ' (unavailable)' : ''}</option>)}</select></label>
        {presetReadiness && !presetReadiness[preset] && <p className="field-hint">This deployment has no provider credential for the {preset} jury, so its runs are blocked before they start.</p>}
        <div className="field-row"><label className="field"><span>Publish</span><select value={publishMode} onChange={(event) => setPublishMode(event.target.value as typeof publishMode)}><option>all</option><option>consensus</option></select></label><label className="field"><span>Severity floor</span><select value={severityFloor} onChange={(event) => setSeverityFloor(event.target.value as typeof severityFloor)}><option>P0</option><option>P1</option><option>P2</option><option>P3</option></select></label></div>
        <Button variant="secondary" size="small" onClick={() => void reviewNow()}><Play size={13} /> Review open PR now</Button>
      </div><div><h3>Post-merge QA <Badge tone="gold">staging only</Badge></h3><Toggle checked={qaEnabled} onChange={setQaEnabled} label="Automated QA" description="Run after a PR merges into the default branch." />
        {qaEnabled && <div className="progressive-fields"><label className="field"><span>Staging target</span><input value={qaTarget} onChange={(event) => { setQaTarget(event.target.value); try { setSessionTargetOrigin(new URL(event.target.value).origin); } catch { /* Keep the prior exact origin until the URL is valid. */ } }} placeholder="https://staging.example.com" /></label><label className="field"><span>Allowed origins</span><textarea value={allowedOrigins} onChange={(event) => setAllowedOrigins(event.target.value)} placeholder="One exact origin per line" rows={3} /></label>
          <details className="advanced-setting"><summary>Session bootstrap and secret headers <span>{repository.hasSessionBootstrap || repository.hasSecretHeaders ? 'Configured' : 'Optional'} <ChevronRight size={14} /></span></summary><div><p>Secrets are encrypted and injected only for exact origins. Leave blank to keep existing values.</p>{repository.hasSessionBootstrap && <label className="check-row"><input type="checkbox" checked={clearSessionBootstrap} onChange={(event) => setClearSessionBootstrap(event.target.checked)} /><span><strong>Clear saved session bootstrap</strong><small>Removes the stored endpoint and bearer secret on save.</small></span></label>}<label className="field"><span>Bootstrap endpoint</span><input value={sessionUrl} disabled={clearSessionBootstrap} onChange={(event) => setSessionUrl(event.target.value)} placeholder="https://support.example.com/session" /></label><label className="field"><span>Target origin</span><input value={sessionTargetOrigin} disabled={clearSessionBootstrap} onChange={(event) => setSessionTargetOrigin(event.target.value)} placeholder="https://staging.example.com" /></label><label className="field"><span>Ready storage key</span><input value={sessionReadyKey} disabled={clearSessionBootstrap} onChange={(event) => setSessionReadyKey(event.target.value)} /></label><label className="field"><span>Bootstrap bearer secret</span><input type="password" autoComplete="new-password" value={sessionSecret} disabled={clearSessionBootstrap} onChange={(event) => setSessionSecret(event.target.value)} placeholder={repository.hasSessionBootstrap ? '•••••••• (unchanged)' : 'At least 32 characters'} /></label>{repository.hasSecretHeaders && <label className="check-row"><input type="checkbox" checked={clearSecretHeaders} onChange={(event) => setClearSecretHeaders(event.target.checked)} /><span><strong>Clear saved scoped headers</strong><small>Stops injecting all currently stored headers.</small></span></label>}<label className="field"><span>Scoped headers</span><textarea value={secretHeaders} disabled={clearSecretHeaders} onChange={(event) => setSecretHeaders(event.target.value)} rows={3} placeholder="X-Staging-Key | secret | https://staging.example.com" /></label></div></details>
          <details className="advanced-setting"><summary>Reset hook <span>{repository.hasResetHook ? 'Configured' : 'Optional'} <ChevronRight size={14} /></span></summary><div>{repository.hasResetHook && <label className="check-row"><input type="checkbox" checked={clearResetHook} onChange={(event) => setClearResetHook(event.target.checked)} /><span><strong>Clear saved reset hook</strong><small>Stops calling the stored endpoint on QA runs.</small></span></label>}<label className="field"><span>Reset URL</span><input value={resetUrl} disabled={clearResetHook} onChange={(event) => setResetUrl(event.target.value)} placeholder="https://staging.example.com/api/qa/reset" /></label><label className="field"><span>Method</span><select value={resetMethod} disabled={clearResetHook} onChange={(event) => setResetMethod(event.target.value as typeof resetMethod)}><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option></select></label><label className="field"><span>Secret headers</span><textarea value={resetHeaders} disabled={clearResetHook} onChange={(event) => setResetHeaders(event.target.value)} rows={2} placeholder="Authorization | secret | bearer" /></label></div></details>
          <details className="advanced-setting"><summary>Evidence policy <span>90 days <ChevronRight size={14} /></span></summary><div className="field-row">{([['Screenshot', screenshotEvidence, setScreenshotEvidence], ['Trace', traceEvidence, setTraceEvidence], ['Video', videoEvidence, setVideoEvidence]] as const).map(([label, value, setter]) => <label className="field" key={label}><span>{label}</span><select value={value} onChange={(event) => setter(event.target.value as typeof value)}><option>failure</option><option>all</option><option>off</option></select></label>)}</div></details>
        </div>}
      </div></div>
      {error && <div className="setup-error"><CircleAlert size={15} />{error}</div>}
      <div className="config-footer"><span>GitHub App access: <strong>Read metadata, contents, deployments & PR comments · Write PRs & checks</strong></span><div><Button variant="ghost" onClick={reset}>Discard</Button><Button onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</Button></div></div>
    </div>}
  </Card>;
}

export function RepositoriesPage() {
  const resource = useApiResource<RepositoryItem[]>('/api/repositories', repositoryItems);
  const readiness = useApiResource<ReadinessResponse>('/api/readiness', { ready: true, checks: { github: true, google: true, reviews: true, qa: true, billing: true, corpus: true, costs: true }, reviewPresets: { starter: true, fast: true, balanced: true, high: true, ultra: true } });
  const manageInstallation = async () => { const response = await fetch('/api/github/manage-url', { credentials: 'include' }); const payload = await response.json() as { data?: { url: string }; error?: { message: string } }; if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? 'GitHub installation is unavailable.'); window.location.assign(payload.data.url); };
  const count = resource.data?.length ?? 0;
  return <><PageHeader title="Repositories" description="Control hosted review defaults and staging QA readiness." actions={<Button onClick={() => void manageInstallation()}><Plus size={15} /> Add repositories</Button>} />
    <div className="notice"><GitBranch size={17} /><div><strong>GitHub App connected</strong><p>Juror has access to {count} selected {count === 1 ? 'repository' : 'repositories'}. Historical pull requests are never backfilled.</p></div><Button variant="secondary" size="small" onClick={() => void manageInstallation()}>Manage on GitHub <ExternalLink size={13} /></Button></div>
    <div className="repository-list">{(resource.data ?? []).map((repository) => <RepositoryRow repository={repository} onSaved={resource.refresh} presetReadiness={readiness.data?.reviewPresets} key={repository.id} />)}</div>
  </>;
}

export function UsagePage() {
  const resource = useApiResource<UsageResponse>('/api/usage', usage);
  const data = resource.data ?? usage;
  const [error, setError] = useState<string | null>(null);
  const committed = data.currentSpendMicroUsd + data.reservedMicroUsd;
  const capPercentage = Math.min(100, (committed / data.capMicroUsd) * 100);
  const openBilling = async () => { setError(null); try { const result = await apiMutation<{ url: string }>(data.hasBillingCustomer ? '/api/billing/portal' : '/api/billing/checkout', 'POST'); window.location.assign(result.url); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Billing could not be opened.'); } };
  const changeCap = async () => { const raw = window.prompt('Monthly hard cap in USD', String(data.capMicroUsd / 1_000_000)); if (!raw) return; const dollars = Number(raw); if (!Number.isFinite(dollars)) { setError('Enter a valid monthly cap.'); return; } setError(null); try { await apiMutation('/api/usage/cap', 'PATCH', { capMicroUsd: Math.round(dollars * 1_000_000) }); resource.refresh(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'The monthly cap could not be changed.'); } };
  const periodStart = new Date(); periodStart.setDate(1);
  const periodEnd = new Date(periodStart.getFullYear(), periodStart.getMonth() + 1, 0);
  const periodMonth = periodStart.toLocaleDateString(undefined, { month: 'long' });
  const periodRange = `${periodStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}–${periodEnd.toLocaleDateString(undefined, { day: 'numeric' })}`;
  const costColors = ['#635bff', '#38bdf8', '#b4780a', '#f472b6', '#a78bfa'];
  let costCursor = 0;
  const costSegments = data.breakdown.map((item, index) => { const start = costCursor; costCursor += item.percentage; return `${costColors[index]} ${start}% ${costCursor}%`; });
  const costGradient = data.currentSpendMicroUsd > 0 ? `conic-gradient(${costSegments.join(', ')})` : '#262626';
  return <><PageHeader title="Usage" description="A transparent receipt for hosted model, compute, storage, and service costs." actions={data.role === 'admin' ? <Button variant="secondary" onClick={() => void openBilling()}><WalletCards size={15} /> {data.hasBillingCustomer ? 'Billing portal' : 'Activate billing'}</Button> : undefined} />
    <div className="usage-grid"><Card className="usage-hero"><div className="usage-hero-head"><div><span>{periodMonth} usage</span><strong>{formatMoney(data.currentSpendMicroUsd)}</strong><small>{formatMoney(data.reservedMicroUsd)} currently reserved</small></div><Badge tone={data.warningAt80Percent ? 'gold' : 'green'}>{data.warningAt80Percent ? 'Near cap' : 'On track'}</Badge></div><div className="cap-bar"><span style={{ width: `${capPercentage}%` }} /></div><div className="cap-labels"><span>{Math.round(capPercentage)}% of monthly cap</span><strong>{formatMoney(data.capMicroUsd)}</strong></div><div className="usage-projection"><Sparkles size={16} /><span>Projected invoice</span><strong>{formatMoney(data.projectedInvoiceMicroUsd)}</strong></div></Card>
      <Card><h3>Billing status</h3><div className="billing-status"><CheckCircle2 size={20} /><div><strong>{data.billingState === 'active' ? 'Metered billing active' : data.billingState === 'trial' ? 'No-card trial' : 'Billing needs attention'}</strong><p>Runs are reported once, after the ledger is finalized.</p></div></div><div className="side-list"><div><span>Trial remaining</span><strong>{formatMoney(data.trialRemainingMicroUsd)}</strong></div><div><span>Warning threshold</span><strong>80%</strong></div><div><span>Hard cap</span><strong>{formatMoney(data.capMicroUsd)}</strong></div></div>{error && <div className="setup-error"><CircleAlert size={15} />{error}</div>}{data.role === 'admin' && <Button variant="secondary" className="full-button" onClick={() => void changeCap()}>Change monthly cap</Button>}</Card></div>
    <section className="page-section"><SectionHeader title="Cost breakdown" description={`Current billing period · ${periodRange}`} /><Card className="cost-breakdown"><div className="cost-donut" style={{ background: costGradient }}><div><strong>{formatMoney(data.currentSpendMicroUsd)}</strong><span>Total</span></div></div><div className="cost-legend">{data.breakdown.map((item) => <div key={item.kind}><i className={`cost-color cost-${item.kind}`} /><span>{item.kind.replace('_', ' ')}</span><strong>{item.percentage}%</strong><code>{formatMoney(item.amountMicroUsd)}</code></div>)}</div><div className="fee-note"><CircleAlert size={15} /><p>The 25% service fee applies to direct provider, Sandbox, and storage costs. All arithmetic is recorded in integer micro-USD.</p></div></Card></section>
    <section className="page-section"><SectionHeader title="Invoice history" /><div className="table-wrap"><table className="data-table"><thead><tr><th>Period</th><th>Status</th><th>Amount</th><th>Invoice</th></tr></thead><tbody>{data.invoices.map((invoice) => <tr key={invoice.id}><td>{invoice.period}</td><td><StatusBadge status={invoice.status} /></td><td className="mono">{formatMoney(invoice.amountMicroUsd)}</td><td><a href={invoice.url ?? '#'} className="text-link">View invoice <ExternalLink size={13} /></a></td></tr>)}</tbody></table></div></section>
  </>;
}

export function SettingsPage() {
  const fallback: SettingsResponse = { workspace: { id: 'demo', name: 'Juror AI', slug: 'juror-ai' }, role: 'admin', members: [], training: { mode: 'off', consentVersion: '2026-08-21.v1', retentionDays: 365, includePrBody: false, includePaths: false, consentedAt: null, storedObjects: 0, storedBytes: 0, lastIngestedAt: null, repositories: [], latestJob: null } };
  const resource = useApiResource<SettingsResponse>('/api/settings', fallback);
  const data = resource.data;
  const [name, setName] = useState(''); const [slug, setSlug] = useState(''); const [error, setError] = useState<string | null>(null);
  const [trainingMode, setTrainingMode] = useState<SettingsResponse['training']['mode']>('off');
  const [trainingRetention, setTrainingRetention] = useState(365); const [includePrBody, setIncludePrBody] = useState(false); const [includePaths, setIncludePaths] = useState(false);
  const [trainingRepositories, setTrainingRepositories] = useState<Set<string>>(new Set()); const [trainingAcknowledged, setTrainingAcknowledged] = useState(false); const [trainingSaving, setTrainingSaving] = useState(false);
  useEffect(() => { if (data) { setName(data.workspace.name); setSlug(data.workspace.slug); setTrainingMode(data.training.mode); setTrainingRetention(data.training.retentionDays); setIncludePrBody(data.training.includePrBody); setIncludePaths(data.training.includePaths); setTrainingRepositories(new Set(data.training.repositories.filter((repository) => repository.enabled).map((repository) => repository.id))); setTrainingAcknowledged(data.training.mode !== 'off'); } }, [data]);
  if (!data) return <EmptyState icon={<Settings2 />} title={resource.loading ? 'Loading settings…' : 'Settings unavailable'} description={resource.error ?? 'Sign in again to continue.'} />;
  const saveWorkspace = async () => { try { await apiMutation('/api/settings/workspace', 'PATCH', { name, slug }); resource.refresh(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Workspace could not be saved.'); } };
  const invite = async () => { const email = window.prompt('Member email address'); if (!email) return; try { await apiMutation('/api/settings/members', 'POST', { email, role: 'member' }); resource.refresh(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Member could not be added.'); } };
  const saveTraining = async () => { setTrainingSaving(true); setError(null); try { await apiMutation('/api/settings/training', 'PATCH', { mode: trainingMode, retentionDays: trainingRetention, includePrBody, includePaths, repositoryIds: [...trainingRepositories], acknowledgement: trainingMode === 'off' || trainingAcknowledged }); resource.refresh(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Training policy could not be saved.'); } finally { setTrainingSaving(false); } };
  const exportTraining = async () => { try { const result = await apiMutation<{ url: string }>('/api/settings/training/export', 'POST'); window.location.assign(result.url); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Corpus export could not be started.'); } };
  const deleteTraining = async () => { const confirmation = window.prompt(`Type ${data.workspace.slug} to permanently delete the retained training corpus`); if (!confirmation) return; try { await apiMutation('/api/settings/training/delete', 'POST', { confirm: confirmation }); resource.refresh(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Corpus deletion could not be queued.'); } };
  const deleteWorkspace = async () => { const confirmation = window.prompt(`Type ${data.workspace.slug} to permanently delete this workspace and all retained data`); if (!confirmation) return; try { await apiMutation('/api/settings/workspace/delete', 'POST', { confirm: confirmation }); await signOut(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Workspace deletion could not be queued.'); } };
  return <><PageHeader title="Settings" description="Workspace access, billing guardrails, and data controls." />
    <div className="settings-layout"><nav className="settings-nav"><a className="active" href="#workspace">Workspace</a><a href="#members">Members</a><a href="#training">Data & training</a><a href="#retention">Retention</a><a href="#billing">Billing</a></nav><div className="settings-content">
      <Card id="workspace"><SectionHeader title="Workspace" description="One workspace is linked to this GitHub App installation." /><label className="field"><span>Workspace name</span><input value={name} onChange={(event) => setName(event.target.value)} disabled={data.role !== 'admin'} /></label><label className="field"><span>Workspace identifier</span><div className="input-prefix"><span>workspace/</span><input value={slug} onChange={(event) => setSlug(event.target.value)} disabled={data.role !== 'admin'} /></div></label>{error && <div className="setup-error"><CircleAlert size={15} />{error}</div>}<div className="form-actions"><Button onClick={() => void saveWorkspace()} disabled={data.role !== 'admin'}>Save workspace</Button></div></Card>
      <Card id="members"><SectionHeader title="Members" description="Admins manage repositories, credentials, members, billing, and caps." action={data.role === 'admin' ? <Button size="small" onClick={() => void invite()}><Plus size={14} /> Add member</Button> : undefined} />{data.members.map((member) => <div className="member-row" key={member.id}><span className="user-avatar">{member.name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()}</span><div><strong>{member.name}</strong><span>{member.email}</span></div>{data.role === 'admin' ? <select value={member.role} onChange={(event) => void apiMutation(`/api/settings/members/${member.id}`, 'PATCH', { role: event.target.value }).then(resource.refresh).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : 'Role could not be changed.'))}><option value="admin">Admin</option><option value="member">Member</option></select> : <Badge tone={member.role === 'admin' ? 'purple' : 'neutral'}>{member.role}</Badge>}</div>)}</Card>
      <Card id="training"><SectionHeader title="Data & training" description="Review and comment bodies stay out of D1 and are collected only after explicit consent." action={<Badge tone={trainingMode === 'off' ? 'neutral' : 'green'}>{trainingMode === 'off' ? 'Disabled' : 'Opted in'}</Badge>} />
        <div className="training-mode-grid">{([['off', 'Operational storage only', 'Do not retain PR comments for model improvement.'], ['workspace_private', 'Workspace-private improvement', 'Build datasets usable only for your workspace.'], ['shared', 'Shared Juror training', 'Allow consented records to improve shared Juror models.']] as const).map(([value, label, description]) => <label className={cn('training-mode', trainingMode === value && 'selected')} key={value}><input type="radio" name="training-mode" value={value} checked={trainingMode === value} onChange={() => setTrainingMode(value)} disabled={data.role !== 'admin'} /><span><strong>{label}</strong><small>{description}</small></span></label>)}</div>
        {trainingMode !== 'off' && <div className="training-options"><div className="field-row"><label className="field"><span>Retention</span><select value={trainingRetention} onChange={(event) => setTrainingRetention(Number(event.target.value))} disabled={data.role !== 'admin'}><option value={90}>90 days</option><option value={365}>1 year</option><option value={730}>2 years</option></select></label><div className="corpus-stat"><span>Encrypted corpus</span><strong>{data.training.storedObjects} objects · {(data.training.storedBytes / 1024 / 1024).toFixed(1)} MB</strong></div></div>
          <div className="training-repositories"><span>Included repositories</span>{data.training.repositories.length ? data.training.repositories.map((repository) => <label key={repository.id}><input type="checkbox" checked={trainingRepositories.has(repository.id)} onChange={(event) => setTrainingRepositories((current) => { const next = new Set(current); if (event.target.checked) next.add(repository.id); else next.delete(repository.id); return next; })} disabled={data.role !== 'admin'} /><code>{repository.fullName}</code></label>) : <small>Connect a repository before enabling collection.</small>}</div>
          <label className="check-row"><input type="checkbox" checked={includePrBody} onChange={(event) => setIncludePrBody(event.target.checked)} disabled={data.role !== 'admin'} /><span><strong>Include PR descriptions</strong><small>Off by default. Comments and review bodies remain included.</small></span></label>
          <label className="check-row"><input type="checkbox" checked={includePaths} onChange={(event) => setIncludePaths(event.target.checked)} disabled={data.role !== 'admin'} /><span><strong>Include raw file paths</strong><small>Off by default. A workspace-scoped path hash is retained instead.</small></span></label>
          <label className="consent-row"><input type="checkbox" checked={trainingAcknowledged} onChange={(event) => setTrainingAcknowledged(event.target.checked)} disabled={data.role !== 'admin'} /><span>I authorize this use under consent policy <code>{data.training.consentVersion}</code>. I can export or delete it later.</span></label>
        </div>}
        {data.training.latestJob && <div className="notice compact-callout"><RefreshCw size={15} /><div><strong>Latest corpus deletion: {data.training.latestJob.status}</strong><p>{data.training.latestJob.error ?? `${data.training.latestJob.objectCount} objects removed.`}</p></div></div>}
        <div className="form-actions split-actions"><div><Button variant="secondary" onClick={() => void exportTraining()} disabled={!data.training.storedObjects}>Export JSONL</Button><Button variant="danger" onClick={() => void deleteTraining()} disabled={!data.training.storedObjects}>Delete corpus</Button></div><Button onClick={() => void saveTraining()} disabled={data.role !== 'admin' || trainingSaving || (trainingMode !== 'off' && (!trainingAcknowledged || trainingRepositories.size === 0))}>{trainingSaving ? 'Saving…' : 'Save data policy'}</Button></div>
      </Card>
      <Card id="retention"><SectionHeader title="Data retention" description="Source checkouts, full patches, and raw model output are never persisted." /><div className="retention-grid"><div><span>Run reports</span><strong>365 days</strong><small>Sanitized, versioned JSON in private R2</small></div><div><span>QA evidence</span><strong>90 days</strong><small>Screenshots, traces, and videos</small></div><div><span>Evidence URLs</span><strong>5 minutes</strong><small>Authenticated and short-lived</small></div></div></Card>
      <Card className="danger-zone"><SectionHeader title="Delete workspace" description="Permanently remove the workspace, indexed records, reports, retained evidence, and training corpus." /><Button variant="danger" onClick={() => void deleteWorkspace()} disabled={data.role !== 'admin'}>Delete workspace</Button></Card>
    </div></div>
  </>;
}

export function SignInPage() {
  const readiness = useApiResource<ReadinessResponse>('/api/readiness', { ready: true, checks: { github: true, google: true, reviews: true, qa: true, billing: true, corpus: true, costs: true }, reviewPresets: { starter: true, fast: true, balanced: true, high: true, ultra: true } });
  const checks = readiness.data?.checks;
  const authorization = new URLSearchParams(window.location.search);
  const isOAuthConsent = Boolean(authorization.get('client_id') && authorization.get('sig'));
  const requestedScopes = (authorization.get('scope') ?? '').split(' ').filter(Boolean);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [consenting, setConsenting] = useState(false);
  const submitConsent = async (accept: boolean) => {
    setConsentError(null); setConsenting(true);
    try {
      const response = await fetch('/api/auth/oauth2/consent', {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accept, oauth_query: authorization.toString() }),
      });
      const result = await response.json() as { redirect_uri?: string; error_description?: string };
      if (!response.ok || !result.redirect_uri) throw new Error(response.status === 401 ? 'Sign in to continue authorizing this connection.' : result.error_description ?? 'The authorization request could not be completed.');
      window.location.assign(result.redirect_uri);
    } catch (error) {
      setConsentError(error instanceof Error ? error.message : 'The authorization request could not be completed.');
    } finally { setConsenting(false); }
  };
  const signInCallback = isOAuthConsent ? `${window.location.pathname}${window.location.search}` : undefined;
  return <div className="auth-page"><div className="auth-card"><div className="auth-brand"><img src="/mark.svg" alt="" /><span>Juror <b>Cloud</b></span></div><div className="auth-copy"><Badge tone="gold">{isOAuthConsent ? 'MCP connection' : 'Hosted companion'}</Badge><h1>{isOAuthConsent ? 'Authorize Juror Cloud' : 'Your AI review and QA inbox.'}</h1><p>{isOAuthConsent ? 'Allow this MCP client to inspect only the Juror Cloud workspaces you can already access. Starting a review still requires a separate preflight and explicit confirmation.' : 'Connect GitHub and see every actionable finding, live run, and cost receipt in one lean workspace.'}</p></div><div className="auth-actions">{isOAuthConsent && <><div className="notice compact-callout"><ShieldCheck size={15} /><div><strong>Requested access</strong><p>{requestedScopes.includes('juror.reviews.write') ? 'Inspect findings and request confirmed hosted review starts or reruns.' : 'Inspect concise workspace, repository, run, and finding summaries.'}</p></div></div>{consentError && <div className="setup-error"><CircleAlert size={15} />{consentError}</div>}<Button onClick={() => void submitConsent(true)} disabled={consenting}>{consenting ? 'Authorizing…' : 'Allow Juror access'}</Button><Button variant="secondary" onClick={() => void submitConsent(false)} disabled={consenting}>Deny</Button><div className="auth-separator"><span>Or sign in first</span></div></>}{checks && !checks.github && <div className="setup-error"><CircleAlert size={15} />GitHub sign-in is not configured by the operator.</div>}{checks && checks.github && (!checks.reviews || !checks.costs) && <div className="setup-error"><CircleAlert size={15} />Hosted execution setup is incomplete. Sign-in works, but new runs remain unavailable.</div>}<button className="oauth-button github-oauth" disabled={checks ? !checks.github : true} onClick={() => void signInWith('github', signInCallback)}><GitBranch size={18} />Continue with GitHub</button><button className="oauth-button" disabled={checks ? !checks.google : true} onClick={() => void signInWith('google', signInCallback)}><span className="google-g">G</span>Continue with Google</button><div className="auth-separator"><span>Secure sign in</span></div><p>By continuing, you agree to the <Link to="/terms">Terms</Link> and <Link to="/privacy">Privacy Policy</Link>.</p></div></div><div className="auth-aside"><div className="auth-grid" /><div className="auth-preview"><div className="preview-top"><LiveRunBadge label="Review running" /><span>juror-ai/console · #95</span></div><div className="preview-finding"><SeverityBadge severity="P1" /><div><strong>Retry path can create a duplicate charge</strong><p>2 of 3 models agree · verified</p></div></div><div className="preview-finding"><SeverityBadge severity="P2" /><div><strong>Session expiry leaves an empty shell</strong><p>QA reproduced 2 of 2 attempts</p></div></div><div className="preview-receipt"><span>Transparent run receipt</span><strong>$2.21</strong></div></div><div className="auth-quote"><ShieldCheck size={22} /><p>Source lives only inside an isolated runtime. Reports are sanitized before they reach the dashboard.</p></div></div></div>;
}

export function LegalPage({ kind }: { kind: 'terms' | 'privacy' }) {
  const privacy = kind === 'privacy';
  return <div className="legal-page"><header><Link className="auth-brand" to="/signin"><img src="/mark.svg" alt="" /><span>Juror <b>Cloud</b></span></Link><Link to="/signin">Back to sign in</Link></header><article><span className="eyebrow">Effective August 26, 2026</span><h1>{privacy ? 'Privacy Notice' : 'Terms of Service'}</h1>{privacy ? <>
    <p>Juror Cloud processes account identity, GitHub App installation metadata, selected repository metadata, run summaries, findings, billing records, and configured QA evidence to provide the hosted service.</p>
    <h2>Repository and model data</h2><p>Repository checkouts exist only inside a per-run isolated Sandbox and are destroyed after the run. Source checkouts, full patches, model scratch text, and chain-of-thought are not retained. Sanitized reports are retained for up to one year and QA evidence for up to 90 days.</p>
    <h2>Optional training corpus</h2><p>Training collection is disabled by default. After explicit administrator consent, selected review bodies and comments are redacted, pseudonymized, compressed, encrypted per workspace, and stored in private object storage—not D1. PR descriptions and raw paths are separate opt-ins. Administrators can export or delete the corpus in Settings.</p>
    <h2>Plugin and MCP access</h2><p>ChatGPT, Codex, and other MCP clients connect through OAuth 2.1 using the same Juror Cloud identity and workspace memberships. Tokens are resource-bound and short lived. The integration returns minimal review metadata; a retained finding body or claim is returned only for a specifically requested finding. It never returns raw diffs, source checkouts, full reports, screenshots, artifacts, provider credentials, or prompt text. OAuth consent, revocation, and five-minute confirmation records are retained only to secure the connection and prevent replay.</p>
    <h2>Providers and control</h2><p>Cloudflare supplies hosting, GitHub supplies repository events, configured AI providers process review material, and Stripe processes billing. We do not sell personal information. Workspace administrators control membership, repositories, retention, consent, export, deletion, and connected-client revocation. Directory analytics are aggregate and operational only; prompts, tool arguments, finding text, repository names, and secrets are not logged for analytics.</p>
  </> : <>
    <p>These terms cover the hosted Juror Cloud service. The open-source Juror software remains separately available under the MIT License.</p>
    <h2>Use of the service</h2><p>By connecting a repository, you confirm that you are authorized to permit its configured processing. Juror Cloud is an engineering aid, not a guarantee that software is correct, secure, or fit for a particular purpose. You may not use it unlawfully or to attack the service, providers, other tenants, or third parties.</p>
    <h2>Plugin, MCP, and billing</h2><p>The Plugin and MCP integration run hosted Juror Cloud only; they do not authorize arbitrary local repository access, raw GitHub access, workspace administration, or provider credentials. Starting or rerunning a review requires a current preflight, explicit user confirmation, and the platform confirmation for the write operation. Usage caps, trial credit, and billable outcomes are displayed before paid use. Abusive, unsafe, unpaid, or over-cap use may be suspended.</p>
    <h2>Availability and liability</h2><p>The hosted service is provided on an as-available basis without warranties to the maximum extent permitted by law. Indirect, special, consequential, and lost-profit damages are excluded where permitted. Direct liability is limited to fees paid during the preceding three months, except where prohibited.</p>
  </>}<p>Questions or private requests can use the security contact process in the <a href="https://github.com/Juror-AI/juror/blob/main/SECURITY.md">open-source repository</a>.</p></article></div>;
}

const onboardingSteps = ['Link GitHub', 'Install app', 'Choose repositories', 'Enable review'];
const reviewPresetIds: ReviewPresetId[] = ['starter', 'fast', 'balanced', 'high', 'ultra'];
export function OnboardingPage() {
  const [step, setStep] = useState(0);
  const [savingSetup, setSavingSetup] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [installationChoices, setInstallationChoices] = useState<GitHubInstallationChoice[]>([]);
  const [claimState, setClaimState] = useState<string | null>(null);
  const [loadingInstallations, setLoadingInstallations] = useState(false);
  const [repositories, setRepositories] = useState<RepositoryItem[]>([]);
  const [selectedRepositories, setSelectedRepositories] = useState<Set<string>>(new Set());
  const [preset, setPreset] = useState<ReviewPresetId>('fast');
  const [enabledCount, setEnabledCount] = useState(0);
  const readiness = useApiResource<ReadinessResponse>('/api/readiness', { ready: true, checks: { github: true, google: true, reviews: true, qa: true, billing: true, corpus: true, costs: true }, reviewPresets: { starter: true, fast: true, balanced: true, high: true, ultra: true } });
  const next = () => setStep(Math.min(onboardingSteps.length - 1, step + 1));
  const loadInstallationChoices = async () => {
    setLoadingInstallations(true); setSetupError(null);
    try {
      const response = await fetch('/api/onboarding/installations', { credentials: 'include' });
      const payload = await response.json() as { data?: OnboardingInstallationsResponse; error?: { message?: string } };
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? 'Could not load GitHub installations.');
      setInstallationChoices(payload.data.installations); setClaimState(payload.data.state);
    } catch (error) { setSetupError(error instanceof Error ? error.message : 'Could not load GitHub installations.'); }
    finally { setLoadingInstallations(false); }
  };
  const loadRepositories = async () => {
    const response = await fetch('/api/repositories', { credentials: 'include' });
    const payload = await response.json() as { data?: RepositoryItem[]; error?: { message?: string } };
    if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? 'Repositories are not ready yet.');
    setRepositories(payload.data);
    const alreadyEnabled = payload.data.filter((repository) => repository.reviewEnabled && !repository.hostedAutomationBlocked).map((repository) => repository.id);
    setSelectedRepositories(new Set(alreadyEnabled));
  };
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const installationId = Number(params.get('installation_id'));
    const state = params.get('state');
    if (!Number.isInteger(installationId) || !state) {
      fetch('/api/onboarding/status', { credentials: 'include' }).then(async (response) => {
        if (response.status === 401) { window.location.assign('/signin'); return; }
        if (!response.ok) throw new Error('Could not load onboarding state.');
        const result = await response.json() as { data: OnboardingStatusResponse };
        if (result.data.hasWorkspace) { await loadRepositories(); setStep(2); }
        else if (result.data.hasGithub) { setStep(1); await loadInstallationChoices(); }
      }).catch((error: unknown) => setSetupError(error instanceof Error ? error.message : 'Could not load onboarding state.'));
      return;
    }
    setStep(1);
    apiMutation('/api/onboarding/claim-installation', 'POST', { installationId, state })
      .then(async () => { await loadRepositories(); setStep(2); window.history.replaceState({}, '', '/onboarding'); })
      .catch((error: unknown) => setSetupError(error instanceof Error ? error.message : 'Could not claim the installation.'));
  }, []);
  useEffect(() => {
    const available = reviewPresetIds.find((candidate) => readiness.data?.reviewPresets[candidate]);
    if (available && readiness.data && !readiness.data.reviewPresets[preset]) setPreset(available);
  }, [readiness.data, preset]);
  const connectGitHub = async () => {
    setSavingSetup(true); setSetupError(null);
    try {
      const result = await linkGitHub();
      if (result.error) throw new Error(result.error.message ?? 'Could not link the GitHub account. Try again.');
      next();
    } catch (failure) {
      setSetupError(failure instanceof Error ? failure.message : 'Could not link the GitHub account. Try again.');
    } finally {
      setSavingSetup(false);
    }
  };
  const installApp = async () => {
    try {
      const result = await fetch('/api/github/install-url', { credentials: 'include' }).then((response) => response.json()) as { data?: { url: string }; error?: { message: string } };
      if (!result.data?.url) throw new Error(result.error?.message ?? 'GitHub App installation is unavailable.');
      window.location.assign(result.data.url);
    } catch (error) { setSetupError(error instanceof Error ? error.message : 'Could not start installation.'); }
  };
  const claimExisting = async (installation: GitHubInstallationChoice) => {
    if (!claimState) return;
    setSavingSetup(true); setSetupError(null);
    try {
      await apiMutation('/api/onboarding/claim-installation', 'POST', { installationId: installation.id, state: claimState });
      await loadRepositories(); setStep(2);
    } catch (failure) { setSetupError(failure instanceof Error ? failure.message : 'Could not use this installation.'); }
    finally { setSavingSetup(false); }
  };
  const completeSetup = async () => {
    setSavingSetup(true); setSetupError(null);
    try {
      if (selectedRepositories.size === 0) throw new Error('Choose at least one repository to continue.');
      if (!readiness.data?.reviewPresets[preset]) throw new Error('Hosted review providers are not configured yet. Ask the operator to finish setup.');
      const mutations = repositorySetupMutations(repositories, selectedRepositories, preset);
      const results = await Promise.allSettled(mutations.map((mutation) => apiMutation(`/api/repositories/${mutation.id}`, 'PATCH', mutation.body)));
      const rejected = results.find((result) => result.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
      setEnabledCount(selectedRepositories.size);
      next();
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : 'Hosted review settings could not be saved.';
      try {
        await loadRepositories();
        setSetupError(`${message} Repository choices were refreshed to match the saved state.`);
      } catch {
        setSetupError(`${message} Refresh the page to confirm which repositories were saved.`);
      }
    }
    finally { setSavingSetup(false); }
  };
  const toggleRepository = (repositoryId: string, checked: boolean) => setSelectedRepositories((current) => { const nextSelection = new Set(current); if (checked) nextSelection.add(repositoryId); else nextSelection.delete(repositoryId); return nextSelection; });
  const runnablePreset = Boolean(readiness.data?.reviewPresets[preset]);
  return <div className="onboarding-page"><header className="onboarding-top"><div className="auth-brand"><img src="/mark.svg" alt="" /><span>Juror <b>Cloud</b></span></div><span>Setting up <strong>Juror AI</strong></span><button onClick={() => void signOut()}>Sign out</button></header><div className="onboarding-shell"><aside><span className="eyebrow">Workspace setup</span><h1>Connect your first repository</h1><p>Most teams finish in under three minutes.</p><ol>{onboardingSteps.map((label, index) => <li className={cn(index === step && 'active', index < step && 'done')} key={label}><i>{index < step ? <Check size={13} /> : index + 1}</i><span>{label}</span></li>)}</ol><div className="trial-promise"><Sparkles size={17} /><div><strong>$10 trial included</strong><p>No card required. Granted once per installation.</p></div></div></aside><main>
    {step === 0 && <div className="onboarding-card"><Badge tone="purple">Step 1 of 4</Badge><h2>Link your GitHub identity</h2><p>Google signed you in. Link GitHub so Juror can associate you with an App installation.</p>{setupError && <div className="setup-error"><CircleAlert size={15} />{setupError}</div>}<button className="oauth-button github-oauth" disabled={savingSetup} onClick={() => void connectGitHub()}><GitBranch size={18} />{savingSetup ? 'Linking…' : 'Link GitHub account'}</button><div className="permission-note"><KeyRound size={16} /><div><strong>Account permission</strong><p>Email addresses: read. Repository access is requested separately when you install the App.</p></div></div></div>}
    {step === 1 && <div className="onboarding-card"><Badge tone="purple">Step 2 of 4</Badge><h2>Connect the Juror GitHub App</h2><p>Repository access stays in GitHub. An existing installation can be reused without changing its permissions.</p>{setupError && <div className="warning-callout compact-callout"><CircleAlert size={16} /><div><strong>Setup needs attention</strong><p>{setupError}</p></div></div>}{loadingInstallations && <p className="onboarding-status" role="status">Checking GitHub installations…</p>}{installationChoices.length > 0 && <div className="installation-list">{installationChoices.map((installation) => <div className="installation-choice" key={installation.id}><div><strong>{installation.accountLogin}</strong><span>{installation.repositories.length} selected {installation.repositories.length === 1 ? 'repository' : 'repositories'}</span></div><Button size="small" onClick={() => void claimExisting(installation)} disabled={savingSetup || installation.repositories.length === 0}>{savingSetup ? 'Connecting…' : 'Use installation'}</Button></div>)}</div>}<div className="permission-list"><div><Check size={14} /><span>Metadata and contents</span><Badge>Read</Badge></div><div><Check size={14} /><span>Pull requests</span><Badge tone="purple">Read & write</Badge></div><div><Check size={14} /><span>Checks</span><Badge tone="purple">Write</Badge></div></div><Button variant={installationChoices.length ? 'secondary' : 'primary'} onClick={() => void installApp()}><GitBranch size={15} />{installationChoices.length ? 'Install or change access' : 'Install GitHub App'} <ExternalLink size={13} /></Button></div>}
    {step === 2 && <div className="onboarding-card wide-onboarding"><Badge tone="gold">Explicit review access</Badge><h2>Choose repositories for automated review</h2><p>The App can access the repositories below. Only checked repositories will receive automated reviews.</p>{repositories.length > 0 ? <div className="repository-picker">{repositories.map((repository) => <label key={repository.id}><input type="checkbox" checked={selectedRepositories.has(repository.id)} disabled={repository.connectionStatus === 'suspended'} onChange={(event) => toggleRepository(repository.id, event.target.checked)} /><span><strong>{repository.fullName}</strong><small>{repository.private ? 'Private' : 'Public'} · {repository.defaultBranch}</small></span>{repository.hostedAutomationBlocked && <Badge tone="gold">Workflow check</Badge>}</label>)}</div> : <div className="setup-error"><CircleAlert size={15} />No repositories are selected in this GitHub installation. Change access on GitHub and return here.</div>}{repositories.some((repository) => repository.hostedAutomationBlocked) && <div className="warning-callout compact-callout"><CircleAlert size={16} /><div><strong>Some repositories need a workflow check</strong><p>Remove any existing Juror workflows before selecting them. Juror rechecks selected repositories before enabling Cloud.</p></div></div>}<label className="field onboarding-preset"><span>Review preset</span><select value={preset} onChange={(event) => setPreset(event.target.value as ReviewPresetId)}>{reviewPresetIds.map((candidate) => <option key={candidate} value={candidate} disabled={!readiness.data?.reviewPresets[candidate]}>{candidate}{readiness.data && !readiness.data.reviewPresets[candidate] ? ' (unavailable)' : ''}</option>)}</select></label>{!runnablePreset && <div className="setup-error"><CircleAlert size={15} />Hosted execution is not configured for any review preset yet. An operator must add the required model-provider credentials.</div>}{setupError && <div className="setup-error"><CircleAlert size={15} />{setupError}</div>}<Button onClick={() => void completeSetup()} disabled={savingSetup || selectedRepositories.size === 0 || !runnablePreset}>{savingSetup ? 'Saving…' : `Enable reviews for ${selectedRepositories.size}`} <ArrowRight size={14} /></Button></div>}
    {step === 3 && <div className="onboarding-card"><div className="success-mark"><Check size={24} /></div><h2>Automated reviews are ready</h2><p>{`Juror Cloud will review new pull requests in ${enabledCount} selected ${enabledCount === 1 ? 'repository' : 'repositories'}. Historical pull requests are not backfilled.`}</p><div className="defaults-card"><div><span>Repositories</span><strong>{selectedRepositories.size}</strong></div><div><span>Preset</span><strong>{preset}</strong></div><div><span>Publish</span><strong>all</strong></div><div><span>Post-merge QA</span><strong>Off until setup</strong></div></div><div className="trial-balance"><div><span>Trial balance</span><strong>$10.00</strong></div><p>No payment method required. Billing pauses when the balance reaches zero.</p></div><Link className="button button-primary button-default" to="/overview">Open workspace <ArrowRight size={14} /></Link></div>}
  </main></div></div>;
}
