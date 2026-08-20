import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { runQaAgent } from '../src/qa/agent.js';

describe('QA Codex process isolation', () => {
  it('replaces caller-controlled NODE_OPTIONS with fixed supported proxy settings', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'juror-qa-agent-'));
    const repoDir = path.join(root, 'repo');
    const scratchDir = path.join(root, 'scratch');
    const fakeCodex = path.join(root, 'fake-codex.mjs');
    const preload = path.join(root, 'preload.cjs');
    const preloadCanary = path.join(root, 'preload-ran');

    try {
      await mkdir(repoDir);
      await mkdir(scratchDir);
      await writeFile(
        preload,
        `require('node:fs').writeFileSync(${JSON.stringify(preloadCanary)}, 'executed')\n`,
        'utf8',
      );
      await writeFile(
        fakeCodex,
        [
          '#!/usr/bin/env node',
          "const fs = await import('node:fs');",
          "const path = await import('node:path');",
          "fs.writeFileSync(path.join(process.cwd(), 'child-env.json'), JSON.stringify({",
          '  nodeOptions: process.env.NODE_OPTIONS,',
          '  nodeUseEnvProxy: process.env.NODE_USE_ENV_PROXY,',
          '}));',
          "process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: {} }) + '\\n');",
          '',
        ].join('\n'),
        'utf8',
      );
      await chmod(fakeCodex, 0o755);

      const result = await runQaAgent({
        repoDir,
        scratchDir,
        socketPath: path.join(root, 'broker.sock'),
        model: 'gpt-test',
        reasoningEffort: 'low',
        prompt: 'test',
        timeoutMs: 10_000,
        env: {
          PATH: process.env.PATH,
          JUROR_CODEX_BIN: fakeCodex,
          JUROR_OPENAI_API_KEY: 'sk-test-qa-agent-key',
          HTTP_PROXY: 'http://127.0.0.1:8080',
          HTTPS_PROXY: 'http://127.0.0.1:8080',
          NODE_OPTIONS: `--require=${preload}`,
          NODE_USE_ENV_PROXY: 'attacker-controlled',
        },
      });

      expect(result.completed).toBe(true);
      const childEnv = JSON.parse(await readFile(path.join(scratchDir, 'child-env.json'), 'utf8')) as {
        nodeOptions?: string;
        nodeUseEnvProxy?: string;
      };
      expect(childEnv).toEqual({
        ...(process.allowedNodeEnvironmentFlags.has('--use-env-proxy')
          ? { nodeOptions: '--use-env-proxy' }
          : {}),
        nodeUseEnvProxy: '1',
      });
      await expect(readFile(preloadCanary, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      const config = await readFile(path.join(scratchDir, 'codex-home', 'config.toml'), 'utf8');
      if (process.allowedNodeEnvironmentFlags.has('--use-env-proxy')) {
        expect(config).toContain('NODE_OPTIONS = "--use-env-proxy"');
      } else {
        expect(config).not.toContain('NODE_OPTIONS =');
      }
      expect(config).toContain('NODE_USE_ENV_PROXY = "1"');
      expect(config).not.toContain(preload);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
