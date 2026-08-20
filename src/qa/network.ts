/** Shared URL policy for the QA controller and its egress bootstrap. */

import { isIpLiteralHostname, isLoopbackHostname } from '../util/url.js';

export interface QaServiceEnvironment {
  GITHUB_API_URL?: string;
  GITHUB_SERVER_URL?: string;
}

/** Validate an exact browser/service origin, permitting cleartext only on explicit loopback. */
export function qaExactOrigin(raw: string, option = '--allow-origin'): string {
  const parsed = new URL(raw);
  const local = isLoopbackHostname(parsed.hostname);
  const secure = parsed.protocol === 'https:' || (local && parsed.protocol === 'http:');
  if (
    !secure ||
    (parsed.protocol === 'https:' && isIpLiteralHostname(parsed.hostname)) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${option} must be an exact HTTPS origin (or localhost HTTP): ${raw}`);
  }
  return parsed.origin;
}

/** Validate the HTTPS GitHub origin used for promisor Git traffic. */
export function qaGitHubServerOrigin(raw = 'https://github.com'): string {
  const parsed = new URL(raw);
  if (
    parsed.protocol !== 'https:' ||
    !parsed.hostname ||
    isIpLiteralHostname(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('GITHUB_SERVER_URL must be an HTTPS server origin');
  }
  return parsed.origin;
}

/** @internal Origins required before the credential-free QA egress proxy starts. */
export function qaServiceOrigins(environment: QaServiceEnvironment): string[] {
  const origins = [
    'https://api.github.com',
    'https://github.com',
    'https://objects.githubusercontent.com',
    'https://codeload.github.com',
    qaGitHubServerOrigin(environment.GITHUB_SERVER_URL),
    'https://api.openai.com',
    'https://chatgpt.com',
    'https://auth.openai.com',
  ];
  const githubApi = environment.GITHUB_API_URL;
  if (githubApi) origins.push(qaExactOrigin(new URL(githubApi).origin, 'GITHUB_API_URL'));
  return [...new Set(origins)];
}
