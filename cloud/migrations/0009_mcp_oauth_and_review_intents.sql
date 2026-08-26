-- Better Auth OAuth 2.1 Provider / MCP plugin schema (Better Auth 1.7.1).
-- OAuth values use the provider's camelCase field names so its D1 adapter can
-- perform PKCE, DCR, token revocation, and audience-bound token verification.
CREATE TABLE IF NOT EXISTS "jwks" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "publicKey" TEXT NOT NULL,
  "privateKey" TEXT NOT NULL,
  "createdAt" INTEGER NOT NULL,
  "expiresAt" INTEGER,
  "alg" TEXT,
  "crv" TEXT
);

CREATE TABLE IF NOT EXISTS "oauthClient" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "clientId" TEXT NOT NULL UNIQUE,
  "clientSecret" TEXT,
  "clientDiscoveryId" TEXT,
  "disabled" INTEGER NOT NULL DEFAULT 0,
  "skipConsent" INTEGER,
  "enableEndSession" INTEGER,
  "subjectType" TEXT,
  "scopes" TEXT,
  "clientCredentialsScopes" TEXT NOT NULL DEFAULT '[]',
  "userId" TEXT REFERENCES "user"("id") ON DELETE SET NULL,
  "createdAt" INTEGER,
  "updatedAt" INTEGER,
  "name" TEXT,
  "uri" TEXT,
  "icon" TEXT,
  "contacts" TEXT,
  "tos" TEXT,
  "policy" TEXT,
  "softwareId" TEXT,
  "softwareVersion" TEXT,
  "softwareStatement" TEXT,
  "redirectUris" TEXT NOT NULL,
  "postLogoutRedirectUris" TEXT,
  "backchannelLogoutUri" TEXT,
  "backchannelLogoutSessionRequired" INTEGER,
  "tokenEndpointAuthMethod" TEXT,
  "applicationType" TEXT,
  "jwks" TEXT,
  "jwksUri" TEXT,
  "grantTypes" TEXT,
  "responseTypes" TEXT,
  "requirePKCE" INTEGER,
  "dpopBoundAccessTokens" INTEGER NOT NULL DEFAULT 0,
  "referenceId" TEXT,
  "metadata" TEXT
);
CREATE INDEX IF NOT EXISTS "oauthClient_userId_idx" ON "oauthClient"("userId");

CREATE TABLE IF NOT EXISTS "oauthResource" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "identifier" TEXT NOT NULL UNIQUE,
  "name" TEXT NOT NULL,
  "accessTokenTtl" INTEGER,
  "refreshTokenTtl" INTEGER,
  "signingAlgorithm" TEXT,
  "signingKeyId" TEXT,
  "allowedScopes" TEXT,
  "customClaims" TEXT,
  "dpopBoundAccessTokensRequired" INTEGER NOT NULL DEFAULT 0,
  "disabled" INTEGER NOT NULL DEFAULT 0,
  "createdAt" INTEGER,
  "updatedAt" INTEGER,
  "policyVersion" INTEGER NOT NULL DEFAULT 1,
  "metadata" TEXT
);

CREATE TABLE IF NOT EXISTS "oauthClientResource" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "clientId" TEXT NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE,
  "resourceId" TEXT NOT NULL REFERENCES "oauthResource"("identifier") ON DELETE CASCADE,
  "metadata" TEXT,
  "createdAt" INTEGER,
  UNIQUE("clientId", "resourceId")
);
CREATE INDEX IF NOT EXISTS "oauthClientResource_clientId_idx" ON "oauthClientResource"("clientId");
CREATE INDEX IF NOT EXISTS "oauthClientResource_resourceId_idx" ON "oauthClientResource"("resourceId");

CREATE TABLE IF NOT EXISTS "oauthRefreshToken" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "clientId" TEXT NOT NULL REFERENCES "oauthClient"("clientId"),
  "sessionId" TEXT REFERENCES "session"("id") ON DELETE SET NULL,
  "userId" TEXT NOT NULL REFERENCES "user"("id"),
  "referenceId" TEXT,
  "authorizationCodeId" TEXT,
  "resources" TEXT,
  "requestedUserInfoClaims" TEXT,
  "expiresAt" INTEGER NOT NULL,
  "createdAt" INTEGER NOT NULL,
  "revoked" INTEGER,
  "rotatedAt" INTEGER,
  "rotationReplayResponse" TEXT,
  "rotationReplayExpiresAt" INTEGER,
  "authTime" INTEGER,
  "confirmation" TEXT,
  "scopes" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "oauthRefreshToken_clientId_idx" ON "oauthRefreshToken"("clientId");
CREATE INDEX IF NOT EXISTS "oauthRefreshToken_sessionId_idx" ON "oauthRefreshToken"("sessionId");
CREATE INDEX IF NOT EXISTS "oauthRefreshToken_userId_idx" ON "oauthRefreshToken"("userId");
CREATE INDEX IF NOT EXISTS "oauthRefreshToken_authorizationCodeId_idx" ON "oauthRefreshToken"("authorizationCodeId");

CREATE TABLE IF NOT EXISTS "oauthAccessToken" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "clientId" TEXT NOT NULL REFERENCES "oauthClient"("clientId"),
  "sessionId" TEXT REFERENCES "session"("id") ON DELETE SET NULL,
  "userId" TEXT REFERENCES "user"("id"),
  "referenceId" TEXT,
  "authorizationCodeId" TEXT,
  "resources" TEXT,
  "requestedUserInfoClaims" TEXT,
  "refreshId" TEXT REFERENCES "oauthRefreshToken"("id"),
  "expiresAt" INTEGER NOT NULL,
  "createdAt" INTEGER NOT NULL,
  "revoked" INTEGER,
  "confirmation" TEXT,
  "scopes" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "oauthAccessToken_clientId_idx" ON "oauthAccessToken"("clientId");
CREATE INDEX IF NOT EXISTS "oauthAccessToken_sessionId_idx" ON "oauthAccessToken"("sessionId");
CREATE INDEX IF NOT EXISTS "oauthAccessToken_userId_idx" ON "oauthAccessToken"("userId");
CREATE INDEX IF NOT EXISTS "oauthAccessToken_refreshId_idx" ON "oauthAccessToken"("refreshId");
CREATE INDEX IF NOT EXISTS "oauthAccessToken_authorizationCodeId_idx" ON "oauthAccessToken"("authorizationCodeId");

CREATE TABLE IF NOT EXISTS "oauthConsent" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "clientId" TEXT NOT NULL REFERENCES "oauthClient"("clientId"),
  "userId" TEXT REFERENCES "user"("id"),
  "referenceId" TEXT,
  "resources" TEXT,
  "requestedUserInfoClaims" TEXT,
  "scopes" TEXT NOT NULL,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "oauthConsent_clientId_idx" ON "oauthConsent"("clientId");
CREATE INDEX IF NOT EXISTS "oauthConsent_userId_idx" ON "oauthConsent"("userId");

CREATE TABLE IF NOT EXISTS "oauthClientAssertion" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "expiresAt" INTEGER NOT NULL
);

-- Confirmation records intentionally store opaque IDs and a SHA, never source,
-- prompt text, findings, provider credentials, or tool arguments.
CREATE TABLE IF NOT EXISTS review_intent (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repository(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES run(id) ON DELETE SET NULL,
  pr_number INTEGER NOT NULL,
  revision_sha TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('start', 'rerun')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS review_intent_consume_idx ON review_intent(id, user_id, workspace_id, action, expires_at, consumed_at);
CREATE INDEX IF NOT EXISTS review_intent_expiry_idx ON review_intent(expires_at);
