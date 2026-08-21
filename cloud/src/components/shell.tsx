import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity, ChevronDown, CircleDollarSign, Command, GitBranch, LayoutDashboard,
  Menu, Search, Settings, ShieldCheck, Sparkles, X,
} from 'lucide-react';
import type { ShellContextResponse } from '../../shared/api';
import { repositories, workspace } from '../lib/demo';
import { useApiResource } from '../lib/api';
import { signOut } from '../lib/auth';
import { cn } from '../lib/utils';
import { LiveRunBadge } from './eldora';
import { Badge, Button } from './ui';

const primaryNavigation = [
  { to: '/overview', label: 'Overview', icon: LayoutDashboard },
  { to: '/findings', label: 'Findings', icon: ShieldCheck },
  { to: '/runs', label: 'Runs', icon: Activity },
  { to: '/repositories', label: 'Repositories', icon: GitBranch },
  { to: '/usage', label: 'Usage', icon: CircleDollarSign },
];

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const dialog = useRef<HTMLDivElement>(null);
  const commands = useMemo(() => [
    ['Go to findings', '/findings', 'bugs issues triage'], ['Open live runs', '/runs', 'review qa activity'], ['Connect repository', '/repositories', 'github app setup'], ['Open usage', '/usage', 'billing cost spend'], ['Workspace settings', '/settings', 'members data training'],
  ], []);
  const matches = commands.filter(([label, , keywords]) => `${label} ${keywords}`.toLowerCase().includes(query.trim().toLowerCase()));
  useEffect(() => { if (open) { setQuery(''); setActive(0); } }, [open]);
  useEffect(() => { setActive(0); }, [query]);
  if (!open) return null;
  const choose = (path: string) => { navigate(path); onClose(); };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    if (event.key === 'ArrowDown' && matches.length) { event.preventDefault(); setActive((index) => (index + 1) % matches.length); }
    if (event.key === 'ArrowUp' && matches.length) { event.preventDefault(); setActive((index) => (index - 1 + matches.length) % matches.length); }
    if (event.key === 'Enter' && matches[active]) { event.preventDefault(); choose(matches[active][1]); }
    if (event.key === 'Tab' && dialog.current) {
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>('input,button')];
      if (!focusable.length) return;
      const current = focusable.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey ? (current - 1 + focusable.length) % focusable.length : (current + 1) % focusable.length;
      event.preventDefault(); focusable[next]?.focus();
    }
  };
  return <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
    <div ref={dialog} className="command-dialog" role="dialog" aria-modal="true" aria-label="Command menu" onMouseDown={(event) => event.stopPropagation()} onKeyDown={onKeyDown}>
      <div className="command-input"><Search size={17} /><input autoFocus aria-label="Search pages and actions" placeholder="Search pages and actions…" value={query} onChange={(event) => setQuery(event.target.value)} aria-controls="command-results" aria-activedescendant={matches[active] ? `command-${matches[active][1].slice(1)}` : undefined} /><kbd>esc</kbd></div>
      <div className="command-group" id="command-results" role="listbox"><span>Quick actions</span>{matches.map(([label, path], index) => <button id={`command-${path.slice(1)}`} role="option" aria-selected={index === active} className={index === active ? 'active' : ''} key={path} onMouseEnter={() => setActive(index)} onClick={() => choose(path)}><Command size={15} />{label}<kbd>↵</kbd></button>)}{matches.length === 0 && <p className="command-empty">No matching action</p>}</div>
    </div>
  </div>;
}

export function AppShell() {
  const [commandOpen, setCommandOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const resource = useApiResource<ShellContextResponse>('/api/context', { workspace, repositories, criticalOpen: 4, liveRuns: 1, qaEnabled: 1 });
  const context = resource.data ?? { workspace, repositories: [], criticalOpen: 0, liveRuns: 0, qaEnabled: 0 };
  const initials = context.workspace.name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  const pageTitle = primaryNavigation.find(({ to }) => location.pathname.startsWith(to))?.label
    ?? (location.pathname.startsWith('/settings') ? 'Settings' : 'Overview');
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setCommandOpen(true); }
      if (event.key === 'Escape') { setCommandOpen(false); setMobileOpen(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return <div className="app-frame">
    <aside className={cn('sidebar', mobileOpen && 'sidebar-open')}>
      <div className="workspace-switch">
        <span className="workspace-avatar">J</span>
        <span className="workspace-name"><strong>{context.workspace.name}</strong><small>Cloud</small></span>
        <ChevronDown size={14} />
        <button className="sidebar-close" onClick={() => setMobileOpen(false)} aria-label="Close navigation"><X size={18} /></button>
      </div>
      <button className="sidebar-search" onClick={() => setCommandOpen(true)}><Search size={16} /><span>Find</span><kbd>F</kbd></button>
      <nav aria-label="Primary navigation">
        {primaryNavigation.map(({ to, label, icon: Icon }) => <NavLink to={to} key={to} onClick={() => setMobileOpen(false)} className={({ isActive }) => cn('nav-item', isActive && 'active')}>
          <Icon size={17} /> <span>{label}</span>{to === '/findings' && context.criticalOpen > 0 && <em>{context.criticalOpen}</em>}
        </NavLink>)}
      </nav>
      <div className="sidebar-foot">
        <div className="trial-card"><div><Sparkles size={15} /><span>Juror Agent</span><button type="button" aria-label="Dismiss">×</button></div><p>Review is live. QA is enabled on {context.qaEnabled} of {context.repositories.length} repositories.</p><NavLink to="/repositories" className="trial-action">Configure repositories</NavLink></div>
        <NavLink to="/settings" className={({ isActive }) => cn('nav-item', isActive && 'active')}><Settings size={17} /><span>Settings</span></NavLink>
        <a className="nav-item" href="https://github.com/Juror-AI/juror" target="_blank" rel="noreferrer"><GitBranch size={17} /><span>Open source</span></a>
      </div>
    </aside>
    {mobileOpen && <div className="mobile-overlay" onClick={() => setMobileOpen(false)} />}
    <section className="main-column">
      <header className="topbar">
        <Button className="mobile-menu" variant="ghost" size="icon" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu size={19} /></Button>
        <label className="repo-switch"><GitBranch size={15} /><select aria-label="Repository filter" defaultValue="all"><option value="all">All repositories</option>{context.repositories.map((repository) => <option value={repository.id} key={repository.id}>{repository.fullName}</option>)}</select><ChevronDown size={14} /></label>
        <div className="topbar-title">{pageTitle}</div>
        <div className="topbar-actions">
          {context.liveRuns > 0 && <LiveRunBadge label={`${context.liveRuns} live`} />}
          <span className="agent-label"><Sparkles size={14} /> Agent</span>
          <button className="user-menu" aria-label="Sign out" title="Sign out" onClick={() => void signOut()}><span>{initials}</span><ChevronDown size={13} /></button>
        </div>
      </header>
      <main className="content"><Outlet /></main>
    </section>
    <CommandPalette open={commandOpen} onClose={() => setCommandOpen(false)} />
  </div>;
}
