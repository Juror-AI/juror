const RESERVED_QA_HOSTS = new Set([
  'github.com', 'api.github.com', 'api.openai.com', 'api.anthropic.com',
  'api.x.ai', 'api.deepseek.com', 'api.fireworks.ai', 'openrouter.ai',
  'api.moonshot.ai',
]);

/** Returns the first origin that cannot safely receive hosted QA traffic or secrets. */
export function unsafeQaOrigin(origins: string[], appUrl: string): string | null {
  const appHostname = new URL(appUrl).hostname.toLowerCase();
  return origins.find((origin) => {
    const url = new URL(origin);
    const hostname = url.hostname.toLowerCase();
    const isIpLiteral = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
    return url.protocol !== 'https:' || isIpLiteral || hostname === 'localhost'
      || hostname.endsWith('.localhost') || hostname.endsWith('.local')
      || hostname.endsWith('.internal') || hostname === appHostname
      || RESERVED_QA_HOSTS.has(hostname);
  }) ?? null;
}
