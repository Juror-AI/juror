import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import type { FindingSource, RunStatus, Severity } from '../../shared/api';
import { cn } from '../lib/utils';

export function Button({ className, variant = 'primary', size = 'default', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'default' | 'small' | 'icon';
}) {
  return <button className={cn('button', `button-${variant}`, `button-${size}`, className)} {...props} />;
}

export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'purple' | 'cyan' | 'pink' | 'gold' | 'green' | 'red'; className?: string }) {
  return <span className={cn('badge', `badge-${tone}`, className)}>{children}</span>;
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <span className={cn('severity', `severity-${severity.toLowerCase()}`)}>{severity}</span>;
}

export function SourceBadge({ source }: { source: FindingSource }) {
  return <Badge tone={source === 'review' ? 'purple' : 'cyan'}>{source === 'review' ? 'Review' : 'QA'}</Badge>;
}

export function StatusBadge({ status }: { status: RunStatus | 'open' | 'resolved' | 'ignored' | 'healthy' | 'attention' | 'suspended' | 'paid' | 'void' }) {
  const tone = status === 'succeeded' || status === 'resolved' || status === 'healthy' || status === 'paid'
    ? 'green'
    : status === 'failed' || status === 'suspended'
      ? 'red'
      : status === 'warning' || status === 'blocked' || status === 'attention'
        ? 'gold'
        : status === 'running'
          ? 'purple'
          : 'neutral';
  return <Badge tone={tone}>{status.replace('_', ' ')}</Badge>;
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('card', className)} {...props} />;
}

export function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state">
    <div className="empty-icon">{icon}</div>
    <strong>{title}</strong>
    <p>{description}</p>
    {action}
  </div>;
}

export function SelectButton({ children, className }: { children: ReactNode; className?: string }) {
  return <button type="button" className={cn('select-button', className)}>{children}<ChevronDown size={14} aria-hidden="true" /></button>;
}

export function Toggle({ checked, label, description, disabled, onChange }: { checked: boolean; label: string; description?: string; disabled?: boolean; onChange?: (checked: boolean) => void }) {
  return <label className={cn('toggle-row', disabled && 'is-disabled')}>
    <span><strong>{label}</strong>{description && <small>{description}</small>}</span>
    <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange?.(!checked)} className={cn('toggle', checked && 'is-on')}><span /></button>
  </label>;
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return <header className="page-header">
    <div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description && <p>{description}</p>}</div>
    {actions && <div className="page-actions">{actions}</div>}
  </header>;
}
