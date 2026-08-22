import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Env } from '../worker/env';
import { createGitHubAppJwt } from '../worker/github';

function environment(privateKey: string): Env {
  return {
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: privateKey,
  } as unknown as Env;
}

function privateKey(type: 'pkcs1' | 'pkcs8'): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type, format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return privateKey;
}

describe('GitHub App JWT signing', () => {
  it('accepts GitHub-generated PKCS#1 RSA private keys', async () => {
    const token = await createGitHubAppJwt(environment(privateKey('pkcs1')));
    expect(token.split('.')).toHaveLength(3);
  });

  it('continues to accept PKCS#8 private keys with escaped newlines', async () => {
    const escaped = privateKey('pkcs8').replace(/\n/g, '\\n');
    const token = await createGitHubAppJwt(environment(escaped));
    expect(token.split('.')).toHaveLength(3);
  });
});
