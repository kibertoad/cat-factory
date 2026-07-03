import { randomUUID } from 'node:crypto'
import type {
  Clock,
  GitHubClient,
  GitHubRepo,
  IdGenerator,
  InstallationPermissions,
  Paged,
  RateLimitRepository,
  RateLimitSnapshot,
} from '@cat-factory/kernel'
import type { VcsIdentityRegistry, VcsProvider } from '@cat-factory/kernel'
import { type AppTokenSource, FetchGitHubClient, GitHubIdentityResolver } from '@cat-factory/server'
import {
  asGitHubClient,
  FetchGitLabClient,
  GITLAB_PUBLIC_API_BASE,
  GitLabIdentityResolver,
  StaticGitLabTokenSource,
} from '@cat-factory/gitlab'
import type { PatAccount } from './installations.js'

// PAT-backed GitHub access for local mode. The shared FetchGitHubClient normally mints
// per-installation tokens via the GitHub App registry; here we feed it a static-token
// source returning the developer's PAT, so the CI gate + merge / mergeability
// providers (wired in container.ts from this client) hit real GitHub with the PAT.
//
// The app-JWT paths (installation discovery / listing) are never reached in local
// mode — those are the GitHub-App connect flow, which local mode replaces with the
// linkRepo helper — so they throw rather than pretend to work.

// The scopes a local-mode PAT needs. Agent containers clone/push branches and open PRs
// (`repo`, which also covers reading the PR head's Actions check runs for the CI gate and
// merging the PR), and the coder/ci-fixer may touch `.github/workflows/*` files (`workflow`).
const LOCAL_PAT_SCOPES = ['repo', 'workflow'] as const

/**
 * A GitHub "new personal access token (classic)" URL with the scopes local mode needs
 * pre-selected, so a developer without a PAT can click straight through to create one.
 * Classic tokens are used (not fine-grained) because only the classic form accepts the
 * `scopes` query param for pre-selection.
 */
export function githubPatCreationUrl(): string {
  const params = new URLSearchParams({
    description: 'cat-factory local mode',
    scopes: LOCAL_PAT_SCOPES.join(','),
  })
  return `https://github.com/settings/tokens/new?${params.toString()}`
}

/** An {@link AppTokenSource} that returns a fixed PAT for every installation call. */
export class StaticTokenAppRegistry implements AppTokenSource {
  readonly defaultAppId = ''
  constructor(private readonly token: string) {}

  apps(): readonly { appId: string }[] {
    return [{ appId: '' }]
  }

  authForApp(): { appJwt(): Promise<string> } {
    return {
      appJwt: () =>
        Promise.reject(new Error('GitHub App JWT is not available in local (PAT) mode')),
    }
  }

  installationToken(): Promise<string> {
    return Promise.resolve(this.token)
  }

  // A static PAT carries no App-granted permissions map; canPush then relies on the
  // repo object's user-role `permissions.push`, which IS authoritative for a PAT.
  installationPermissions(): Promise<InstallationPermissions> {
    return Promise.resolve({})
  }
}

/** Rate-limit accounting is best-effort telemetry the local facade simply drops. */
class NoopRateLimitRepository implements RateLimitRepository {
  record(_snapshot: RateLimitSnapshot): Promise<void> {
    return Promise.resolve()
  }
  deleteOlderThan(_epochMs: number): Promise<number> {
    return Promise.resolve(0)
  }
}

const localIdGenerator: IdGenerator = {
  next: (prefix?: string) => (prefix ? `${prefix}_${randomUUID()}` : randomUUID()),
}

const localClock: Clock = { now: () => Date.now() }

const PER_PAGE = 100
const MAX_PAGES = 20

/** Parse the `rel="next"` URL out of a GitHub `Link` response header, if present. */
function nextLink(header: string | null): string | null {
  if (!header) return null
  for (const part of header.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/)
    if (m) return m[1] ?? null
  }
  return null
}

/** The slice of a `/user/repos` item we map to a repo projection. */
interface GhUserRepo {
  id: number
  name: string
  private?: boolean
  default_branch?: string | null
  owner?: { login?: string } | null
}

function toRepoProjection(p: GhUserRepo, installationId: number, syncedAt: number): GitHubRepo {
  return {
    githubId: p.id,
    installationId,
    owner: p.owner?.login ?? '',
    name: p.name,
    defaultBranch: p.default_branch ?? null,
    private: p.private ?? false,
    blockId: null,
    syncedAt,
  }
}

