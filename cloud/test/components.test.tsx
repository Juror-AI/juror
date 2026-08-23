import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { BrowserFrame, GitHubInlineComments, LiveRunBadge, TerminalLog } from '../src/components/eldora';

describe('meaningful Eldora surfaces', () => {
  it('renders an accessible live status and an inline diff', () => {
    expect(renderToStaticMarkup(<LiveRunBadge label="2 runs live" />)).toContain('2 runs live');
    const markup = renderToStaticMarkup(<GitHubInlineComments title="Unsafe retry" body="The retry duplicates work." diff={{ oldPath: 'src/a.ts', newPath: 'src/a.ts', oldStart: 1, newStart: 1, lines: [{ kind: 'addition', oldLine: null, newLine: 1, content: 'retry();' }] }} />);
    expect(markup).toContain('Diff for src/a.ts');
    expect(markup).toContain('Unsafe retry');
  });

  it('renders browser evidence and only supplied sanitized terminal events', () => {
    const browser = renderToStaticMarkup(<BrowserFrame url="https://staging.example.com" imageUrl="/evidence.png" caption="Attempt 1 failed" />);
    expect(browser).toContain('Attempt 1 failed');
    const terminal = renderToStaticMarkup(<TerminalLog rows={[{ timestamp: '2026-08-21T12:00:00.000Z', level: 'info', message: 'Checkout completed.' }]} />);
    expect(terminal).toContain('Checkout completed.');
    expect(terminal.toLowerCase()).not.toContain('chain-of-thought');
  });
});
