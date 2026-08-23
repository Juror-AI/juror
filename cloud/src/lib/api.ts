import { useEffect, useState } from 'react';
import type { ApiEnvelope } from '../../shared/api';

export interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useApiResource<T>(path: string, developmentFallback: T): ApiState<T> {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<Omit<ApiState<T>, 'refresh'>>({
    data: import.meta.env.DEV ? developmentFallback : null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: null }));
    fetch(path, { credentials: 'include', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 401 ? 'Sign in to continue.' : `Request failed (${response.status})`);
        return response.json() as Promise<ApiEnvelope<T>>;
      })
      .then((result) => setState({ data: result.data, loading: false, error: null }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState((current) => ({ data: import.meta.env.DEV ? current.data ?? developmentFallback : null, loading: false, error: error instanceof Error ? error.message : 'Request failed' }));
      });
    return () => controller.abort();
  }, [path, revision]);

  return { ...state, refresh: () => setRevision((value) => value + 1) };
}

export async function apiMutation<T>(path: string, method: 'POST' | 'PATCH', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'include',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const isJson = response.headers.get('content-type')?.includes('application/json');
  const payload = isJson ? await response.json() as ApiEnvelope<T> & { error?: { message?: string } } : null;
  if (!response.ok) {
    if (response.status === 401) throw new Error('Sign in to continue.');
    throw new Error(payload?.error?.message ?? `Request failed (${response.status})`);
  }
  if (!payload) throw new Error('The server returned an invalid response.');
  return payload.data;
}