function patHeaders(pat: string): Record<string, string> {
  return {
    authorization: `Bearer ${pat}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'cat-factory',
  }
}

/**
 * A {@link FetchGitHubClient} that lists repos a PAT can access via `/user/repos`, the
 * personal-token analogue of the App-only `/installation/repositories` the base client
 * uses (which 403s for a PAT). The board's "Add from existing repo" picker, the
 * link-a-repo flow and the monorepo browser all enumerate repos through
 * `listInstallationRepos`, so overriding this one method makes them work under a PAT.
 * Every other call (repo/branch/PR/issue reads, merges) already works with the PAT via
 * the installation-token paths, so they fall through to the base implementation.
 */
class PatGitHubClient extends FetchGitHubClient {
  constructor(
    deps: ConstructorParameters<typeof FetchGitHubClient>[0],
    private readonly pat: string,
    private readonly apiBase: string,
    private readonly clock: Clock,
  ) {
    super(deps)
  }

  override async listInstallationRepos(installationId: number): Promise<Paged<GitHubRepo>> {
    const syncedAt = this.clock.now()
    const items: GitHubRepo[] = []
    let url: string | null =
      `${this.apiBase}/user/repos?per_page=${PER_PAGE}&sort=full_name&affiliation=owner,collaborator,organization_member`
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const res: Response = await fetch(url, { headers: patHeaders(this.pat) })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`GitHub /user/repos failed (HTTP ${res.status}): ${text.slice(0, 200)}`)
      }
      const payload = (await res.json()) as GhUserRepo[]
      for (const repo of payload) items.push(toRepoProjection(repo, installationId, syncedAt))
      url = nextLink(res.headers.get('link'))
    }
    return { items }
  }

  // A PAT can't scope `/search/repositories` to "my accessible repos" (it searches all
  // of GitHub), so the realtime picker search reuses the PAT's own `/user/repos`
  // enumeration and filters `owner/name` in memory — bounded to a developer's repo set,
  // which is exactly why the App-installation truncation this override fixes elsewhere
  // doesn't bite here. The account-scope opts are irrelevant (the enumeration is already
  // scoped to the PAT's affiliations).
  override async searchInstallationRepos(
    installationId: number,
    query: string,
    opts: { limit?: number } = {},
  ): Promise<GitHubRepo[]> {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const { items } = await this.listInstallationRepos(installationId)
    const matched = items.filter((r) => `${r.owner}/${r.name}`.toLowerCase().includes(q))
    return matched.slice(0, Math.min(Math.max(opts.limit ?? 50, 1), 100))
  }
}

/**
 * Read the PAT's own account (`GET /user`) so a synthetic installation can be attributed
 * to it in the connect UI. Best-effort: a failed/forbidden call falls back to an empty
 * login (the link flow only needs the installation row to exist, not its account label).
 */
export async function fetchPatAccount(env: NodeJS.ProcessEnv): Promise<PatAccount> {
  const fallback: PatAccount = { accountId: null, accountLogin: '', targetType: 'User' }
  const pat = env.GITHUB_PAT?.trim()
  if (!pat) return fallback
  const apiBase = (env.GITHUB_API_BASE?.trim() || 'https://api.github.com').replace(/\/+$/, '')
  try {
    const res = await fetch(`${apiBase}/user`, { headers: patHeaders(pat) })
    if (!res.ok) return fallback
    const user = (await res.json()) as { id?: number; login?: string; type?: string }
    return {
      accountId: user.id != null ? String(user.id) : null,
      accountLogin: user.login ?? '',
      targetType: user.type === 'Organization' ? 'Organization' : 'User',
    }
  } catch {
    return fallback
  }
}

/**
 * A GitLab "new personal access token" URL with the scopes a coding agent needs
 * pre-selected, so a developer without a GitLab PAT can click straight through to create
 * one. `api` covers repo read/write + merge; `read_user` lets the login resolve the
 * account identity.
 */
export function gitlabPatCreationUrl(): string {
  const params = new URLSearchParams({
    name: 'cat-factory local mode',
    'scopes[]': 'api',
  })
  return `https://gitlab.com/-/user_settings/personal_access_tokens?${params.toString()}`
}

/**
 * Assemble the source-control PAT-login registry from env — the provider-agnostic seam the
 * `/auth/pat` endpoint resolves through. A provider is "configured" (sign-in available) when
 * its PAT is set in env; that env token is also the operational credential, so a provider
 * without one can't sign in (the SPA shows no button for it). The browser never sees a token
 * — sign-in just selects a provider. Adding a third provider is one more entry here + its
 * resolver, with no change to the endpoint or the UI flow.
 */
export function buildVcsIdentityRegistry(env: NodeJS.ProcessEnv): {
  registry: VcsIdentityRegistry
  configured: VcsProvider[]
} {
  const githubApiBase = env.GITHUB_API_BASE?.trim() || 'https://api.github.com'
  const gitlabApiBase = env.GITLAB_API_BASE?.trim() || undefined
  const registry: VcsIdentityRegistry = {
    github: {
      resolver: new GitHubIdentityResolver({ apiBase: githubApiBase }),
      configuredToken: env.GITHUB_PAT?.trim() || undefined,
    },
    gitlab: {
      resolver: new GitLabIdentityResolver({ apiBase: gitlabApiBase }),
      configuredToken: env.GITLAB_PAT?.trim() || undefined,
    },
  }
  const configured = (Object.keys(registry) as VcsProvider[]).filter(
    (p) => registry[p]?.configuredToken,
  )
  return { registry, configured }
}

/**
 * Build a {@link GitHubClient} that authenticates with the PAT, for the CI / merge /
 * mergeability gates AND the repo-link / board "add from repo" flows. Returns undefined
 * when no PAT is configured (the gates then pass through, like the Node default).
 */
export function createLocalGitHubClient(env: NodeJS.ProcessEnv): GitHubClient | undefined {
  const pat = env.GITHUB_PAT?.trim()
  if (!pat) return undefined
  const apiBase = env.GITHUB_API_BASE?.trim() || 'https://api.github.com'
  return new PatGitHubClient(
    {
      registry: new StaticTokenAppRegistry(pat),
      rateLimitRepository: new NoopRateLimitRepository(),
      idGenerator: localIdGenerator,
      clock: localClock,
      apiBase,
    },
    pat,
    apiBase,
    localClock,
  )
}

/**
 * Build a {@link GitHubClient} for a GitLab-only local deployment: a PAT-backed
 * {@link FetchGitLabClient} (the provider-neutral `VcsClient`) adapted to the legacy
 * `GitHubClient` port the CI / merge / mergeability gates + repo-link flows still consume.
 * So a developer who set only `GITLAB_PAT` gets the same gating/merge/repo-read surface a
 * GitHub PAT gives — the engine talks to GitLab through the adapter without being migrated to
 * the neutral port. Returns undefined when no `GITLAB_PAT` is configured (the gates then pass
 * through). For a self-managed instance set `GITLAB_API_BASE` (e.g.
 * `https://gitlab.example.com/api/v4`).
 */
export function createLocalGitLabClient(env: NodeJS.ProcessEnv): GitHubClient | undefined {
  const pat = env.GITLAB_PAT?.trim()
  if (!pat) return undefined
  const apiBase = env.GITLAB_API_BASE?.trim() || GITLAB_PUBLIC_API_BASE
  const vcs = new FetchGitLabClient({
    tokenSource: new StaticGitLabTokenSource(pat, apiBase),
    clock: localClock,
  })
  return asGitHubClient({ vcs, provider: 'gitlab' })
}

/**
 * The host a GitLab local deployment clones/pushes against, derived from `GITLAB_API_BASE`'s
 * host (a self-managed instance) or the public `gitlab.com`. Single source of truth for BOTH
 * the clone URL the server builds (`resolveRepoOrigin`) and the harness host allow-list, so
 * they can never disagree. Returns undefined when no `GITLAB_PAT` is configured (GitHub mode).
 */
export function gitlabVcsHost(env: NodeJS.ProcessEnv): string | undefined {
  if (!env.GITLAB_PAT?.trim()) return undefined
  const apiBase = env.GITLAB_API_BASE?.trim()
  if (!apiBase) return 'gitlab.com'
  try {
    return new URL(apiBase).host
  } catch {
    return 'gitlab.com'
  }
}

/**
 * The comma-separated host allow-list the harness container is given (`GITHUB_ALLOWED_HOSTS`).
 * The harness rejects any clone/push host not on this list (default github.com), so a GitLab
 * deployment must add its host or every clone is refused. Combines any operator-set
 * `GITHUB_ALLOWED_HOSTS` with the resolved GitLab host. Returns undefined when neither applies
 * (GitHub mode with no extra hosts ⇒ the harness keeps its github.com default).
 */
export function harnessAllowedHosts(env: NodeJS.ProcessEnv): string | undefined {
  const hosts = new Set<string>()
  for (const h of (env.GITHUB_ALLOWED_HOSTS ?? '').split(',')) {
    const t = h.trim()
    if (t) hosts.add(t)
  }
  const gitlab = gitlabVcsHost(env)
  if (gitlab) hosts.add(gitlab)
  return hosts.size > 0 ? [...hosts].join(',') : undefined
}
