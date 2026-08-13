/** Secure, non-destructive onboarding for `juror init`. */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

import { applyReviewPreset, loadConfig, readSecret } from './config.js';
import type { HarnessId, JurorConfig, ModelConfig, ReviewPreset } from './types.js';
import { run, type RunOptions } from './util/proc.js';
import { repoRoot } from './util/workspace.js';

const MANAGED_PREFIX = '# juror:init:managed sha256:';
const ACTION_REPOSITORY = 'Juror-AI/juror';

export interface ProviderReadiness {
  canonicalName: string;
  label: string;
  available: boolean;
  source: string;
}

export interface CredentialReadiness {
  providers: ProviderReadiness[];
  runnableModels: string[];
  runnableFamilies: string[];
  juryKind: 'none' | 'single-model' | 'multi-model';
}

export interface WorkflowInstallResult {
  path: string;
  outcome: 'created' | 'updated' | 'unchanged' | 'preserved' | 'planned-create' | 'planned-update';
}

interface HarnessIO {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
}

export type CommandRunner = (argv: string[], opts?: RunOptions) => Promise<HarnessIO>;

const PROVIDERS = [
  { canonicalName: 'JUROR_ANTHROPIC_API_KEY', label: 'Anthropic' },
  { canonicalName: 'JUROR_OPENAI_API_KEY', label: 'OpenAI' },
  { canonicalName: 'JUROR_XAI_API_KEY', label: 'xAI' },
  { canonicalName: 'JUROR_FIREWORKS_API_KEY', label: 'Fireworks' },
  { canonicalName: 'JUROR_OPENROUTER_API_KEY', label: 'OpenRouter' },
] as const;

export interface InitCommandOptions {
  repoDir: string;
  repo?: string | null;
  env: Record<string, string | undefined>;
  version: string;
  actionSha?: string | null;
  preset?: ReviewPreset | null;
  dryRun?: boolean;
  setSecrets?: boolean;
  yes?: boolean;
  runner?: CommandRunner;
  write?: (text: string) => void;
  confirm?: (question: string) => Promise<boolean>;
}

export interface InitCommandResult {
  repoDir: string;
  repo: string | null;
  defaultBranch: string;
  ghInstalled: boolean;
  ghAuthenticated: boolean;
  configPath: string | null;
  actionSha: string;
  readiness: CredentialReadiness;
  workflow: WorkflowInstallResult;
  uploadedSecrets: string[];
}

export function credentialReadiness(
  env: Record<string, string | undefined>,
  config: JurorConfig,
): CredentialReadiness {
  const providers = PROVIDERS.map(({ canonicalName, label }) => {
    const secret = readSecret(env, canonicalName);
    return {
      canonicalName,
      label,
      available: Boolean(secret.value),
      source: secret.source,
    };
  });

  const runnable = config.models.filter(
    (model) => model.enabled && Boolean(readSecret(env, model.secret).value),
  );
  const runnableModels = runnable.map((model) => model.id);
  const runnableFamilies = [...new Set(runnable.map(modelFamily))];
  const juryKind =
    runnableFamilies.length >= 2
      ? 'multi-model'
      : runnableModels.length >= 1
        ? 'single-model'
        : 'none';

  return { providers, runnableModels, runnableFamilies, juryKind };
}

function modelFamily(model: ModelConfig): string {
  const fixed: Partial<Record<HarnessId, string>> = {
    'claude-code': 'anthropic',
    codex: 'openai',
    'grok-build': 'xai',
    'kimi-code': 'moonshot',
  };
  if (fixed[model.harness]) return fixed[model.harness] as string;

  const identity = `${model.id} ${model.harness_model ?? ''}`.toLowerCase();
  if (identity.includes('deepseek')) return 'deepseek';
  if (identity.includes('kimi') || identity.includes('moonshot')) return 'moonshot';
  if (identity.includes('claude') || identity.includes('anthropic')) return 'anthropic';
  if (identity.includes('gpt') || identity.includes('openai')) return 'openai';
  if (identity.includes('grok') || identity.includes('xai')) return 'xai';
  return model.id.toLowerCase();
}

