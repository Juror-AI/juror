import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = process.cwd();

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

function templateIds(path: string): string[] {
  const parsed = parse(read(path)) as { body?: { id?: string }[] };
  return (parsed.body ?? []).flatMap((item) => item.id ? [item.id] : []);
}

describe('contributor paths', () => {
  it('keeps every local documentation link resolvable', () => {
    const files = [
      'CONTRIBUTING.md',
      'docs/contributing/model-presets.md',
      'docs/contributing/harness-providers.md',
      'docs/contributing/benchmark-cases.md',
    ];
    for (const file of files) {
      const body = read(file);
      for (const match of body.matchAll(/\]\(([^)]+)\)/g)) {
        const target = match[1];
        if (!target || target.startsWith('http') || target.startsWith('#')) continue;
        const path = resolve(root, dirname(file), target.split('#', 1)[0]);
        expect(existsSync(path), `${file} -> ${target}`).toBe(true);
      }
    }
  });

  it('requests the evidence needed for model and harness issues', () => {
    expect(templateIds('.github/ISSUE_TEMPLATE/model-integration.yml')).toEqual(
      expect.arrayContaining(['model', 'provider', 'harness', 'authentication', 'pricing', 'preset', 'fixtures', 'security']),
    );
    expect(templateIds('.github/ISSUE_TEMPLATE/harness-provider.yml')).toEqual(
      expect.arrayContaining(['provider', 'models', 'authentication', 'isolation', 'output', 'pricing', 'fixtures', 'maintenance']),
    );
    expect(templateIds('.github/ISSUE_TEMPLATE/benchmark-case.yml')).toEqual(
      expect.arrayContaining(['source', 'defect', 'reviewers', 'accounting', 'fixture', 'method']),
    );
  });

  it('carries versions, auth, pricing, fixtures, security, and validation into pull requests', () => {
    const template = read('.github/PULL_REQUEST_TEMPLATE.md');
    for (const phrase of [
      'model and client/harness versions',
      'Authentication shape',
      'pricing source',
      'fixture paths',
      'Security boundaries',
      'npm run check:compatibility',
    ]) {
      expect(template).toContain(phrase);
    }
  });
});
