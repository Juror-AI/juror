import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const script = path.resolve('qa/proxy-url.mjs');

function resolveProxyUrl(address: string) {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    input: address,
  });
}

describe('QA proxy address resolution', () => {
  it('uses the inspected private network IP without Docker alias DNS', () => {
    const result = resolveProxyUrl('172.19.0.2\n');

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('http://172.19.0.2:8080\n');
  });

  it.each([
    ['carrier-grade NAT', '100.64.0.2'],
    ['benchmarking', '198.18.0.2'],
  ])('accepts Docker internal addresses from the %s range', (_label, address) => {
    const result = resolveProxyUrl(`${address}\n`);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`http://${address}:8080\n`);
  });

  it.each([
    ['an empty address', ''],
    ['a public address', '203.0.113.8'],
    ['an IPv6 address', 'fd00::2'],
    ['a loopback address', '127.0.0.1'],
    ['a link-local address', '169.254.0.2'],
    ['a multicast address', '224.0.0.2'],
    ['multiple addresses', '172.19.0.2\n172.19.0.3'],
  ])('rejects %s', (_label, address) => {
    const result = resolveProxyUrl(address);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toBe('');
  });
});