export function renderManagedWorkflow(options: {
  actionSha: string;
  version: string;
  preset?: ReviewPreset | null;
}): string {
  assertActionSha(options.actionSha);
  const body = `# Juror v${options.version}\n` +
    `# Edit .juror.yml for review policy. Run \`juror init\` to refresh this managed workflow.\n` +
    `name: Juror\n\n` +
    `on:\n` +
    `  pull_request:\n` +
    `    types: [opened, synchronize, reopened]\n\n` +
    `permissions:\n` +
    `  contents: read\n` +
    `  pull-requests: write\n\n` +
    `concurrency:\n` +
    `  group: juror-\${{ github.event.pull_request.number }}\n` +
    `  cancel-in-progress: true\n\n` +
    `jobs:\n` +
    `  review:\n` +
    `    if: github.event.pull_request.head.repo.full_name == github.repository\n` +
    `    runs-on: ubuntu-latest\n` +
    `    steps:\n` +
    `      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0\n` +
    `        with:\n` +
    `          # Full ref graph for base-revision policy; blobless so history file contents\n` +
    `          # are fetched on demand instead of up front.\n` +
    `          fetch-depth: 0\n` +
    `          filter: blob:none\n` +
    `      - uses: juror-ai/juror@${options.actionSha} # v${options.version}\n` +
    `        with:\n` +
    `          github-token: \${{ secrets.GITHUB_TOKEN }}\n` +
    (options.preset ? `          preset: ${options.preset}\n` : '') +
    `        env:\n` +
    `          JUROR_OPENAI_API_KEY: \${{ secrets.JUROR_OPENAI_API_KEY }}\n` +
    `          JUROR_ANTHROPIC_API_KEY: \${{ secrets.JUROR_ANTHROPIC_API_KEY }}\n` +
    `          JUROR_XAI_API_KEY: \${{ secrets.JUROR_XAI_API_KEY }}\n` +
    `          JUROR_FIREWORKS_API_KEY: \${{ secrets.JUROR_FIREWORKS_API_KEY }}\n` +
    `          JUROR_OPENROUTER_API_KEY: \${{ secrets.JUROR_OPENROUTER_API_KEY }}\n`;
  const digest = createHash('sha256').update(body).digest('hex');
  return `${MANAGED_PREFIX}${digest}\n${body}`;
}

export function managedWorkflowIsPristine(text: string): boolean {
  const newline = text.indexOf('\n');
  if (newline < 0) return false;
  const first = text.slice(0, newline);
  if (!first.startsWith(MANAGED_PREFIX)) return false;
  const recorded = first.slice(MANAGED_PREFIX.length);
  if (!/^[a-f0-9]{64}$/.test(recorded)) return false;
  const body = text.slice(newline + 1);
  const actual = createHash('sha256').update(body).digest('hex');
  return actual === recorded;
}

