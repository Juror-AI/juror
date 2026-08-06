import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseModelReport, readReportFile } from '../src/report.js';

const dirs: string[] = [];

function fileWith(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'juror-report-'));
  dirs.push(dir);
  const path = join(dir, 'findings.json');
  writeFileSync(path, body);
  return path;
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const FULL = {
  merge_confidence: 3,
  confidence_reason: 'One reachable clipboard bug.',
  summary: 'Adds tenant-aware invite URLs.',
  highlights: ['Adds a Copy link mutation'],
  file_overviews: [{ path: 'src/a.ts', overview: 'Adds the copy workflow.' }],
  async_contracts: [
    'handleCopyLink() -> navigator.clipboard.writeText(): returned promise',
  ],
  sequence_diagram: 'sequenceDiagram\n  A->>B: x',
  findings: [
    {
      path: 'src/a.ts',
      line: 212,
      end_line: 214,
      severity: 'P1',
      title: 'Clipboard write loses transient activation',
      body: 'Awaits two requests before writeText, so Safari rejects it.',
      claim: {
        trigger: 'The user clicks Copy link in Safari.',
        mechanism: 'The handler awaits requests before calling writeText().',
        consequence: 'Safari rejects the clipboard write after activation expires.',
        fix: 'Preserve activation by writing before the awaited requests.',
      },
      category: 'correctness',
      confidence: 0.8,
      convention: null,
    },
  ],
};

describe('parseModelReport — extraction', () => {
  it('parses a bare JSON object', () => {
    const { report, problems } = parseModelReport(JSON.stringify(FULL));
    expect(problems).toEqual([]);
    expect(report).toEqual(FULL);
  });

  it('survives a leading UTF-8 BOM', () => {
    const { report, problems } = parseModelReport(`﻿${JSON.stringify(FULL)}`);
    expect(problems).toEqual([]);
    expect(report?.findings).toHaveLength(1);
  });

  it('survives prose wrapped around the JSON', () => {
    const text = [
      "Sure! I read the callers of handleCopyLink. Here's what I found:",
      '',
      JSON.stringify(FULL),
      '',
      'Let me know if you want me to dig further into the {mystery} braces.',
    ].join('\n');
    const { report, problems } = parseModelReport(text);
    expect(report?.findings[0]?.title).toBe('Clipboard write loses transient activation');
    expect(problems.join('\n')).toContain('recovered it from');
  });

  it('parses a ```json fenced block, ignoring an earlier prose fence', () => {
    const text = [
      'First, the shape I used:',
      '```bash',
      'grep -n writeText src/a.ts',
      '```',
      'And the report:',
      '```json',
      JSON.stringify(FULL, null, 2),
      '```',
    ].join('\n');
    const { report } = parseModelReport(text);
    expect(report?.summary).toBe('Adds tenant-aware invite URLs.');
    expect(report?.findings).toHaveLength(1);
  });

  it('parses an unlabelled fenced block', () => {
    const { report } = parseModelReport(['Report:', '```', JSON.stringify(FULL), '```'].join('\n'));
    expect(report?.findings).toHaveLength(1);
  });

  it('tolerates trailing commas', () => {
    const text = `{
      "merge_confidence": 4,
      "summary": "Adds a thing.",
      "findings": [
        {
          "path": "src/a.ts",
          "line": 12,
          "severity": "P2",
          "title": "Unused import",
          "body": "Remove it.",
        },
      ],
    }`;
    const { report, problems } = parseModelReport(text);
    expect(report?.merge_confidence).toBe(4);
    expect(report?.findings).toHaveLength(1);
    expect(problems.join('\n')).toContain('trailing commas');
  });

  it('does not end a JSON object early on a brace inside a string', () => {
    const text = `Here you go:\n${JSON.stringify({
      ...FULL,
      summary: 'Rewrites the } handler { and the "quoted \\" escape }',
    })}\ntrailing prose`;
    const { report } = parseModelReport(text);
    expect(report?.summary).toBe('Rewrites the } handler { and the "quoted \\" escape }');
    expect(report?.findings).toHaveLength(1);
  });

  it('treats a top-level array as just the findings', () => {
    const { report, problems } = parseModelReport(
      JSON.stringify([{ path: 'src/a.ts', line: 4, severity: 'P2', title: 'Off by one', body: 'x' }]),
    );
    expect(report?.findings).toHaveLength(1);
    expect(report?.merge_confidence).toBe(3);
    expect(report?.summary).toBe('');
    expect(problems.join('\n')).toContain('bare array');
  });

  it('returns null when there is no usable object at all', () => {
    const { report, problems } = parseModelReport('I could not review this PR, sorry.');
    expect(report).toBeNull();
    expect(problems.join('\n')).toContain('no JSON object found');
  });

  it('returns null for empty output', () => {
    expect(parseModelReport('').report).toBeNull();
    expect(parseModelReport('   \n\n').report).toBeNull();
  });
});

