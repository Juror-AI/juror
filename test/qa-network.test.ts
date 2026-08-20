import { describe, expect, it } from 'vitest';

import {
  qaExactOrigin,
  qaGitHubServerOrigin,
  qaServiceOrigins,
} from '../src/qa/network.js';
import { bareHostname, isIpLiteralHostname, isLoopbackHostname } from '../src/util/url.js';

describe('QA network policy', () => {
  it('normalizes Node bracketed IPv6 hostnames without widening the loopback policy', () => {
    expect(new URL('http://[::1]:4173').hostname).toBe('[::1]');
    expect(bareHostname('[::1]')).toBe('::1');
    expect(isLoopbackHostname('[::1]')).toBe(true);
    expect(isLoopbackHostname('::1')).toBe(true);
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('[::2]')).toBe(false);
    expect(isLoopbackHostname('127.0.0.2')).toBe(false);
    expect(isIpLiteralHostname('[2001:db8::1]')).toBe(true);
    expect(isIpLiteralHostname('203.0.113.10')).toBe(true);
    expect(isIpLiteralHostname('staging.example.test')).toBe(false);
  });

  it('accepts bracketed IPv6 loopback HTTP as an exact local QA origin', () => {
    expect(qaExactOrigin('http://[::1]:4173')).toBe('http://[::1]:4173');
    expect(() => qaExactOrigin('http://[::2]:4173')).toThrow('must be an exact HTTPS origin');
  });

  it('rejects HTTPS IP literals that the SNI-enforcing egress proxy cannot authorize', () => {
    expect(() => qaExactOrigin('https://203.0.113.10')).toThrow(
      'must be an exact HTTPS origin',
    );
    expect(() => qaExactOrigin('https://[2001:db8::1]')).toThrow(
      'must be an exact HTTPS origin',
    );
    expect(() => qaGitHubServerOrigin('https://203.0.113.10')).toThrow(
      'GITHUB_SERVER_URL must be an HTTPS server origin',
    );
  });

  it('includes the validated GitHub Enterprise origin needed for promisor Git traffic', () => {
    const origins = qaServiceOrigins({
      GITHUB_SERVER_URL: 'https://github.enterprise.test',
      GITHUB_API_URL: 'https://api.github.enterprise.test/api/v3',
    });

    expect(origins).toContain('https://github.enterprise.test');
    expect(origins.filter((origin) => origin === 'https://github.enterprise.test')).toHaveLength(1);
    expect(origins).toContain('https://api.github.enterprise.test');
    expect(origins).toContain('https://api.github.com');
  });

  it('rejects a non-origin or cleartext GitHub server URL', () => {
    expect(() => qaGitHubServerOrigin('https://github.enterprise.test/git'))
      .toThrow('GITHUB_SERVER_URL must be an HTTPS server origin');
    expect(() => qaGitHubServerOrigin('http://github.enterprise.test'))
      .toThrow('GITHUB_SERVER_URL must be an HTTPS server origin');
  });
});
