import { describe, expect, it } from 'vitest';
import { normalizePublicDcrRegistration } from '../worker/dcr';

describe('public Dynamic Client Registration', () => {
  it('normalizes an omitted client authentication method to the public profile', () => {
    expect(normalizePublicDcrRegistration({
      client_name: 'ChatGPT',
      redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      grant_types: ['authorization_code', 'refresh_token'],
    })).toMatchObject({
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
    });
  });

  it('defaults an otherwise valid registration to authorization_code only', () => {
    expect(normalizePublicDcrRegistration({ client_name: 'OpenAI' })).toMatchObject({
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
    });
  });

  it.each([
    { token_endpoint_auth_method: 'client_secret_basic' },
    { client_secret: 'never-accepted' },
    { grant_types: ['refresh_token'] },
    { grant_types: ['authorization_code', 'client_credentials'] },
  ])('rejects registrations outside the public PKCE profile: %o', (metadata) => {
    expect(normalizePublicDcrRegistration(metadata)).toBeNull();
  });
});
