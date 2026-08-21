import type { RepositoryItem, ReviewPresetId } from '../../shared/api';

interface RepositorySetupMutation {
  id: string;
  body: {
    executionMode?: 'cloud' | 'action';
    confirmActionDisabled?: boolean;
    reviewEnabled: boolean;
    reviewPreset?: ReviewPresetId;
  };
}

export function repositorySetupMutations(repositories: RepositoryItem[], selectedIds: ReadonlySet<string>, mode: 'cloud' | 'action', preset: ReviewPresetId): RepositorySetupMutation[] {
  return repositories.map((repository) => {
    if (!selectedIds.has(repository.id)) return { id: repository.id, body: { reviewEnabled: false } };
    if (mode === 'action') return { id: repository.id, body: { executionMode: 'action', confirmActionDisabled: false, reviewEnabled: false } };
    return { id: repository.id, body: { executionMode: 'cloud', confirmActionDisabled: true, reviewEnabled: true, reviewPreset: preset } };
  });
}
