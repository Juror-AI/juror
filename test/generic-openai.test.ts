import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runGenericOpenAI } from '../src/harness/generic-openai.js';
import type { RunContext } from '../src/types.js';

const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function context(maxTurns: number): RunContext {
  const repoDir = mkdtempSync(join(tmpdir(), 'juror-generic-repo-'));
  dirs.push(repoDir);
  const scratchDir = join(repoDir, '.juror-run', 'generic');
  mkdirSync(scratchDir, { recursive: true });
  return {
    repoDir,
    scratchDir,
    findingsPath: join(scratchDir, 'findings.json'),
    promptPath: join(scratchDir, 'prompt.md'),
    prompt: 'review this',
    model: 'test-model',
    baseUrl: 'https://example.test/v1',
    args: {},
    env: { TEST_API_KEY: 'test-only' },
    timeoutMs: 60_000,
    budgetUsd: null,
    maxTurns,
  };
}

const REPORT = {
  merge_confidence: 5,
  confidence_reason: 'No defects found.',
  summary: 'Reviewed the change.',
  highlights: [],
  file_overviews: [],
  sequence_diagram: null,
  async_contracts: [],
  findings: [],
};

function completion(message: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('generic OpenAI turn budget', () => {
  it('continues past one tool round when zero disables the step cap', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        completion({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(completion({ role: 'assistant', content: JSON.stringify(REPORT) }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runGenericOpenAI(context(0));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.turns).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.report).toEqual(REPORT);
  });

  it('still honours an explicitly configured positive cap', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        completion({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) },
            },
          ],
        }),
      ),
    );

    const result = await runGenericOpenAI(context(1));

    expect(result.turns).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.diagnostics).toContain(
      'generic-openai stopped at the 1-turn limit with tool calls pending',
    );
  });
});
