// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsagePage } from '../src/pages';
import { usage } from '../src/lib/demo';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

describe('usage controls', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders a server error when a monthly cap change is rejected', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('0.50');
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = typeof input === 'string' ? input : input instanceof Request ? new URL(input.url).pathname : input.pathname;
      if (path === '/api/usage' && !init?.method) return json({ data: usage });
      if (path === '/api/usage/cap' && init?.method === 'PATCH') return json({ error: { message: 'Monthly cap must be at least $1.' } }, 400);
      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${path}`);
    }));

    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Change monthly cap' }));

    expect(await screen.findByText('Monthly cap must be at least $1.')).toBeInTheDocument();
  });
});
