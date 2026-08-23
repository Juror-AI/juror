import type { RepositoryItem, ReviewPresetId } from '../../shared/api';

interface RepositorySetupMutation {
  id: string;
  body: {
    reviewEnabled: boolean;
    reviewPreset?: ReviewPresetId;
  };
}

export function repositorySetupMutations(repositories: RepositoryItem[], selectedIds: ReadonlySet<string>, preset: ReviewPresetId): RepositorySetupMutation[] {
  const mutations: RepositorySetupMutation[] = [];
  for (const repository of repositories) {
    const selected = selectedIds.has(repository.id);
    if (!selected) {
      if (repository.reviewEnabled) mutations.push({ id: repository.id, body: { reviewEnabled: false } });
      continue;
    }
    if (repository.reviewEnabled && repository.reviewPreset === preset && !repository.hostedAutomationBlocked) continue;
    mutations.push({ id: repository.id, body: { reviewEnabled: true, reviewPreset: preset } });
  }
  return mutations;
}
