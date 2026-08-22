import type { RepositoryItem, ReviewPresetId } from '../../shared/api';

interface RepositorySetupMutation {
  id: string;
  body: {
    reviewEnabled: boolean;
    reviewPreset?: ReviewPresetId;
  };
}

export function repositorySetupMutations(repositories: RepositoryItem[], selectedIds: ReadonlySet<string>, preset: ReviewPresetId): RepositorySetupMutation[] {
  return repositories.map((repository) => {
    if (!selectedIds.has(repository.id)) return { id: repository.id, body: { reviewEnabled: false } };
    return { id: repository.id, body: { reviewEnabled: true, reviewPreset: preset } };
  });
}
