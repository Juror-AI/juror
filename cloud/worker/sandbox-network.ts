/** QA targets are credential-bearing and must never be reachable from an untrusted review run. */
export function qaTargetHosts(kind: 'review' | 'qa', allowedOrigins: readonly string[]): string[] {
  if (kind !== 'qa') return [];
  return [...new Set(allowedOrigins.map((origin) => new URL(origin).hostname))];
}
