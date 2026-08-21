export function initialRepositorySettings(actionDetected: boolean): { executionMode: 'unresolved'; actionDetected: boolean; reviewEnabled: false } {
  return { executionMode: 'unresolved', actionDetected, reviewEnabled: false };
}
