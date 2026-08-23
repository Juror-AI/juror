import { describe, expect, it } from 'vitest';
import { appOrigins, requestAppOrigin } from '../worker/auth';

describe('Juror Cloud application origins', () => {
  const env = {
    APP_URL: 'https://app.juror.dev',
    LEGACY_APP_URL: 'https://juror-cloud.example.workers.dev',
  };

  it('supports the custom domain and the explicit legacy Worker origin', () => {
    expect(appOrigins(env)).toEqual([
      'https://app.juror.dev',
      'https://juror-cloud.example.workers.dev',
    ]);
    expect(requestAppOrigin(env, 'https://app.juror.dev/api/auth/sign-in/social')).toBe('https://app.juror.dev');
    expect(requestAppOrigin(env, 'https://juror-cloud.example.workers.dev/api/auth/sign-in/social')).toBe('https://juror-cloud.example.workers.dev');
  });

  it('falls back to the canonical origin for an untrusted host', () => {
    expect(requestAppOrigin(env, 'https://app.juror.dev.attacker.example/api/auth/sign-in/social')).toBe('https://app.juror.dev');
  });

  it('omits an empty legacy origin', () => {
    expect(appOrigins({ ...env, LEGACY_APP_URL: '' })).toEqual(['https://app.juror.dev']);
  });
});
