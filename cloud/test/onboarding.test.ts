import { describe, expect, it } from 'vitest';
import type { RepositoryItem } from '../shared/api';
import { repositorySetupMutations } from '../src/lib/onboarding';
import { initialRepositorySettings } from '../worker/repository-settings';

const repository = (id: string): RepositoryItem => ({
  id, owner: 'octo', name: id, fullName: `octo/${id}`, private: false, defaultBranch: 'main', connectionStatus: 'healthy',
  executionMode: 'unresolved', actionDetected: false, reviewEnabled: false, reviewPreset: 'fast', publishMode: 'all', severityFloor: 'P3',
  qaEnabled: false, qaReady: false, qaTarget: null, allowedOrigins: [], hasSessionBootstrap: false, hasSecretHeaders: false,
  hasResetHook: false, evidencePolicy: { screenshot: 'failure', trace: 'failure', video: 'off' }, latestRun: null,
});

describe('onboarding repository selection', () => {
  it('enables Cloud reviews only for repositories the user selected', () => {
    expect(repositorySetupMutations([repository('one'), repository('two')], new Set(['two']), 'cloud', 'starter')).toEqual([
      { id: 'one', body: { reviewEnabled: false } },
      { id: 'two', body: { executionMode: 'cloud', confirmActionDisabled: true, reviewEnabled: true, reviewPreset: 'starter' } },
    ]);
  });

  it('keeps Action mode out of hosted execution', () => {
    expect(repositorySetupMutations([repository('one')], new Set(['one']), 'action', 'fast')).toEqual([
      { id: 'one', body: { executionMode: 'action', confirmActionDisabled: false, reviewEnabled: false } },
    ]);
  });

  it('provisions every newly accessible repository as unresolved and disabled', () => {
    expect(initialRepositorySettings(false)).toEqual({ executionMode: 'unresolved', actionDetected: false, reviewEnabled: false });
    expect(initialRepositorySettings(true)).toEqual({ executionMode: 'unresolved', actionDetected: true, reviewEnabled: false });
  });
});
