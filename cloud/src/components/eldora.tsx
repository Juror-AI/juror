import { Check, CircleAlert, Copy, ExternalLink } from 'lucide-react';
import type { FindingDetailResponse, RunStatus } from '../../shared/api';
import { cn } from '../lib/utils';
import { Badge, Button } from './ui';

/** Status-driven motion based on Eldora UI's animated badge pattern. */
export function LiveRunBadge({ label = 'Live' }: { label?: string }) {
  return <span className="live-badge"><span className="live-pulse" aria-hidden="true" />{label}</span>;
}

/** Shadcn-compatible GitHub inline comment presentation for on-demand diffs. */
export function GitHubInlineComments({ diff, title, body }: { diff: NonNullable<FindingDetailResponse['diff']>; title: string; body: string }) {
  return <div className="github-diff">
    <div className="diff-file-header"><span className="mono">{diff.newPath}</span><Button variant="ghost" size="small"><Copy size={13} /> Copy path</Button></div>
    <div className="diff-code" role="table" aria-label={`Diff for ${diff.newPath}`}>
      {diff.lines.map((line, index) => <div className={cn('diff-line', `diff-${line.kind}`)} role="row" key={`${line.oldLine}-${line.newLine}-${index}`}>
        <span role="cell" className="line-number">{line.oldLine ?? ''}</span><span role="cell" className="line-number">{line.newLine ?? ''}</span>
        <code role="cell"><span className="diff-prefix">{line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '−' : ' '}</span>{line.content}</code>
      </div>)}
      <div className="inline-comment">
        <div className="inline-comment-head"><img src="/mark.svg" alt="" /><strong>juror-cloud</strong><Badge tone="purple">AI review</Badge><span>now</span></div>
        <strong>{title}</strong><p>{body}</p>
      </div>
    </div>
  </div>;
}

/** Browser evidence frame adapted to the visual behavior of Eldora's Browser component. */
export function BrowserFrame({ url, imageUrl, caption }: { url: string; imageUrl: string; caption: string }) {
  return <figure className="browser-frame">
    <div className="browser-chrome"><div className="traffic-lights"><i /><i /><i /></div><div className="browser-address">{url}</div><ExternalLink size={14} /></div>
    <img src={imageUrl} alt={caption} />
    <figcaption><CircleAlert size={15} />{caption}</figcaption>
  </figure>;
}

/** Sanitized log surface; model scratch text and chain-of-thought never reach this component. */
export function TerminalLog({ rows }: { rows: Array<{ timestamp: string; level: 'info' | 'warn' | 'error'; message: string }> }) {
  return <div className="terminal">
    <div className="terminal-head"><div className="traffic-lights"><i /><i /><i /></div><span>sanitized output</span><Badge>read only</Badge></div>
    <div className="terminal-body">{rows.map((row, index) => <div className={cn('terminal-row', `terminal-${row.level}`)} key={index}>
      <span>{new Date(row.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
      <span>{row.level === 'info' ? <Check size={13} /> : <CircleAlert size={13} />}</span><code>{row.message}</code>
    </div>)}</div>
  </div>;
}

export function RunStatusDot({ status }: { status: RunStatus }) {
  return <span className={cn('run-dot', `run-dot-${status}`)} aria-label={status} />;
}
