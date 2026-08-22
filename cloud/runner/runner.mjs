import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { stringify as stringifyYaml } from 'yaml';

const [, , manifestPath, outputPath] = process.argv;
if (!manifestPath || !outputPath) throw new Error('usage: runner.mjs <manifest.json> <output.json>');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(manifest.repository)) throw new Error('invalid repository');
if (!Number.isInteger(manifest.prNumber) || manifest.prNumber < 1) throw new Error('invalid PR number');
if (!/^[0-9a-f]{7,64}$/i.test(manifest.revisionSha)) throw new Error('invalid revision');

const workspace = `/workspace/${manifest.runId.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`;
await mkdir(workspace, { recursive: true });

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr.replace(/[\r\n]+/g, ' ').slice(-500)}`)));
  });
}

// Git does not read GITHUB_TOKEN by itself. The value is deliberately a non-secret
// placeholder: the Worker outbound handler replaces the resulting Basic header only for
// github.com, so private repositories clone successfully without exposing an installation
// token to the checkout or any process inside the Sandbox.
const githubPlaceholder = encodeURIComponent(process.env.GITHUB_TOKEN || 'juror-outbound-token');
await run('git', ['clone', '--filter=blob:none', '--no-checkout', `https://x-access-token:${githubPlaceholder}@github.com/${manifest.repository}.git`, workspace]);
await run('git', ['-C', workspace, 'fetch', '--depth=2', 'origin', manifest.kind === 'review' ? `refs/pull/${manifest.prNumber}/head` : manifest.revisionSha]);
await run('git', ['-C', workspace, 'checkout', '--detach', manifest.revisionSha]);

const hostedConfigPath = '/tmp/juror-hosted.yml';
await writeFile(hostedConfigPath, stringifyYaml({ version: 1, review: { publish_mode: manifest.publishMode, severity_floor: manifest.severityFloor }, ...(manifest.qaConfig ? { qa: manifest.qaConfig } : {}) }), { mode: 0o600 });

const rawPath = '/tmp/juror-raw-report.json';
const command = manifest.kind === 'review'
  ? ['review', '--repo', manifest.repository, '--repo-dir', workspace, '--pr', String(manifest.prNumber), '--config', hostedConfigPath, '--preset', manifest.preset, '--json', rawPath]
  : ['qa', '--repo', manifest.repository, '--repo-dir', workspace, '--pr', String(manifest.prNumber), '--config', hostedConfigPath, '--force', '--target-url', manifest.targetUrl, '--target-sha', manifest.revisionSha, '--evidence-dir', '/tmp/juror-evidence', ...manifest.allowedOrigins.flatMap((origin) => ['--allow-origin', origin]), '--json', rawPath];
if (command.some((value) => value === null)) throw new Error('QA target is not configured');
await run('node', ['/opt/juror/dist/cli.js', ...command], { cwd: workspace, env: process.env });

const raw = JSON.parse(await readFile(rawPath, 'utf8'));
if (manifest.kind === 'review') {
  const { sanitizeHostedReviewResult } = await import('/opt/juror/dist/cloud/types.js');
  await writeFile(outputPath, JSON.stringify(sanitizeHostedReviewResult(raw)), { mode: 0o600 });
} else {
  await writeFile(outputPath, JSON.stringify(raw), { mode: 0o600 });
}
