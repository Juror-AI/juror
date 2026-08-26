/**
 * Normalize Dynamic Client Registration metadata to the narrow public-client
 * profile supported by Juror MCP. OAuth clients are never allowed to bring a
 * secret: Better Auth will enforce PKCE S256 for every registered client.
 */
const publicGrantTypes = new Set(['authorization_code', 'refresh_token']);

export function normalizePublicDcrRegistration(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const registration = input as Record<string, unknown>;
  const authMethod = registration.token_endpoint_auth_method;
  const grantTypes = registration.grant_types;

  if (registration.client_secret !== undefined) return null;
  if (authMethod !== undefined && authMethod !== 'none') return null;

  const normalizedGrantTypes = grantTypes === undefined ? ['authorization_code'] : grantTypes;
  if (!Array.isArray(normalizedGrantTypes)
    || normalizedGrantTypes.length === 0
    || !normalizedGrantTypes.includes('authorization_code')
    || normalizedGrantTypes.some((grantType) => typeof grantType !== 'string' || !publicGrantTypes.has(grantType))) {
    return null;
  }

  // RFC 7591 defaults this field to client_secret_basic. The OpenAI scan can
  // omit it, so pin the safe public-client value before it reaches Better Auth.
  return {
    ...registration,
    token_endpoint_auth_method: 'none',
    grant_types: normalizedGrantTypes,
  };
}
