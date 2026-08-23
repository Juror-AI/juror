import { describe, expect, it } from 'vitest';

import { builtinModelCatalog } from '../src/config.js';
import { defaultQaConfig } from '../src/qa/config.js';
import {
  PRESET_PROVIDER_SECRETS,
  QA_PROVIDER_SECRETS,
  REVIEW_PRESET_IDS,
  providerSecretsForRun,
} from '../src/cloud/providers.js';
import { REVIEW_PRESETS } from '../src/config.js';
import type { ReviewPreset } from '../src/types.js';

/** The credentials a preset needs, derived from the catalog the runner actually selects. */
function catalogSecretsForPreset(preset: ReviewPreset): string[] {
  const secrets: string[] = [];
  for (const entry of builtinModelCatalog()) {
    if (entry.presets.includes(preset) && !secrets.includes(entry.model.secret)) secrets.push(entry.model.secret);
  }
  return secrets;
}

describe('hosted provider requirements', () => {
  it('covers every review preset the CLI ships', () => {
    expect(REVIEW_PRESET_IDS).toEqual([...REVIEW_PRESETS]);
  });

  // The Worker cannot import src/config.ts — it pulls node:fs and the YAML loader into the
  // bundle — so the table it does import has to be proven equivalent here instead.
  it.each([...REVIEW_PRESETS])('matches the built-in model catalog for the %s preset', (preset) => {
    expect([...PRESET_PROVIDER_SECRETS[preset]].sort()).toEqual(catalogSecretsForPreset(preset).sort());
  });

  it('requires the default QA model provider for QA runs', () => {
    const qaModelId = defaultQaConfig().model.id;
    const qaModel = builtinModelCatalog().find((entry) => entry.model.id === qaModelId);
    expect(qaModel, `QA default model ${qaModelId} is not a built-in model`).toBeDefined();
    expect(QA_PROVIDER_SECRETS).toEqual([qaModel!.model.secret]);
  });

  it('ignores the preset for QA runs and rejects an unknown review preset', () => {
    expect(providerSecretsForRun('qa', 'ultra')).toEqual(QA_PROVIDER_SECRETS);
    expect(providerSecretsForRun('review', 'nonexistent' as ReviewPreset)).toBeNull();
  });
});
