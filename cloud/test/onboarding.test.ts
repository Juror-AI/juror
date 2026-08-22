import { describe, expect, it } from 'vitest';
import type { RepositoryItem } from '../shared/api';
import { repositorySetupMutations } from '../src/lib/onboarding';
import { initialRepositorySettings } from '../worker/repository-settings';

const repository = (id: string): RepositoryItem => ({
  id, owner: 'octo', name: id, fullName: `octo/${id}`, private: false, defaultBranch: 'main', connectionStatus: 'healthy',
  hostedAutomationBlocked: false, reviewEnabled: false, reviewPreset: 'fast', publishMode: 'all', severityFloor: 'P3',
  qaEnabled: false, qaReady: false, qaTarget: null, allowedOrigins: [], hasSessionBootstrap: false, hasSecretHeaders: false,
  hasResetHook: false, evidencePolicy: { screenshot: 'failure', trace: 'failure', video: 'off' }, latestRun: null,
});

describe('onboarding repository selection', () => {
  it('enables hosted reviews only for repositories the user selected', () => {
    expect(repositorySetupMutations([repository('one'), repository('two')], new Set(['two']), 'starter')).toEqual([
      { id: 'one', body: { reviewEnabled: false } },
      { id: 'two', body: { reviewEnabled: true, reviewPreset: 'starter' } },
    ]);
  });

  it('requests a fresh server-side workflow check when a blocked repository is selected', () => {
    const blocked = { ...repository('blocked'), hostedAutomationBlocked: true };
    expect(repositorySetupMutations([blocked], new Set(['blocked']), 'fast')).toEqual([
      { id: 'blocked', body: { reviewEnabled: true, reviewPreset: 'fast' } },
    ]);
  });

  it('provisions every newly accessible repository as cloud-only and disabled', () => {
    expect(initialRepositorySettings()).toEqual({ reviewEnabled: false });
  });
});
