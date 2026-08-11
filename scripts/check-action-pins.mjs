import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function workflowFiles() {
  return [
    'action.yml',
    ...readdirSync(join(root, '.github/workflows'))
      .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
      .map((name) => `.github/workflows/${name}`),
  ];
}

export function insecureReferences() {
  const failures = [];

  for (const path of workflowFiles()) {
    for (const [index, line] of read(path).split('\n').entries()) {
      const match = line.match(/\buses:\s*([^\s#]+)@([^\s#]+)/);
      if (!match || match[1]?.startsWith('./')) continue;

      const ref = match[2] ?? '';
      if (!/^[0-9a-f]{40}$/.test(ref)) {
        failures.push(`${path}:${index + 1}: external Action is not pinned to a commit: ${line.trim()}`);
      } else if (!/#\s*v?\d/.test(line)) {
        failures.push(`${path}:${index + 1}: pinned Action needs a readable version comment: ${line.trim()}`);
      }
    }
  }

  for (const match of read('README.md').matchAll(/juror-ai\/juror@([^\s#]+)/g)) {
    const ref = match[1] ?? '';
    if (!/^[0-9a-f]{40}$/.test(ref)) {
      failures.push(`README.md: Juror install example is not immutable: ${ref}`);
    }
  }

  return failures;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const failures = insecureReferences();
  if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('All external GitHub Actions and Juror install examples use immutable revisions.');
  }
}
