import { createAuthClient } from 'better-auth/client';

export const authClient = createAuthClient();

export function signInWith(provider: 'github' | 'google') {
  return authClient.signIn.social({ provider, callbackURL: '/onboarding' });
}

export function linkGitHub() {
  return authClient.linkSocial({ provider: 'github', callbackURL: '/onboarding' });
}

export function signOut() {
  return authClient.signOut().then(() => window.location.assign('/signin'));
}
