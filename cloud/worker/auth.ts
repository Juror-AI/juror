import { betterAuth } from 'better-auth';
import { jwt } from 'better-auth/plugins';
import { mcp } from '@better-auth/mcp';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Env, Principal } from './env';

type AppOriginEnv = { APP_URL: string; LEGACY_APP_URL?: string };

export function appOrigins(env: AppOriginEnv): string[] {
  return [...new Set([env.APP_URL, env.LEGACY_APP_URL].filter((value): value is string => Boolean(value)))];
}

export function requestAppOrigin(env: AppOriginEnv, requestUrl?: string): string {
  if (!requestUrl) return env.APP_URL;
  const origin = new URL(requestUrl).origin;
  return appOrigins(env).includes(origin) ? origin : env.APP_URL;
}

/** The canonical OAuth issuer and protected resource identifiers are stable in production. */
export function oauthIssuerUrl(env: AppOriginEnv, requestUrl?: string): string {
  return new URL('/api/auth', requestAppOrigin(env, requestUrl)).toString().replace(/\/$/, '');
}

export function mcpResourceUrl(env: AppOriginEnv, requestUrl?: string): string {
  return new URL('/mcp', requestAppOrigin(env, requestUrl)).toString().replace(/\/$/, '');
}

export function createAuth(env: Env, requestUrl?: string) {
  const githubConfigured = Boolean(env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET);
  const googleConfigured = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  const trustedOrigins = [...appOrigins(env), ...(env.APP_URL.startsWith('http://localhost:') ? ['http://localhost:4173'] : [])];
  return betterAuth({
    appName: 'Juror Cloud',
    baseURL: requestAppOrigin(env, requestUrl),
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    trustedOrigins,
    socialProviders: {
      ...(githubConfigured ? { github: {
        clientId: env.GITHUB_OAUTH_CLIENT_ID!,
        clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET!,
        scope: ['read:user', 'user:email'],
      } } : {}),
      ...(googleConfigured ? { google: {
        clientId: env.GOOGLE_CLIENT_ID!,
        clientSecret: env.GOOGLE_CLIENT_SECRET!,
      } } : {}),
    },
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ['github', 'google'],
      },
    },
    plugins: [
      jwt({ jwt: { issuer: oauthIssuerUrl(env, requestUrl) }, disableSettingJwtHeader: true }),
      // mcp() is Better Auth's OAuth 2.1 Provider configured as an RFC 9728
      // protected resource. The registration route below accepts public DCR
      // clients only; Better Auth requires PKCE S256 for those clients. Tokens
      // are audience-bound to /mcp and expire after five minutes.
      mcp({
        loginPage: '/signin',
        consentPage: '/signin',
        resource: mcpResourceUrl(env, requestUrl),
        scopes: ['juror.read', 'juror.reviews.write'],
        resources: [{ identifier: mcpResourceUrl(env, requestUrl), name: 'Juror MCP', allowedScopes: ['juror.read', 'juror.reviews.write'], accessTokenTtl: 300 }],
        accessTokenExpiresIn: 300,
        grantTypes: ['authorization_code'],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationRequirePKCE: true,
        clientRegistrationDefaultResources: [mcpResourceUrl(env, requestUrl)],
        clientRegistrationDefaultScopes: ['juror.read'],
        clientRegistrationAllowedScopes: ['juror.reviews.write'],
      }),
    ],
    advanced: {
      database: { joins: true },
      useSecureCookies: env.APP_URL.startsWith('https://'),
    },
  });
}

export async function requirePrincipal(c: Context<{ Bindings: Env; Variables: { requestId: string; principal: Principal } }>): Promise<Principal> {
  if (String(c.env.DEV_BYPASS_AUTH) === 'true') {
    const workspace = await c.env.DB.prepare('SELECT id FROM workspace ORDER BY created_at LIMIT 1').first<{ id: string }>();
    return { userId: 'development-user', workspaceId: c.req.header('x-juror-workspace') ?? workspace?.id ?? 'development-workspace', role: 'admin' };
  }

  const session = await createAuth(c.env, c.req.url).api.getSession({ headers: c.req.raw.headers });
  if (!session) throw new HTTPException(401, { message: 'Unauthorized' });
  const requestedWorkspace = c.req.header('x-juror-workspace');
  const membership = requestedWorkspace
    ? await c.env.DB.prepare('SELECT workspace_id, role FROM membership WHERE user_id = ? AND workspace_id = ?').bind(session.user.id, requestedWorkspace).first<{ workspace_id: string; role: 'admin' | 'member' }>()
    : await c.env.DB.prepare('SELECT workspace_id, role FROM membership WHERE user_id = ? ORDER BY created_at LIMIT 1').bind(session.user.id).first<{ workspace_id: string; role: 'admin' | 'member' }>();
  if (!membership) throw new HTTPException(403, { message: 'No workspace access' });
  return { userId: session.user.id, workspaceId: membership.workspace_id, role: membership.role };
}

export function requireAdmin(principal: Principal): void {
  if (principal.role !== 'admin') throw new HTTPException(403, { message: 'Admin access required' });
}
