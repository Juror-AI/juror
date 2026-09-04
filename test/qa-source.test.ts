import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { QaSourceInspector } from '../src/qa/source.js';

const temporaryDirectories = new Set<string>();

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'juror-qa-source-'));
  temporaryDirectories.add(root);
  await mkdir(path.join(root, 'apps', 'web'), { recursive: true });
  await writeFile(
    path.join(root, 'apps', 'web', 'routes.tsx'),
    [
      "import { ZenoChat } from './ZenoChat';",
      "export const chatRoute = '/c';",
      'export const element = <ZenoChat />;',
      '',
    ].join('\n'),
  );
  await writeFile(path.join(root, 'apps', 'web', 'binary.dat'), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(root, 'apps', 'web', 'credentials.ts'), 'export const token = "do-not-expose";\n');
  await writeFile(path.join(root, 'apps', 'web', 'routes.json'), '{"route":"do-not-search"}\n');
  return root;
}

afterEach(async () => {
  await Promise.all([...temporaryDirectories].map((directory) =>
    rm(directory, { recursive: true, force: true })));
  temporaryDirectories.clear();
});

describe('QA source inspection', () => {
  it('searches and reads bounded repository source needed to derive an affected route', async () => {
    const root = await fixture();
    const source = new QaSourceInspector(root);

    await expect(source.search('zenochat', 'apps/web', false, 10)).resolves.toMatchObject({
      matches: [
        { path: 'apps/web/routes.tsx', line: 1 },
        { path: 'apps/web/routes.tsx', line: 3 },
      ],
      files_scanned: 1,
      truncated: false,
    });
    await expect(source.read('apps/web/routes.tsx', 2, 1)).resolves.toEqual({
      path: 'apps/web/routes.tsx',
      start_line: 2,
      end_line: 2,
      total_lines: 4,
      content: "export const chatRoute = '/c';",
      truncated: true,
    });
  });

  it('rejects traversal, symbolic links, non-source and sensitive files, and unbounded requests', async () => {
    const root = await fixture();
    const outsideRoot = await mkdtemp(path.join(tmpdir(), 'juror-qa-source-outside-'));
    temporaryDirectories.add(outsideRoot);
    const outside = path.join(outsideRoot, 'outside.txt');
    await writeFile(outside, 'outside');
    await symlink(outside, path.join(root, 'linked.txt'));
    const source = new QaSourceInspector(root);

    await expect(source.read('../outside.txt')).rejects.toThrow('parent segments');
    await expect(source.read('linked.txt')).rejects.toThrow('symbolic links');
    await expect(source.read('.git/config')).rejects.toThrow('version-control metadata');
    await expect(source.read('apps/web/binary.dat')).rejects.toThrow('allowlisted source');
    await expect(source.read('apps/web/routes.json')).rejects.toThrow('allowlisted source');
    await expect(source.read('apps/web/credentials.ts')).rejects.toThrow('allowlisted source');
    await expect(source.search('do-not-', 'apps/web')).resolves.toMatchObject({ matches: [] });
    await expect(source.search('route', '', false, 51)).rejects.toThrow('max_results');
  });

  it('reports only the line extent delivered when the character budget truncates a read', async () => {
    const root = await fixture();
    const longLine = 'x'.repeat(99_999);
    await writeFile(path.join(root, 'apps', 'web', 'large.ts'), `${longLine}\nsecond line\nthird line\n`);
    const source = new QaSourceInspector(root);

    const result = await source.read('apps/web/large.ts', 1, 3);

    expect(result.content).toBe(longLine);
    expect(result.end_line).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it('redacts provider-shaped credentials embedded in otherwise inspectable source', async () => {
    const root = await fixture();
    await writeFile(
      path.join(root, 'apps', 'web', 'route-with-token.ts'),
      'export const route = "/c"; // sk-proj-abcdefghijklmnopqrstuvwxyz123456\n',
    );
    const source = new QaSourceInspector(root);

    const read = await source.read('apps/web/route-with-token.ts');
    expect(read.content).toContain('export const route = "/c"; // [redacted]');
    expect(read.content).not.toContain('sk-proj-');
    await expect(source.search('sk-proj-', 'apps/web')).resolves.toMatchObject({ matches: [] });
  });

  it('caps the total number of model-driven source inspection calls', async () => {
    const root = await fixture();
    const source = new QaSourceInspector(root);
    for (let call = 0; call < 20; call++) {
      await source.search('missing', 'apps/web', true, 1);
    }
    await expect(source.search('missing')).rejects.toThrow('limited to 20 calls');
  });
});
