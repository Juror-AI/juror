/** One-session Codex QA harness connected only to Juror's constrained browser MCP. */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CanonicalUsage } from '../types.js';
import { redactWith } from '../util/log.js';
import { run, which } from '../util/proc.js';

export interface QaAgentOptions {
  repoDir: string;
  scratchDir: string;
  socketPath: string;
  model: string;
  reasoningEffort: string;
  prompt: string;
  timeoutMs: number;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
}

export interface QaAgentResult {
  completed: boolean;
  finalText: string;
  usage: CanonicalUsage | null;
  diagnostics: string[];
  durationMs: number;
  timedOut: boolean;
  exitCode: number | null;
  /** Redacted Codex JSONL events for protocol diagnostics and replay. */
  events: string;
}

const ENV_ALLOWLIST = [
  'PATH',
  'USER',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  // In the managed container these point only at the controller-owned egress
  // proxy. Codex still has no model tool with raw network access.
  'HTTP_PROXY',
  'HTTPS_PROXY',
];

function isolate(env: Record<string, string>): Record<string, string | undefined> {
  const cleared: Record<string, string | undefined> = {};
  for (const key of Object.keys(process.env)) cleared[key] = undefined;
  return { ...cleared, ...env };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function mcpCommand(): { command: string; args: string[] } {
  const js = fileURLToPath(new URL('./mcp.js', import.meta.url));
  if (existsSync(js)) return { command: process.execPath, args: [js] };
  const ts = fileURLToPath(new URL('./mcp.ts', import.meta.url));
  return { command: process.execPath, args: ['--experimental-strip-types', ts] };
}

function quoteToml(value: string): string {
  return JSON.stringify(path.resolve(value));
}

function installAuth(codexHome: string, env: Record<string, string | undefined>): void {
  const key = env['JUROR_OPENAI_API_KEY']?.trim() || env['OPENAI_API_KEY']?.trim();
  const destination = path.join(codexHome, 'auth.json');
  if (key) {
    writeFileSync(destination, JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: key }), {
      encoding: 'utf8',
      mode: 0o600,
    });
    return;
  }

  // Fast local iteration may use an existing Codex login. Copy it into the private home;
  // the model-visible filesystem profile denies that directory, just like provider-key auth.
  const sourceHome = env['CODEX_HOME']?.trim() || path.join(homedir(), '.codex');
  const source = path.join(sourceHome, 'auth.json');
  if (!existsSync(source)) {
    throw new Error('Juror QA needs JUROR_OPENAI_API_KEY or an existing `codex login` session');
  }
  writeFileSync(destination, readFileSync(source), { mode: 0o600 });
}

