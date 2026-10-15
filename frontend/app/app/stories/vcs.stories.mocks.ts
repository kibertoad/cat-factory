// The VCS side of the shared board (`board.stories.mocks.ts`): one GitHub connection, Auth
// Service's repo, the service catalog entry that links the frame to it, and that repo's branches.
import type {
  GitHubAvailableRepo,
  GitHubBranch,
  GitHubConnection,
  GitHubInstallationOption,
  GitHubIssue,
  GitHubPullRequest,
  GitHubRepo,
  Service,
  VcsConnectOption,
} from '@cat-factory/contracts'

export const AUTH_REPO_ID = 101

export const githubConnection: GitHubConnection = {
  installationId: 9001,
  accountLogin: 'acme',
  targetType: 'Organization',
  connectedAt: Date.UTC(2026, 8, 1),
  method: 'app',
  webUrl: 'https://github.com',
  canCreateRepos: false,
  canManageWorkflows: true,
}

export const authRepo: GitHubRepo = {
  githubId: AUTH_REPO_ID,
  installationId: 9001,
  owner: 'acme',
  name: 'auth-service',
  defaultBranch: 'main',
  private: true,
  syncedAt: Date.UTC(2026, 9, 11),
}

/** The monorepo a bootstrap run writes into (`bootstrapJob` in `bootstrap.stories.mocks.ts`). */
export const platformRepo: GitHubRepo = {
  githubId: 734_102,
  installationId: 9001,
  owner: 'acme',
  name: 'platform',
  defaultBranch: 'trunk',
  private: true,
  syncedAt: Date.UTC(2026, 9, 11),
}

/** The catalog row that links the Auth Service frame to its repo. */
export const authServiceRow: Service = {
  id: 'service_auth',
  accountId: null,
  frameBlockId: 'svc_auth',
  installationId: 9001,
  repoGithubId: AUTH_REPO_ID,
  createdAt: Date.UTC(2026, 8, 1),
}

function branch(name: string, isProtected = false): GitHubBranch {
  return {
    repoGithubId: AUTH_REPO_ID,
    name,
    headSha: '4af0cd6e1b2c3d4e5f60718293a4b5c6d7e8f901',
    protected: isProtected,
    syncedAt: Date.UTC(2026, 9, 11),
  }
}

export const authBranches: GitHubBranch[] = [
  branch('main', true),
  branch('release', true),
  branch('spike/refresh-lock'),
  branch('feat/logout-everywhere'),
]

/**
 * The repos the installation can see, as the add-service and docs pickers list them: Auth
 * Service's repo is linked, API Gateway's is not, and one unlinked monorepo.
 */
export const availableRepos: GitHubAvailableRepo[] = [
  {
    githubId: AUTH_REPO_ID,
    owner: 'acme',
    name: 'auth-service',
    defaultBranch: 'main',
    private: true,
    linked: true,
    isMonorepo: false,
    personal: false,
  },
  {
    githubId: 102,
    owner: 'acme',
    name: 'api-gateway',
    defaultBranch: 'main',
    private: true,
    linked: false,
    isMonorepo: false,
    personal: false,
  },
  {
    githubId: 103,
    owner: 'acme',
    name: 'platform',
    defaultBranch: 'trunk',
    private: true,
    linked: false,
    isMonorepo: true,
    personal: false,
  },
]

/** The ways this deployment lets a workspace connect a provider: the GitHub App, a GitLab token. */
export const vcsConnectOptions: VcsConnectOption[] = [
  { provider: 'github', method: 'app', webUrl: 'https://github.com' },
  { provider: 'gitlab', method: 'pat', webUrl: 'https://gitlab.com' },
]

/**
 * The App installations the connect picker lists: the Acme org, not linked to any workspace yet,
 * and a personal account already linked to another workspace.
 */
export const githubInstallations: GitHubInstallationOption[] = [
  {
    installationId: 9001,
    accountLogin: 'acme',
    targetType: 'Organization',
    accountAvatarUrl: null,
    connected: 'none',
  },
  {
    installationId: 9002,
    accountLogin: 'mlindqvist',
    targetType: 'User',
    accountAvatarUrl: null,
    connected: 'other',
  },
]

/** API Gateway's repo, linked beside Auth Service's. */
export const gatewayRepo: GitHubRepo = {
  ...authRepo,
  githubId: 102,
  name: 'api-gateway',
}

/** A synced pull request on the auth service, open unless `overrides` say otherwise. */
export function pullRequest(
  number: number,
  title: string,
  overrides: Partial<GitHubPullRequest> = {},
): GitHubPullRequest {
  return {
    repoGithubId: AUTH_REPO_ID,
    number,
    githubId: 880_000 + number,
    title,
    state: 'open',
    headRef: `feat/pr-${number}`,
    baseRef: 'main',
    headSha: '9c1e4b7a2f60d8e3b5a1c4f7e2d9b8a6c3f1e0d4',
    merged: false,
    author: 'maya',
    updatedAt: Date.UTC(2026, 9, 12, 9),
    syncedAt: Date.UTC(2026, 9, 12, 9, 5),
    ...overrides,
  }
}

/** Two open pull requests on the auth service, one merged, and one on the gateway. */
export const pullRequests: GitHubPullRequest[] = [
  pullRequest(212, 'Rotate refresh tokens on use'),
  pullRequest(209, 'Log out everywhere'),
  pullRequest(204, 'Rate-limit login attempts', { state: 'closed', merged: true }),
  pullRequest(57, 'Forward the request id', { repoGithubId: gatewayRepo.githubId }),
]

/** A synced issue on the auth service, open unless `overrides` say otherwise. */
export function githubIssue(
  number: number,
  title: string,
  overrides: Partial<GitHubIssue> = {},
): GitHubIssue {
  return {
    repoGithubId: AUTH_REPO_ID,
    number,
    githubId: 770_000 + number,
    title,
    state: 'open',
    author: 'priya',
    labels: [],
    updatedAt: Date.UTC(2026, 9, 10, 14),
    syncedAt: Date.UTC(2026, 9, 12, 9, 5),
    ...overrides,
  }
}

/** Two open issues on the auth service, one closed, and one on the gateway. */
export const githubIssues: GitHubIssue[] = [
  githubIssue(231, 'Sessions survive a password change', { labels: ['bug', 'security'] }),
  githubIssue(228, 'Document the token rotation window', { labels: ['docs'] }),
  githubIssue(219, 'Login form accepts a trailing space', { state: 'closed', labels: ['bug'] }),
  githubIssue(61, 'Gateway drops the request id on retries', {
    repoGithubId: gatewayRepo.githubId,
  }),
]