export async function installManagedWorkflow(
  repoDir: string,
  desired: string,
  dryRun: boolean,
): Promise<WorkflowInstallResult> {
  const workflowPath = path.join(repoDir, '.github', 'workflows', 'juror.yml');
  let existing: string | null = null;
  try {
    existing = await readFile(workflowPath, 'utf8');
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  if (existing === desired) return { path: workflowPath, outcome: 'unchanged' };
  if (existing !== null && !managedWorkflowIsPristine(existing)) {
    return { path: workflowPath, outcome: 'preserved' };
  }
  if (dryRun) {
    return {
      path: workflowPath,
      outcome: existing === null ? 'planned-create' : 'planned-update',
    };
  }

  await mkdir(path.dirname(workflowPath), { recursive: true });
  await writeFile(workflowPath, desired, { encoding: 'utf8', mode: 0o644 });
  return { path: workflowPath, outcome: existing === null ? 'created' : 'updated' };
}

export async function uploadProviderSecrets(
  env: Record<string, string | undefined>,
  canonicalNames: string[],
  repo: string,
  runner: CommandRunner = run,
): Promise<string[]> {
  const uploaded: string[] = [];
  const allowed = new Set<string>(PROVIDERS.map((provider) => provider.canonicalName));
  for (const canonicalName of canonicalNames) {
    if (!allowed.has(canonicalName)) {
      throw new Error(`Unsupported Juror provider secret ${JSON.stringify(canonicalName)}`);
    }
    const value = readSecret(env, canonicalName).value;
    if (!value) continue;
    const io = await runner(
      ['gh', 'secret', 'set', canonicalName, '--repo', repo],
      { stdin: value, timeoutMs: 120_000 },
    );
    if (io.exitCode !== 0) {
      // Do not include stdout/stderr: a failing third-party CLI is allowed to echo stdin.
      throw new Error(`Could not set GitHub secret ${canonicalName} (exit ${io.exitCode ?? 'unknown'})`);
    }
    uploaded.push(canonicalName);
  }
  return uploaded;
}

export async function runInitCommand(options: InitCommandOptions): Promise<InitCommandResult> {
  const runner = options.runner ?? run;
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const root = await repoRoot(options.repoDir);
  const inside = await runner(['git', 'rev-parse', '--is-inside-work-tree'], {
    cwd: root,
    timeoutMs: 30_000,
  });
  if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
    throw new Error(`juror init must run inside a git repository: ${root}`);
  }

  const repo = options.repo ?? (await inferRepository(root, runner));
  const gh = await inspectGh(runner);
  const defaultBranch = await detectDefaultBranch(root, repo, gh.authenticated, runner);
  const loaded = loadConfig(root);
  const config = options.preset ? applyReviewPreset(loaded.config, options.preset) : loaded.config;
  const readiness = credentialReadiness(options.env, config);
  const availableNames = readiness.providers
    .filter((provider) => provider.available)
    .map((provider) => provider.canonicalName);

  write('Juror init\n\n');
  write(`Repository: ${repo ?? '(origin is not a GitHub repository)'}\n`);
  write(`Default branch: ${defaultBranch}\n`);
  write(`GitHub CLI: ${gh.installed ? (gh.authenticated ? `authenticated${gh.login ? ` as ${gh.login}` : ''}` : 'installed, not authenticated') : 'not installed'}\n`);
  write(`Config: ${loaded.sourcePath ? path.relative(root, loaded.sourcePath) : 'defaults (no .juror.yml found)'}\n`);
  if (options.preset) write(`Preset: ${options.preset} (CLI override)\n`);
  for (const problem of loaded.problems) write(`  ! Config warning: ${problem}\n`);
  for (const provider of readiness.providers) {
    write(
      `  ${provider.available ? '✓' : '·'} ${provider.label}: ` +
        `${provider.available ? `available via ${provider.source}` : `missing ${provider.canonicalName}`}\n`,
    );
  }
  write(`${jurySummary(readiness)}\n`);

  let secretUploadConfirmed = false;
  if (options.setSecrets && !options.dryRun) {
    if (!repo) throw new Error('--set-secrets needs a GitHub origin or --repo owner/name');
    if (!gh.installed || !gh.authenticated) {
      throw new Error('--set-secrets needs an authenticated GitHub CLI; run `gh auth login` first');
    }
    if (availableNames.length === 0) {
      throw new Error('--set-secrets found no provider keys; add them to the environment or repo .env first');
    }
    secretUploadConfirmed = options.yes || await (options.confirm ?? confirmInTerminal)(
      `Upload ${availableNames.length} detected provider secret(s) to ${repo}?`,
    );
  }
  const actionSha = await resolveActionSha(options.actionSha, options.version, runner);
  const workflowText = renderManagedWorkflow({ actionSha, version: options.version, preset: options.preset });
  const workflow = await installManagedWorkflow(root, workflowText, options.dryRun ?? false);
  write(`${workflowSummary(workflow, root)}\n`);

  let uploadedSecrets: string[] = [];
  if (options.setSecrets) {
    if (options.dryRun) {
      write(`Dry run: would upload ${availableNames.length} detected provider secret(s); no values were sent.\n`);
    } else {
      if (secretUploadConfirmed) {
        if (!repo) throw new Error('internal init error: confirmed secret upload has no repository');
        uploadedSecrets = await uploadProviderSecrets(options.env, availableNames, repo, runner);
        write(`Uploaded ${uploadedSecrets.length} provider secret(s) using dedicated JUROR_ names.\n`);
      } else {
        write('Secret upload skipped. No credential values were sent.\n');
      }
    }
  } else if (availableNames.length > 0) {
    write('Secrets were not uploaded. Re-run with --set-secrets to confirm and upload detected values.\n');
  }

  if (options.dryRun) write('Dry run complete: no workflow or secret was changed.\n');
  else if (workflow.outcome === 'preserved') {
    write('Existing workflow has user changes and was preserved; merge the generated setup manually.\n');
  } else {
    write(`Next: commit ${path.relative(root, workflow.path)} and open a pull request.\n`);
    write(
      `First local review (uses provider APIs): juror review` +
        `${options.preset ? ` --preset ${options.preset}` : ''} --base ${defaultBranch}\n`,
    );
  }

  return {
    repoDir: root,
    repo,
    defaultBranch,
    ghInstalled: gh.installed,
    ghAuthenticated: gh.authenticated,
    configPath: loaded.sourcePath,
    actionSha,
    readiness,
    workflow,
    uploadedSecrets,
  };
}

async function inferRepository(repoDir: string, runner: CommandRunner): Promise<string | null> {
  const io = await runner(['git', 'remote', 'get-url', 'origin'], { cwd: repoDir, timeoutMs: 30_000 });
  if (io.exitCode !== 0) return null;
  const match = io.stdout.trim().match(/(?:github\.com[:/])([^/]+)\/([^/]+?)(?:\.git)?$/i);
  return match?.[1] && match[2] ? `${match[1]}/${match[2]}` : null;
}

