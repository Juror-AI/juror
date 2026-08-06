/**
 * The adapter lookup table.
 *
 * Adapters are registered here and nowhere else, so `HarnessId` in `types.ts` and the set of
 * shipped harnesses cannot drift apart — the `Record<HarnessId, Harness>` annotation makes
 * a forgotten adapter a compile error rather than a runtime surprise mid-review.
 */

import type { Harness, HarnessId } from '../types.js';
import { claudeHarness } from './claude.js';
import { codexHarness } from './codex.js';
import { genericOpenAIHarness } from './generic-openai.js';
import { grokHarness } from './grok.js';
import { kimiHarness } from './kimi.js';
import { opencodeHarness } from './opencode.js';

export const HARNESSES: Record<HarnessId, Harness> = {
  'claude-code': claudeHarness,
  codex: codexHarness,
  'grok-build': grokHarness,
  'kimi-code': kimiHarness,
  opencode: opencodeHarness,
  'generic-openai': genericOpenAIHarness,
};

export function getHarness(id: HarnessId): Harness {
  const harness = HARNESSES[id];
  // `id` arrives from `.juror.yml`, so despite the type it can be any string at runtime.
  if (!harness) {
    throw new Error(
      `Unknown harness "${id}". Valid harnesses: ${Object.keys(HARNESSES).sort().join(', ')}`,
    );
  }
  return harness;
}
