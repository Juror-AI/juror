import { createAuthClient } from 'better-auth/client';
import { oauthProviderClient } from '@better-auth/oauth-provider/client';

// Preserves the signed OAuth authorization query while a user signs in with
// GitHub or Google, allowing the Better Auth MCP provider to resume the flow.
export const authClient = createAuthClient({ plugins: [oauthProviderClient()] });

export function signInWith(provider: 'github' | 'google', callbackURL = '/onboarding') {
  return authClient.signIn.social({ provider, callbackURL });
}

export function linkGitHub() {
  return authClient.linkSocial({ provider: 'github', callbackURL: '/onboarding' });
}

export function signOut() {
  return authClient.signOut().then(() => window.location.assign('/signin'));
}