export async function runQaAgent(options: QaAgentOptions): Promise<QaAgentResult> {
  const configuredCodex = options.env['JUROR_CODEX_BIN']?.trim();
  const codex = configuredCodex && path.isAbsolute(configuredCodex) && existsSync(configuredCodex)
    ? configuredCodex
    : await which('codex');
  if (!codex) throw new Error('codex not found on PATH — install @openai/codex');
  if (!/^[A-Za-z0-9._/-]+$/.test(options.model)) throw new Error('QA model contains unsupported characters');
  if (!/^[A-Za-z0-9_-]+$/.test(options.reasoningEffort)) {
    throw new Error('QA reasoning effort contains unsupported characters');
  }

  const codexHome = path.join(options.scratchDir, 'codex-home');
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  installAuth(codexHome, options.env);
  const mcp = mcpCommand();
  const shellEnv: Record<string, string> = {
    PATH: options.env['PATH'] ?? process.env.PATH ?? '/usr/bin:/bin',
    HOME: codexHome,
    TMPDIR: options.scratchDir,
  };
  for (const name of ENV_ALLOWLIST) {
    const value = options.env[name];
    if (value) shellEnv[name] = value;
  }
  // Never forward caller-controlled NODE_OPTIONS into the credential-bearing Codex
  // process: Node evaluates preload/import flags before Codex can apply its sandbox.
  // The managed runtime needs only Node's built-in proxy support, so synthesize fixed
  // values whenever a proxy is configured and ignore both caller-supplied knobs. Node 20
  // does not allow --use-env-proxy in NODE_OPTIONS, despite being a supported Juror runtime;
  // capability-check the controller runtime before passing the flag to its Codex launcher.
  if (shellEnv['HTTP_PROXY'] || shellEnv['HTTPS_PROXY']) {
    shellEnv['NODE_USE_ENV_PROXY'] = '1';
    if (process.allowedNodeEnvironmentFlags.has('--use-env-proxy')) {
      shellEnv['NODE_OPTIONS'] = '--use-env-proxy';
    }
  }

  const config = [
    // Keep provider traffic on HTTPS so the controller-owned CONNECT proxy is
    // the only DNS and egress boundary used by the isolated runtime.
    'model_provider = "juror_openai_https"',
    'default_permissions = "juror-qa"',
    'approval_policy = "never"',
    'web_search = "disabled"',
    '',
    '[model_providers.juror_openai_https]',
    'name = "Juror OpenAI HTTPS"',
    'base_url = "https://api.openai.com/v1"',
    'wire_api = "responses"',
    'requires_openai_auth = true',
    'supports_websockets = false',
    '',
    '[shell_environment_policy]',
    'inherit = "none"',
    'experimental_use_profile = false',
    '',
    '[shell_environment_policy.set]',
    ...Object.entries(shellEnv).map(([name, value]) => `${name} = ${JSON.stringify(value)}`),
    '',
    '[features]',
    'apps = false',
    'multi_agent = false',
    'browser_use = false',
    'browser_use_external = false',
    'in_app_browser = false',
    'computer_use = false',
    'shell_tool = false',
    'shell_snapshot = false',
    '',
    '[permissions.juror-qa.filesystem]',
    '":minimal" = "read"',
    `${quoteToml(options.repoDir)} = "read"`,
    `${quoteToml(options.scratchDir)} = "write"`,
    `${quoteToml(codexHome)} = "none"`,
    '',
    '[permissions.juror-qa.network]',
    'enabled = false',
    '',
    '[mcp_servers.juror_qa]',
    `command = ${JSON.stringify(mcp.command)}`,
    `args = ${JSON.stringify([...mcp.args, '--socket', options.socketPath])}`,
    `cwd = ${JSON.stringify(options.scratchDir)}`,
    'startup_timeout_sec = 30',
    // A navigation may include bounded transient-network retries. Keep the MCP
    // deadline above the broker's worst-case operation so no orphan continues
    // after Codex has already received a transport timeout.
    'tool_timeout_sec = 120',
    'required = true',
    // This private, single-purpose MCP is the entire model capability surface. Its
    // trusted broker performs the actual policy and budget checks, so an interactive
    // Codex approval here would deadlock non-interactive CI.
    'default_tools_approval_mode = "approve"',
    'enabled_tools = ["qa_status", "qa_submit_plan", "browser_start_scenario", "browser_snapshot", "browser_navigate", "browser_click", "browser_fill", "browser_press", "browser_select", "browser_check", "browser_wait", "browser_assert", "browser_finish_scenario", "qa_finish"]',
    '',
  ].join('\n');
  writeFileSync(path.join(codexHome, 'config.toml'), config, { encoding: 'utf8', mode: 0o600 });

  const childEnv: Record<string, string> = { ...shellEnv, CODEX_HOME: codexHome };
  const io = await run(
    [
      codex,
      'exec',
      '--json',
      '--ephemeral',
      '-m',
      options.model,
      '-c',
      `model_reasoning_effort=${options.reasoningEffort}`,
      '--strict-config',
      '--ignore-rules',
      '--skip-git-repo-check',
    ],
    {
      cwd: options.scratchDir,
      env: isolate(childEnv),
      stdin: options.prompt,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    },
  );

  const diagnostics: string[] = [];
  let finalText = '';
  let usage: CanonicalUsage | null = null;
  let completed = false;
  for (const line of io.stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const event = asRecord(parsed);
    if (!event) continue;
    if (event['type'] === 'item.completed') {
      const item = asRecord(event['item']);
      if (item?.['type'] === 'agent_message' && typeof item['text'] === 'string') finalText = item['text'];
      if (item?.['type'] === 'error') {
        const detail = typeof item['message'] === 'string' ? item['message'] : JSON.stringify(item);
        diagnostics.push(`codex: ${detail}`);
      }
    }
    if (event['type'] === 'turn.completed') {
      completed = true;
      const raw = asRecord(event['usage']);
      if (raw) {
        const input = numberOr(raw['input_tokens'], 0);
        const cached = numberOr(raw['cached_input_tokens'], 0);
        usage = {
          uncachedIn: Math.max(0, input - cached),
          cacheRead: cached,
          cacheWrite: numberOr(raw['cache_write_input_tokens'], 0),
          out: numberOr(raw['output_tokens'], 0),
        };
      }
    }
  }

  const secrets = Object.entries(options.env)
    .filter(([name, value]) => Boolean(value) && /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(name))
    .map(([, value]) => value as string);
  const stderr = redactWith(io.stderr.trim(), secrets);
  if (stderr) {
    diagnostics.push(
      ...stderr
        .split(/\r?\n/)
        .filter((line) => line.trim() !== 'Reading prompt from stdin...')
        .slice(0, 30),
    );
  }
  if (io.timedOut) diagnostics.push(`Codex QA timed out after ${Math.round(options.timeoutMs / 1000)} seconds`);
  else if (io.exitCode !== 0) diagnostics.push(`Codex QA exited ${io.exitCode ?? 'without a code'}`);
  if (!completed) diagnostics.push('Codex did not complete a turn');

  return {
    completed,
    finalText: redactWith(finalText, secrets),
    usage,
    diagnostics,
    durationMs: io.durationMs,
    timedOut: io.timedOut,
    exitCode: io.exitCode,
    events: redactWith(io.stdout, secrets).slice(0, 2 * 1024 * 1024),
  };
}
