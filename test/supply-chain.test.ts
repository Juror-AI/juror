import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { releaseIdentityErrors } from '../scripts/verify-release.mjs';

const root = resolve(import.meta.dirname, '..');

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

function workflowFiles(): string[] {
  return [
    'action.yml',
    ...readdirSync(join(root, '.github/workflows'))
      .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
      .map((name) => `.github/workflows/${name}`),
  ];
}

describe('supply-chain policy', () => {
  it('pins every external GitHub Action to an immutable revision with a version comment', () => {
    const mutable: string[] = [];

    for (const path of workflowFiles()) {
      for (const [index, line] of read(path).split('\n').entries()) {
        const match = line.match(/\buses:\s*([^\s#]+)@([^\s#]+)/);
        if (!match || match[1]?.startsWith('./')) continue;

        const ref = match[2] ?? '';
        if (!/^[0-9a-f]{40}$/.test(ref) || !/#\s*v?\d/.test(line)) {
          mutable.push(`${path}:${index + 1}: ${line.trim()}`);
        }
      }
    }

    expect(mutable, mutable.join('\n')).toEqual([]);
  });

  it('keeps public Juror installation examples immutable', () => {
    const mutable = [...read('README.md').matchAll(/juror-ai\/juror@([^\s#]+)/g)]
      .map((match) => match[1] ?? '')
      .filter((ref) => !/^[0-9a-f]{40}$/.test(ref));

    expect(mutable).toEqual([]);
  });

  it('configures Dependabot for npm and pinned GitHub Action revisions', () => {
    const config = read('.github/dependabot.yml');

    expect(config).toContain('package-ecosystem: npm');
    expect(config).toContain('package-ecosystem: github-actions');
  });

  it('publishes only a matching tag and produces verifiable release artifacts', () => {
    const workflow = read('.github/workflows/release.yml');

    expect(workflow).toContain('release:');
    expect(workflow).toContain('types: [published]');
    expect(workflow).toContain('attestations: write');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('scripts/verify-release.mjs');
    expect(workflow).toContain('npm pack');
    expect(workflow).toContain('npm sbom');
    expect(workflow).toContain('sbom-path:');
    expect(workflow).toContain('npm publish "$NPM_TARBALL" --provenance --access public');
  });

  it('rejects release identity mismatches before building or publishing', () => {
    const sha = 'a'.repeat(40);
    const valid = {
      tag: 'v1.3.3',
      version: '1.3.3',
      eventSha: sha,
      headSha: sha,
      tagSha: sha,
      repository: 'git+https://github.com/Juror-AI/juror.git',
    };

    expect(releaseIdentityErrors(valid)).toEqual([]);
    expect(releaseIdentityErrors({ ...valid, tag: 'v1.3.2' })).toContain(
      'release tag v1.3.2 does not match package version 1.3.3',
    );
    expect(releaseIdentityErrors({ ...valid, tagSha: 'b'.repeat(40) })).toContain(
      `checked-out commit ${sha} does not match tag commit ${'b'.repeat(40)}`,
    );
  });

  it('documents private reporting expectations and the complete threat boundary', () => {
    const security = read('SECURITY.md');
    const threatModel = read('docs/threat-model.md');

    expect(security).toContain('/security/advisories/new');
    expect(security).toMatch(/business days/i);
    for (const boundary of [
      'untrusted pull request',
      'provider keys',
      'GitHub token',
      'model subprocesses',
      'installer scripts',
      'Action dependencies',
    ]) {
      expect(threatModel.toLowerCase()).toContain(boundary.toLowerCase());
    }
  });
});
