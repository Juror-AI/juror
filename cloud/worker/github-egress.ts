export interface SandboxRunParams {
  runId: string;
  repository: string;
  prNumber: number;
  revisionSha: string;
  kind: 'review' | 'qa';
}

const CODEWHALE_RELEASE_PREFIX = '/Hmbown/CodeWhale/releases/download/v0.9.7/';
const CODEWHALE_RELEASE_ASSETS = new Set([
  'codewhale-artifacts-sha256.txt',
  'codewhale-linux-x64',
  'codew-linux-x64',
]);

/** Allow only the pinned Linux artifacts required by the trusted CodeWhale launcher. */
export function sandboxCodeWhaleReleaseRequestAllowed(request: Request): boolean {
  const url = new URL(request.url);
  if (request.method.toUpperCase() !== 'GET' || url.protocol !== 'https:' || url.hostname !== 'github.com' || url.search !== '') return false;
  if (!url.pathname.startsWith(CODEWHALE_RELEASE_PREFIX)) return false;
  return CODEWHALE_RELEASE_ASSETS.has(url.pathname.slice(CODEWHALE_RELEASE_PREFIX.length));
}

/** Permit only Git's read protocol and the exact REST reads used by hosted Juror. */
export function sandboxGithubRequestAllowed(request: Request, params: SandboxRunParams): boolean {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(params.repository)) return false;
  const method = request.method.toUpperCase();
  const repositoryPath = params.repository.split('/').map(encodeURIComponent).join('/');
  if (url.hostname === 'github.com') {
    if (sandboxCodeWhaleReleaseRequestAllowed(request)) return true;
    const gitPath = `/${repositoryPath}.git`;
    if (method === 'GET' && url.pathname === `${gitPath}/info/refs`) {
      return url.searchParams.size === 1 && url.searchParams.get('service') === 'git-upload-pack';
    }
    return method === 'POST' && url.pathname === `${gitPath}/git-upload-pack` && url.search === '';
  }
  if (url.hostname !== 'api.github.com' || method !== 'GET') return false;
  const prefix = `/repos/${repositoryPath}`;
  if (url.pathname === `${prefix}/pulls/${params.prNumber}`) return url.search === '';
  if (url.pathname === `${prefix}/issues/${params.prNumber}/comments`) {
    return url.searchParams.size === 2
      && url.searchParams.get('per_page') === '100'
      && /^\d+$/.test(url.searchParams.get('page') ?? '');
  }
  const commit = url.pathname.startsWith(`${prefix}/commits/`) ? url.pathname.slice(`${prefix}/commits/`.length) : '';
  if (/^[0-9a-f]{40}$/i.test(commit)) return url.search === '';
  const comparison = url.pathname.startsWith(`${prefix}/compare/`) ? url.pathname.slice(`${prefix}/compare/`.length) : '';
  if (/^[0-9a-f]{40}\.\.\.[0-9a-f]{40}$/i.test(comparison)) {
    return url.search === '' || (url.searchParams.size === 2 && url.searchParams.get('per_page') === '1' && url.searchParams.get('page') === '2');
  }
  return false;
}
