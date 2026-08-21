import { betterAuth } from 'better-auth';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Env, Principal } from './env';

export function createAuth(env: Env) {
  const githubConfigured = Boolean(env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET);
  const googleConfigured = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  const trustedOrigins = [env.APP_URL, ...(env.APP_URL.startsWith('http://localhost:') ? ['http://localhost:4173'] : [])];
  return betterAuth({
    appName: 'Juror Cloud',
    baseURL: env.APP_URL,
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

  const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
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
