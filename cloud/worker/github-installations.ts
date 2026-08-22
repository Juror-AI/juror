export interface AccessibleGitHubRepository {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  archived: boolean;
  defaultBranch: string;
  owner: { login: string };
}

export interface AccessibleGitHubInstallation {
  id: number;
  appSlug: string;
  account: { login: string; type: string };
  permissions: Record<string, string>;
  repositorySelection: string;
  repositories: AccessibleGitHubRepository[];
}

type Requester = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function headers(accessToken: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${accessToken}`,
    'user-agent': 'juror-cloud/1',
    'x-github-api-version': '2022-11-28',
  };
}

function hasNextPage(response: Response): boolean {
  return /<[^>]+>;\s*rel="next"/.test(response.headers.get('link') ?? '');
}

async function selectedRepositories(accessToken: string, installationId: number, request: Requester): Promise<AccessibleGitHubRepository[]> {
  const repositories: AccessibleGitHubRepository[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const response = await request(`https://api.github.com/user/installations/${installationId}/repositories?per_page=100&page=${page}`, { headers: headers(accessToken) });
    if (!response.ok) throw new Error(`GitHub repository discovery failed (${response.status})`);
    const body = await response.json<{ repositories?: Array<Record<string, any>> }>();
    const rows = Array.isArray(body.repositories) ? body.repositories : [];
    for (const repository of rows) {
      if (!Number.isSafeInteger(repository.id) || typeof repository.name !== 'string' || typeof repository.full_name !== 'string' || typeof repository.owner?.login !== 'string') continue;
      repositories.push({
        id: repository.id,
        name: repository.name,
        fullName: repository.full_name,
        private: Boolean(repository.private),
        archived: Boolean(repository.archived),
        defaultBranch: typeof repository.default_branch === 'string' ? repository.default_branch : 'main',
        owner: { login: repository.owner.login },
      });
    }
    if (!hasNextPage(response)) break;
  }
  return repositories;
}

/**
 * Installations available to the linked GitHub identity for this App. GitHub user access tokens
 * are App-scoped, but the slug check also fails closed if OAuth credentials are ever miswired.
 */
export async function discoverGitHubInstallations(accessToken: string, appSlug: string, request: Requester = fetch): Promise<AccessibleGitHubInstallation[]> {
  const installations: Array<Record<string, any>> = [];
  for (let page = 1; page <= 100; page += 1) {
    const response = await request(`https://api.github.com/user/installations?per_page=100&page=${page}`, { headers: headers(accessToken) });
    if (!response.ok) throw new Error(`GitHub installation discovery failed (${response.status})`);
    const body = await response.json<{ installations?: Array<Record<string, any>> }>();
    installations.push(...(Array.isArray(body.installations) ? body.installations : []));
    if (!hasNextPage(response)) break;
  }
  const matchingInstallations = installations.filter((installation) => (
    Number.isSafeInteger(installation.id)
    && installation.app_slug === appSlug
    && typeof installation.account?.login === 'string'
    && typeof installation.account?.type === 'string'
  ));
  return Promise.all(matchingInstallations.map(async (installation) => ({
    id: installation.id,
    appSlug: installation.app_slug,
    account: { login: installation.account.login, type: installation.account.type },
    permissions: installation.permissions && typeof installation.permissions === 'object' ? installation.permissions : {},
    repositorySelection: typeof installation.repository_selection === 'string' ? installation.repository_selection : 'selected',
    repositories: await selectedRepositories(accessToken, installation.id, request),
  })));
}

/** Convert a verified user-installation response into the same payload the webhook provisioner owns. */
export function installationProvisioningPayload(installation: AccessibleGitHubInstallation): Record<string, unknown> {
  return {
    installation: {
      id: installation.id,
      account: installation.account,
      permissions: installation.permissions,
      repository_selection: installation.repositorySelection,
    },
    repositories: installation.repositories.map((repository) => ({
      id: repository.id,
      name: repository.name,
      full_name: repository.fullName,
      private: repository.private,
      archived: repository.archived,
      default_branch: repository.defaultBranch,
      owner: repository.owner,
    })),
  };
}
