import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_REPOSITORY = 'git+https://github.com/Juror-AI/juror.git';

export function releaseIdentityErrors({ tag, version, eventSha, headSha, tagSha, repository }) {
  const errors = [];
  if (tag !== `v${version}`) errors.push(`release tag ${tag} does not match package version ${version}`);
  if (!/^[0-9a-f]{40}$/.test(eventSha)) errors.push('release event SHA is not a full commit');
  if (headSha !== tagSha) errors.push(`checked-out commit ${headSha} does not match tag commit ${tagSha}`);
  if (headSha !== eventSha) errors.push(`checked-out commit ${headSha} does not match event commit ${eventSha}`);
  if (repository !== EXPECTED_REPOSITORY) {
    errors.push(`package repository must exactly match ${EXPECTED_REPOSITORY} for npm provenance`);
  }
  return errors;
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [tag = '', eventSha = ''] = process.argv.slice(2);
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const trackedChanges = git('status', '--porcelain', '--untracked-files=no');
  const errors = releaseIdentityErrors({
    tag,
    version: packageJson.version ?? '',
    eventSha,
    headSha: git('rev-parse', 'HEAD'),
    tagSha: git('rev-parse', `${tag}^{commit}`),
    repository: packageJson.repository?.url ?? '',
  });
  if (trackedChanges) errors.push('release checkout contains tracked changes before the build');

  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`Verified ${tag} at ${eventSha}.`);
  }
}