async function inspectGh(runner: CommandRunner): Promise<{ installed: boolean; authenticated: boolean; login: string | null }> {
  const found = await runner(['/usr/bin/env', 'which', 'gh'], { timeoutMs: 10_000 });
  if (found.exitCode !== 0) return { installed: false, authenticated: false, login: null };
  const auth = await runner(['gh', 'auth', 'status'], { timeoutMs: 30_000 });
  if (auth.exitCode !== 0) return { installed: true, authenticated: false, login: null };
  const user = await runner(['gh', 'api', 'user', '--jq', '.login'], { timeoutMs: 30_000 });
  return {
    installed: true,
    authenticated: true,
    login: user.exitCode === 0 ? user.stdout.trim() || null : null,
  };
}

async function detectDefaultBranch(
  repoDir: string,
  repo: string | null,
  ghAuthenticated: boolean,
  runner: CommandRunner,
): Promise<string> {
  if (repo && ghAuthenticated) {
    const remote = await runner(
      ['gh', 'repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'],
      { timeoutMs: 30_000 },
    );
    if (remote.exitCode === 0 && remote.stdout.trim()) return remote.stdout.trim();
  }
  const originHead = await runner(
    ['git', 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    { cwd: repoDir, timeoutMs: 30_000 },
  );
  if (originHead.exitCode === 0 && originHead.stdout.trim()) {
    return originHead.stdout.trim().replace(/^origin\//, '');
  }
  const current = await runner(['git', 'branch', '--show-current'], { cwd: repoDir, timeoutMs: 30_000 });
  return current.exitCode === 0 && current.stdout.trim() ? current.stdout.trim() : 'main';
}

async function resolveActionSha(
  explicit: string | null | undefined,
  version: string,
  runner: CommandRunner,
): Promise<string> {
  if (explicit) {
    assertActionSha(explicit);
    return explicit.toLowerCase();
  }

  const ref = `v${version}`;
  const gh = await runner(
    ['gh', 'api', `repos/${ACTION_REPOSITORY}/commits/${ref}`, '--jq', '.sha'],
    { timeoutMs: 30_000 },
  ).catch(() => null);
  const fromGh = gh?.exitCode === 0 ? gh.stdout.trim() : '';
  if (/^[a-f0-9]{40}$/i.test(fromGh)) return fromGh.toLowerCase();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(
      `https://api.github.com/repos/${ACTION_REPOSITORY}/commits/${encodeURIComponent(ref)}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `juror-init/${version}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: controller.signal,
      },
    );
    if (response.ok) {
      const payload = await response.json() as { sha?: unknown };
      if (typeof payload.sha === 'string' && /^[a-f0-9]{40}$/i.test(payload.sha)) {
        return payload.sha.toLowerCase();
      }
    }
  } catch {
    // The actionable error below covers offline, timeout, and malformed response cases.
  } finally {
    clearTimeout(timer);
  }
  throw new Error(
    `Could not resolve immutable action revision ${ref}; connect to GitHub or pass --action-sha <40-hex-sha>`,
  );
}

function assertActionSha(value: string): void {
  if (!/^[a-f0-9]{40}$/i.test(value)) {
    throw new Error(`Action revision must be a full 40-character commit SHA, got ${JSON.stringify(value)}`);
  }
}

function jurySummary(readiness: CredentialReadiness): string {
  if (readiness.juryKind === 'multi-model') {
    return `Jury: ${readiness.runnableModels.length} runnable models across ${readiness.runnableFamilies.length} families — multi-model review ready.`;
  }
  if (readiness.juryKind === 'single-model') {
    return `Jury: ${readiness.runnableModels.length} runnable model from one family — single-model review works, but there is no cross-model agreement signal.`;
  }
  return 'Jury: no configured model can authenticate — add a key used by the selected preset before reviewing.';
}

function workflowSummary(workflow: WorkflowInstallResult, repoDir: string): string {
  const relative = path.relative(repoDir, workflow.path) || workflow.path;
  const descriptions: Record<WorkflowInstallResult['outcome'], string> = {
    created: 'created',
    updated: 'updated',
    unchanged: 'already current',
    preserved: 'preserved because it is unmanaged or user-modified',
    'planned-create': 'would be created',
    'planned-update': 'would be updated',
  };
  return `Workflow: ${relative} ${descriptions[workflow.outcome]} (Juror is pinned to an immutable SHA).`;
}

async function confirmInTerminal(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive confirmation is unavailable; re-run with --set-secrets --yes to confirm explicitly');
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`${question} [y/N] `);
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
