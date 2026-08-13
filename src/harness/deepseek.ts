/**
 * DeepSeek-native adapter — CodeWhale `exec --output-format stream-json`.
 *
 * DeepSeek-TUI was renamed to CodeWhale in v0.9.0. The CLI remains the native
 * DeepSeek agent runtime and, unlike a generic OpenAI loop, preserves DeepSeek's
 * interleaved reasoning content across tool calls.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import type {
  CanonicalUsage,
  Harness,
  HarnessCommand,
  HarnessIO,
  HarnessLocation,
  HarnessResult,
  ModelReport,
  RunContext,
} from '../types.js';
import { parseModelReport, readReportFile } from '../report.js';
import { redact } from '../util/log.js';
import { run, which } from '../util/proc.js';

const MINIMUM_VERSION = [0, 9, 7] as const;
const MAX_STDERR_DIAGNOSTICS = 20;
const READ_ONLY_TOOLS = 'read,list_dir,grep_files,file_search';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function versionParts(version: string): number[] {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\D|$)/.exec(version);
  return match ? match.slice(1, 4).map(Number) : [];
}

function versionBelowMinimum(version: string): boolean {
  const parts = versionParts(version);
  if (parts.length !== 3) return false;
  for (let index = 0; index < MINIMUM_VERSION.length; index++) {
    const actual = parts[index] ?? 0;
    const minimum = MINIMUM_VERSION[index] ?? 0;
    if (actual !== minimum) return actual < minimum;
  }
  return false;
}

function runtimeRoot(ctx: RunContext): string {
  const key = createHash('sha256').update(resolve(ctx.scratchDir)).digest('hex').slice(0, 16);
  return join(tmpdir(), 'juror-deepseek', key);
}

function physical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function readReportSafely(path: string): { report: ModelReport | null; problems: string[] } {
  try {
    return readReportFile(path);
  } catch (error) {
    return { report: null, problems: [error instanceof Error ? error.message : String(error)] };
  }
}

function parseTextSafely(text: string): { report: ModelReport | null; problems: string[] } {
  try {
    return parseModelReport(text);
  } catch (error) {
    return { report: null, problems: [error instanceof Error ? error.message : String(error)] };
  }
}

function parseJsonl(text: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) events.push(value);
    } catch {
      // CodeWhale may emit a bounded diagnostic outside its JSON stream on startup.
    }
  }
  return events;
}

function reasoningEffort(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const effort = value.trim().toLowerCase();
  return ['off', 'low', 'medium', 'high', 'max'].includes(effort) ? effort : null;
}

export const deepseekHarness = {
  id: 'deepseek',
  label: 'DeepSeek',

  async locate(env?: Record<string, string | undefined>): Promise<HarnessLocation> {
    const binPath = await which('codewhale');
    if (!binPath) {
      throw new Error(
        'codewhale not found on PATH — install it (npm i -g codewhale) or disable the DeepSeek model in .juror.yml',
      );
    }
    const io = await run([binPath, '--version'], { timeoutMs: 15_000, ...(env ? { env } : {}) });
    const version = (io.stdout.trim() || io.stderr.trim()).split('\n')[0]?.trim() ?? '';
    const warnings: string[] = [];
    if (io.exitCode !== 0) warnings.push(`codewhale --version exited ${io.exitCode}`);
    if (!version) warnings.push('codewhale reported no version string');
    else if (versionBelowMinimum(version)) {
      warnings.push(`codewhale ${version} predates the tested 0.9.7 stream and isolation contract`);
    }
    return { binPath, version, warnings };
  },

  command(ctx: RunContext): HarnessCommand {
    const root = runtimeRoot(ctx);
    rmSync(root, { recursive: true, force: true });
    const home = join(root, 'home');
    const codewhaleHome = join(root, 'codewhale-home');
    const emptySkills = join(root, 'skills');
    const emptyTools = join(root, 'tools');
    const workspace = join(root, 'workspace');
    const mcpPath = join(root, 'mcp.json');
    const configPath = join(root, 'config.toml');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(codewhaleHome, { recursive: true, mode: 0o700 });
    mkdirSync(emptySkills, { recursive: true, mode: 0o700 });
    mkdirSync(emptyTools, { recursive: true, mode: 0o700 });
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(workspace, 'README.md'),
      'Juror isolated review workspace. The reviewed source is an explicit read-only path.\n',
      { encoding: 'utf8', mode: 0o600 },
    );
    writeFileSync(mcpPath, '{"mcpServers":{}}\n', { encoding: 'utf8', mode: 0o600 });
    writeFileSync(
      configPath,
      [
        'provider = "fireworks"',
        'telemetry = false',
        'allow_shell = false',
        // `--auto` couples automatic approvals to host-wide trust in CodeWhale 0.9.7.
        // Auto-review approves safe reads while leaving `trust_mode` false.
        'approval_policy = "auto"',
        'sandbox_mode = "read-only"',
        'max_subagents = 1',
        `skills_dir = ${JSON.stringify(emptySkills)}`,
        `mcp_config_path = ${JSON.stringify(mcpPath)}`,
        'instructions = []',
        '',
        '[skills]',
        'scan_codewhale_only = true',
        '',
        '[tools]',
        'always_load = ["list_dir", "file_search", "grep_files"]',
        `plugin_dir = ${JSON.stringify(emptyTools)}`,
        '',
      ].join('\n'),
      { encoding: 'utf8', mode: 0o600 },
    );

    // CodeWhale always discovers project instructions from its workspace, even with
    // --no-project-config. Start in this trusted empty directory, then grant its path guard
    // exactly the sealed checkout and Juror scratch. This also keeps trust_mode false, so an
    // injected absolute path outside those two roots is refused by native file tools.
    writeFileSync(
      join(codewhaleHome, 'workspace-trust.json'),
      `${JSON.stringify({
        workspaces: {
          [physical(workspace)]: [physical(ctx.repoDir), physical(ctx.scratchDir)].sort(),
        },
      })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );

    const prompt =
      `Read ${resolve(ctx.promptPath)} completely with the read tool and follow it exactly. ` +
      `The reviewed repository is ${resolve(ctx.repoDir)}. ` +
      'You have no write tools; return the requested strict JSON as your final answer.';
    const argv = [
      'codewhale',
      '--config',
      configPath,
      '--no-project-config',
      '--skip-onboarding',
      '--provider',
      'fireworks',
      '--model',
      ctx.model,
      '-C',
      physical(workspace),
      'exec',
      '--sandbox',
      'read-only',
      '--output-format',
      'stream-json',
      '--allowed-tools',
      READ_ONLY_TOOLS,
    ];
    const effort = reasoningEffort(ctx.args['reasoning_effort']);
    if (effort) argv.push('--reasoning-effort', effort);
    if (ctx.maxTurns > 0) argv.push('--max-turns', String(ctx.maxTurns));
    argv.push(prompt);

    return {
      argv,
      env: {
        ...ctx.env,
        HOME: home,
        CODEWHALE_HOME: codewhaleHome,
        CODEWHALE_CONFIG_PATH: configPath,
        CODEWHALE_ALLOW_SHELL: 'false',
        DEEPSEEK_ALLOW_SHELL: 'false',
        CODEWHALE_APPROVAL_POLICY: 'auto',
        DEEPSEEK_APPROVAL_POLICY: 'auto',
        CODEWHALE_SANDBOX_MODE: 'read-only',
        DEEPSEEK_SANDBOX_MODE: 'read-only',
        CODEWHALE_YOLO: 'false',
        DEEPSEEK_YOLO: 'false',
        CODEWHALE_TELEMETRY: '0',
        CODEWHALE_TELEMETRY_ENDPOINT: '',
        CODEWHALE_NO_UPDATE_CHECK: '1',
        NO_UPDATE_NOTIFIER: '1',
        ...(ctx.baseUrl ? { CODEWHALE_BASE_URL: ctx.baseUrl } : {}),
      },
      stdin: '',
      cwd: physical(workspace),
    };
  },

  parse(io: HarnessIO, ctx: RunContext): HarnessResult {
    const events = parseJsonl(io.stdout);
    const diagnostics = io.stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, MAX_STDERR_DIAGNOSTICS)
      .map(redact);
    const stderrLines = io.stderr.split(/\r?\n/).filter((line) => line.trim()).length;
    if (stderrLines > MAX_STDERR_DIAGNOSTICS) {
      diagnostics.push(`… ${stderrLines - MAX_STDERR_DIAGNOSTICS} more stderr line(s)`);
    }
    if (events.length === 0) diagnostics.push('codewhale emitted no stream-json events');

    const text = events
      .filter((event) => event['type'] === 'content' && typeof event['content'] === 'string')
      .map((event) => String(event['content']))
      .join('');
    const usage: CanonicalUsage = { uncachedIn: 0, cacheRead: 0, cacheWrite: 0, out: 0 };
    let turns = 0;
    let terminalStatus = '';
    let resolvedModel: string | undefined;
    let sawError = false;

    for (const event of events) {
      if (event['type'] === 'error') {
        sawError = true;
        if (typeof event['error'] === 'string') diagnostics.push(redact(event['error']));
      }
      if (event['type'] === 'metadata' && isRecord(event['meta'])) {
        const meta = event['meta'];
        terminalStatus = typeof meta['status'] === 'string' ? meta['status'] : terminalStatus;
        resolvedModel = typeof meta['model'] === 'string' ? meta['model'] : resolvedModel;
      }
      if (event['type'] !== 'turn_usage') continue;
      const input = nonNegative(event['input_tokens']);
      const output = nonNegative(event['output_tokens']);
      if (input === null || output === null) {
        diagnostics.push('ignored malformed CodeWhale turn_usage event');
        continue;
      }
      const cacheRead = nonNegative(event['prompt_cache_hit_tokens']) ?? 0;
      const cacheWrite = nonNegative(event['prompt_cache_write_tokens']) ?? 0;
      const cacheMiss = nonNegative(event['prompt_cache_miss_tokens']);
      usage.uncachedIn += cacheMiss ?? Math.max(0, input - cacheRead);
      usage.cacheRead += cacheRead;
      usage.cacheWrite += cacheWrite;
      usage.out += output;
      turns += 1;
    }

    let report: ModelReport | null = null;
    if (basename(ctx.findingsPath) === 'findings.json') {
      const file = readReportSafely(ctx.findingsPath);
      report = file.report;
      diagnostics.push(...file.problems);
      if (!report && text.trim()) {
        const parsed = parseTextSafely(text);
        diagnostics.push(...parsed.problems);
        if (parsed.report) {
          report = parsed.report;
          diagnostics.push('findings file missing — recovered the report from the final answer');
        }
      }
    }

    return {
      report,
      usage: turns > 0 ? usage : null,
      reportedCostUsd: null,
      ...(resolvedModel ? { resolvedModel } : {}),
      ...(turns > 0 ? { usageSource: 'provider' as const } : {}),
      turns,
      truncated:
        io.timedOut ||
        io.exitCode !== 0 ||
        (terminalStatus === '' ? sawError : terminalStatus !== 'completed'),
      rawText: text,
      diagnostics,
    };
  },

  cleanup(ctx: RunContext): void {
    rmSync(runtimeRoot(ctx), { recursive: true, force: true });
  },
} satisfies Harness;