describe('parseModelReport — coercion', () => {
  it('maps severity words, cases, spacing, and numbers onto P0–P3', () => {
    const cases: [unknown, string][] = [
      ['p1', 'P1'],
      ['P1 ', 'P1'],
      [1, 'P1'],
      ['critical', 'P0'],
      ['high', 'P1'],
      ['medium', 'P2'],
      ['low', 'P3'],
    ];
    for (const [raw, expected] of cases) {
      const { report } = parseModelReport(
        JSON.stringify({ findings: [{ path: 'a.ts', line: 1, title: 't', body: 'b', severity: raw }] }),
      );
      expect(report?.findings[0]?.severity, `severity ${JSON.stringify(raw)}`).toBe(expected);
    }
  });

  it('falls back to P2 and reports an unrecognizable severity', () => {
    const { report, problems } = parseModelReport(
      JSON.stringify({ findings: [{ path: 'a.ts', line: 1, title: 't', body: 'b', severity: 'spicy' }] }),
    );
    expect(report?.findings[0]?.severity).toBe('P2');
    expect(problems.join('\n')).toContain('unknown severity');
  });

  it('accepts a string line number', () => {
    const { report } = parseModelReport(
      JSON.stringify({ findings: [{ path: 'a.ts', line: '212', title: 't', body: 'b', severity: 'P1' }] }),
    );
    expect(report?.findings[0]?.line).toBe(212);
  });

  it('coerces an unusable line to 1 and says so', () => {
    const { report, problems } = parseModelReport(
      JSON.stringify({ findings: [{ path: 'a.ts', line: 0, title: 't', body: 'b', severity: 'P1' }] }),
    );
    expect(report?.findings[0]?.line).toBe(1);
    expect(problems.join('\n')).toContain('not a positive integer');
  });

  it('drops a finding with no path but keeps its siblings', () => {
    const { report, problems } = parseModelReport(
      JSON.stringify({
        merge_confidence: 2,
        findings: [
          { path: 'a.ts', line: 1, title: 'first', body: 'b', severity: 'P1' },
          { line: 9, title: 'homeless', body: 'b', severity: 'P0' },
          { path: 'c.ts', line: 3, title: '', body: 'b', severity: 'P0' },
          { path: 'b.ts', line: 2, title: 'third', body: 'b', severity: 'P2' },
        ],
      }),
    );
    expect(report?.findings.map((f) => f.title)).toEqual(['first', 'third']);
    expect(problems.join('\n')).toContain('findings[1]: no `path` — dropped');
    expect(problems.join('\n')).toContain('no `title`');
  });

  it('clamps merge_confidence and confidence, and normalizes a percentage', () => {
    const { report, problems } = parseModelReport(
      JSON.stringify({
        merge_confidence: 9,
        findings: [
          { path: 'a.ts', line: 1, title: 't', body: 'b', severity: 'P1', confidence: 4.2 },
          { path: 'b.ts', line: 1, title: 't', body: 'b', severity: 'P1', confidence: 80 },
          { path: 'c.ts', line: 1, title: 't', body: 'b', severity: 'P1', confidence: -1 },
        ],
      }),
    );
    expect(report?.merge_confidence).toBe(5);
    expect(report?.findings.map((f) => f.confidence)).toEqual([1, 0.8, 0]);
    expect(problems.join('\n')).toContain('clamped');
  });

  it('maps an unknown category to correctness and normalizes separators', () => {
    const { report, problems } = parseModelReport(
      JSON.stringify({
        findings: [
          { path: 'a.ts', line: 1, title: 't', body: 'b', severity: 'P1', category: 'api_contract' },
          { path: 'b.ts', line: 1, title: 't', body: 'b', severity: 'P1', category: 'vibes' },
        ],
      }),
    );
    expect(report?.findings.map((f) => f.category)).toEqual(['api-contract', 'correctness']);
    expect(problems.join('\n')).toContain('unknown category');
  });

  it('keeps only complete atomic claim metadata', () => {
    const { report, problems } = parseModelReport(
      JSON.stringify({
        findings: [
          {
            path: 'a.ts',
            line: 1,
            title: 'Complete claim',
            body: 'A complete claim.',
            severity: 'P1',
            claim: {
              trigger: 'request fails',
              mechanism: 'wrapper discards the promise',
              consequence: 'caller navigates before persistence finishes',
              fix: 'return the promise',
            },
          },
          {
            path: 'b.ts',
            line: 2,
            title: 'Partial claim',
            body: 'A partial claim.',
            severity: 'P1',
            claim: { trigger: 'request fails', mechanism: 'promise is discarded' },
          },
        ],
      }),
    );

    expect(report?.findings[0]?.claim).toEqual({
      trigger: 'request fails',
      mechanism: 'wrapper discards the promise',
      consequence: 'caller navigates before persistence finishes',
      fix: 'return the promise',
    });
    expect(report?.findings[1]?.claim).toBeUndefined();
    expect(problems.join('\n')).toContain('claim is missing consequence, fix');
  });

  it('normalizes repo-relative paths and drops a bogus end_line', () => {
    const { report, problems } = parseModelReport(
      JSON.stringify({
        findings: [{ path: './src/a.ts', line: 10, end_line: 4, title: 't', body: 'b', severity: 'P1' }],
      }),
    );
    expect(report?.findings[0]?.path).toBe('src/a.ts');
    expect(report?.findings[0]?.end_line).toBeNull();
    expect(problems.join('\n')).toContain('end_line');
  });

  it('defaults every missing array and keeps the report usable', () => {
    const { report, problems } = parseModelReport('{"summary":"Adds a thing."}');
    expect(report).toEqual({
      merge_confidence: 3,
      confidence_reason: '',
      summary: 'Adds a thing.',
      highlights: [],
      file_overviews: [],
      async_contracts: [],
      sequence_diagram: null,
      findings: [],
    });
    expect(problems.join('\n')).toContain('merge_confidence');
    expect(problems.join('\n')).toContain('findings: missing');
  });

  it('drops non-string highlights and pathless file_overviews', () => {
    const { report, problems } = parseModelReport(
      JSON.stringify({ highlights: ['keep', 7], file_overviews: [{ overview: 'no path' }, { path: 'a.ts' }] }),
    );
    expect(report?.highlights).toEqual(['keep']);
    expect(report?.file_overviews).toEqual([{ path: 'a.ts', overview: '' }]);
    expect(problems.join('\n')).toContain('highlights');
    expect(problems.join('\n')).toContain('file_overviews[0]');
  });
});

describe('readReportFile', () => {
  it('reads and parses a written report', () => {
    const { report, problems } = readReportFile(fileWith(JSON.stringify(FULL)));
    expect(problems).toEqual([]);
    expect(report?.findings).toHaveLength(1);
  });

  it('reports a missing file instead of throwing', () => {
    const { report, problems } = readReportFile('/nope/does/not/exist/findings.json');
    expect(report).toBeNull();
    expect(problems.join('\n')).toContain('could not read');
  });

  it('reports an empty file instead of throwing', () => {
    const { report, problems } = readReportFile(fileWith('   '));
    expect(report).toBeNull();
    expect(problems.join('\n')).toContain('empty');
  });

  it('reports a file of pure prose instead of throwing', () => {
    const { report, problems } = readReportFile(fileWith('the agent wrote its apology here'));
    expect(report).toBeNull();
    expect(problems.join('\n')).toContain('did not contain a usable JSON object');
  });
});
