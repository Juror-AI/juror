import { isIP } from 'node:net';

/** Return a URL hostname without Node's brackets around IPv6 literals. */
export function bareHostname(hostname: string): string {
  const normalized = hostname.toLowerCase();
  return normalized.startsWith('[') && normalized.endsWith(']')
    ? normalized.slice(1, -1)
    : normalized;
}

/** True when a URL hostname is an IPv4 or IPv6 literal rather than a DNS name. */
export function isIpLiteralHostname(hostname: string): boolean {
  return isIP(bareHostname(hostname)) !== 0;
}

/** True only for the explicit loopback hostnames accepted by local QA workflows. */
export function isLoopbackHostname(hostname: string): boolean {
  const bare = bareHostname(hostname);
  return bare === 'localhost' || bare === '127.0.0.1' || bare === '::1';
}
