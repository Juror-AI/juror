import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

describe('post-proof launch playbook', () => {
  it('keeps the campaign no-go until representative proof and retention exist', () => {
    const playbook = read('docs/launch/README.md');
    expect(playbook).toContain('Status: **NO-GO**');
    for (const dependency of ['#40', '#42', '#44']) expect(playbook).toContain(dependency);
    for (const gate of ['Onboarding', 'Representative quality', 'Public proof', 'Security', 'Retention']) {
      expect(playbook).toContain(`| ${gate} |`);
    }
  });

  it('covers every requested channel, attribution stage, and retrospective', () => {
    const playbook = read('docs/launch/README.md');
    for (const channel of ['Hacker News', 'Reddit', 'X', 'LinkedIn', 'GitHub Community', 'GitHub Marketplace']) {
      expect(playbook).toContain(channel);
    }
    for (const artifact of ['article-draft.md', 'campaign-template.csv', 'retrospective-template.md']) {
      expect(playbook).toContain(artifact);
    }
  });

  it('tracks the source funnel without repository identity', () => {
    const rows = read('docs/launch/campaign-template.csv').trim().split('\n').map((line) => line.split(','));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveLength(rows[0]?.length ?? 0);
    expect(rows[0]).toEqual(expect.arrayContaining([
      'source_channel',
      'aggregate_visits',
      'setup_starts',
      'successful_first_multifamily_reviews',
      'week_four_retained_repositories',
    ]));
    expect(rows[0]).not.toEqual(expect.arrayContaining(['repository', 'owner', 'pull_request']));
  });
});
