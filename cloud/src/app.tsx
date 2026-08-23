import { useEffect, useState } from 'react';
import { Navigate, Outlet, createBrowserRouter, RouterProvider } from 'react-router-dom';
import type { OnboardingStatusResponse } from '../shared/api';
import { AppShell } from './components/shell';
import {
  FindingDetailPage, FindingsPage, OnboardingPage, OverviewPage, RepositoriesPage, RunDetailPage, RunsPage,
  SettingsPage, SignInPage, UsagePage,
  LegalPage,
} from './pages';

function DashboardGate() {
  const [state, setState] = useState<'loading' | 'signed-out' | 'onboarding' | 'ready'>('loading');
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/onboarding/status', { credentials: 'include', signal: controller.signal }).then(async (response) => {
      if (response.status === 401) { setState('signed-out'); return; }
      if (!response.ok) throw new Error(`Session check failed (${response.status})`);
      const payload = await response.json() as { data: OnboardingStatusResponse };
      setState(payload.data.hasWorkspace ? 'ready' : 'onboarding');
    }).catch(() => { if (!controller.signal.aborted) setState('signed-out'); });
    return () => controller.abort();
  }, []);
  if (state === 'loading') return <div className="route-loading" role="status">Loading Juror Cloud…</div>;
  if (state === 'signed-out') return <Navigate to="/signin" replace />;
  if (state === 'onboarding') return <Navigate to="/onboarding" replace />;
  return <Outlet />;
}

const router = createBrowserRouter([
  { path: '/signin', element: <SignInPage /> },
  { path: '/terms', element: <LegalPage kind="terms" /> },
  { path: '/privacy', element: <LegalPage kind="privacy" /> },
  { path: '/onboarding', element: <OnboardingPage /> },
  {
    element: <DashboardGate />,
    children: [
      {
        element: <AppShell />,
        children: [
          { index: true, element: <Navigate to="/overview" replace /> },
          { path: '/overview', element: <OverviewPage /> },
          { path: '/findings', element: <FindingsPage /> },
          { path: '/findings/:findingId', element: <FindingDetailPage /> },
          { path: '/runs', element: <RunsPage /> },
          { path: '/runs/:runId', element: <RunDetailPage /> },
          { path: '/repositories', element: <RepositoriesPage /> },
          { path: '/usage', element: <UsagePage /> },
          { path: '/settings', element: <SettingsPage /> },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/overview" replace /> },
]);

export function App() {
  return <RouterProvider router={router} />;
}
