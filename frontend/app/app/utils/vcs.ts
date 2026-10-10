import { GITHUB_TOKEN_CREATE_PATHS, githubPatCreateUrl } from '@cat-factory/contracts'
import type { GitHubConnection, GitHubPatKind, VcsProvider } from '~/types/domain'

// ---------------------------------------------------------------------------
// Shared VCS provider presentation. The platform's repo DATA is provider-neutral (one
// GitHub-shaped store serves GitLab through the backend adapter), so only presentation
// switches on the provider — and it switches HERE, once, rather than per component.
//
// Labels are brand names, kept verbatim in every locale, so they are constants rather than
// catalog keys (the same convention the login screen and the API-key provider descriptors
// already use). Anything that is PROSE stays in the i18n catalog, keyed per provider.
//
// Each map is an exhaustive `Record<VcsProvider, …>`: adding a provider to the union fails
// the typecheck here instead of silently rendering a GitHub icon for it.
//
// EVERY link builder here takes the connection's `webUrl` — the browser-facing host the
// backend derived from the instance the workspace is actually bound to. The SPA used to
// hand-build `https://github.com/…`, which is right for exactly one deployment shape and sends
// a self-managed GitLab (or GitHub Enterprise) user to whatever lives at that path on the
// public instance. A null host means the deployment could not name one, and a builder that
// needs one answers `undefined` so its caller drops the affordance.
// ---------------------------------------------------------------------------

/** Brand name, as rendered in titles and buttons. */
export const VCS_PROVIDER_LABELS: Record<VcsProvider, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
}

export const VCS_PROVIDER_ICONS: Record<VcsProvider, string> = {
  github: 'i-lucide-github',
  gitlab: 'i-lucide-gitlab',
}

/**
 * The public instance of each provider, used ONLY where no host is known and a wrong link costs
 * nothing but a click: the token-creation page during connect (see {@link vcsTokenCreateUrl}).
 * Never for a link to a repo, a project or a namespace, where the public instance may well
 * serve somebody else's page under the same path.
 */
const VCS_PROVIDER_PUBLIC_WEB_URLS: Record<VcsProvider, string> = {
  github: 'https://github.com',
  gitlab: 'https://gitlab.com',
}

/**
 * Where a user creates a personal access token, relative to the instance's web root. GitHub's
 * comes from `@cat-factory/contracts` rather than being spelled again here: the credential
 * banner's PRE-FILLED re-mint link is built from that same map, and the unscoped connect-box
 * link below has to land on the same page.
 */
const TOKEN_SETTINGS_PATHS: Record<VcsProvider, string> = {
  github: GITHUB_TOKEN_CREATE_PATHS.classic,
  gitlab: '/-/user_settings/personal_access_tokens',
}

/** Where a user creates a repository/project by hand, relative to the instance's web root. */
const NEW_REPO_PATHS: Record<VcsProvider, string> = {
  github: '/new',
  gitlab: '/projects/new',
}

/** How each provider addresses a pull/merge request and an issue under a repo's web path. */
const PULL_PATHS: Record<VcsProvider, (n: number) => string> = {
  github: (n) => `/pull/${n}`,
  gitlab: (n) => `/-/merge_requests/${n}`,
}
const ISSUE_PATHS: Record<VcsProvider, (n: number) => string> = {
  github: (n) => `/issues/${n}`,
  gitlab: (n) => `/-/issues/${n}`,
}
const BRANCH_PATHS: Record<VcsProvider, (branch: string) => string> = {
  github: (branch) => `/tree/${branch}`,
  gitlab: (branch) => `/-/tree/${branch}`,
}

/** Strip a trailing slash so a host and a path never join into a double slash. */
function root(webUrl: string): string {
  return webUrl.replace(/\/+$/, '')
}

/**
 * Where a user creates a personal access token on the instance they are connecting.
 *
 * The one builder that FALLS BACK to the provider's public instance when no host is known,
 * deliberately unlike its repo-facing siblings: this renders during connect, before anything is
 * bound, and the cost of being wrong is a settings page that isn't theirs — a click, noticed
 * immediately. A wrong REPOSITORY link is silent and can cost a run, so those withhold instead.
 */
export function vcsTokenCreateUrl(provider: VcsProvider, webUrl?: string | null): string {
  return `${root(webUrl || VCS_PROVIDER_PUBLIC_WEB_URLS[provider])}${TOKEN_SETTINGS_PATHS[provider]}`
}

/**
 * Where the credential banner sends someone to REPLACE a GitHub token that cannot do what their
 * runs need, pre-filled as far as GitHub allows.
 *
 * The `kind` is the kind of the token being replaced, so a deployment that standardised on
 * fine-grained tokens is not pushed back to a classic one by a warning. When the check never got
 * far enough to classify (GitHub rejected the token outright), the caller passes `'unknown'` and
 * lands on the form that CAN be pre-filled.
 *
 * Shares {@link vcsTokenCreateUrl}'s public-host fallback for the same stated reason: this is a
 * settings page, so being wrong costs one noticed click, unlike a repository link.
 */
export function githubPatRemintUrl(kind: GitHubPatKind, webUrl?: string | null): string {
  return githubPatCreateUrl(kind, {
    webUrl: webUrl || VCS_PROVIDER_PUBLIC_WEB_URLS.github,
    description: 'cat-factory',
  })
}

/**
 * The App installation's settings page, where a user grants it access to a repository it
 * can't see yet — or `undefined` when the connection is not a GitHub-App one.
 *
 * A pasted PAT has no installation and no such page: what it can reach is decided by the
 * token's scope and the user's project membership on the host, so there is nothing to link
 * to and the callers drop the affordance rather than pointing at a URL that 404s. Keyed on the
 * connection's own `method` (see the contract) rather than on `provider`, and asked as
 * `=== 'app'` so anything that is not an App installation withholds the link — as does an
 * installation whose host the deployment could not name, since an installation id means nothing
 * on an instance other than its own.
 */
export function appInstallationManageUrl(connection: GitHubConnection | null): string | undefined {
  if (!connection || connection.method !== 'app' || !connection.webUrl) return undefined
  const base = root(connection.webUrl)
  return connection.targetType === 'Organization'
    ? `${base}/organizations/${connection.accountLogin}/settings/installations/${connection.installationId}`
    : `${base}/settings/installations/${connection.installationId}`
}

/**
 * The host's new-repository page for a manual create, or `undefined` when the deployment could
 * not name the instance (a null/absent `webUrl`) or no provider is resolved at all, which is
 * what a surface rendering before anything is connected has when the deployment offers several.
 * A caller that gets `undefined` hides the affordance.
 *
 * Withholding is the whole point: a project created on the wrong instance looks like success
 * until the bootstrap push cannot find it, which is a failed run rather than a dead link. Now
 * that the host is on the wire, a GitLab deployment that HAS one gets the button back.
 *
 * GitHub's form is the only one that takes a prefill, so what the bootstrap flow already
 * knows is carried over and the user creates the right repo in one click. `visibility` is
 * always stated: the caller's toggle has an answer either way, unlike the text fields.
 */
export function newRepoUrl(
  provider: VcsProvider | null,
  webUrl: string | null | undefined,
  prefill: { owner?: string; name?: string; description?: string; private: boolean },
): string | undefined {
  if (!provider || !webUrl) return undefined
  const page = `${root(webUrl)}${NEW_REPO_PATHS[provider]}`
  if (provider !== 'github') return page
  const params = new URLSearchParams()
  if (prefill.owner) params.set('owner', prefill.owner)
  if (prefill.name) params.set('name', prefill.name)
  if (prefill.description) params.set('description', prefill.description)
  params.set('visibility', prefill.private ? 'private' : 'public')
  return `${page}?${params.toString()}`
}

/**
 * A repository's page on the instance it lives on, or null when no host is known.
 *
 * `owner` is the full namespace on both providers (GitHub's `owner`, GitLab's group path,
 * nested groups included), so the repo path itself needs no provider switch — only what hangs
 * off it does.
 */
export function repoWebUrl(
  webUrl: string | null | undefined,
  repo: { owner: string; name: string },
): string | null {
  return webUrl ? `${root(webUrl)}/${repo.owner}/${repo.name}` : null
}

/** A pull request (GitHub) / merge request (GitLab) under a repo's page. */
export function pullWebUrl(
  provider: VcsProvider,
  repoUrl: string | null,
  pullNumber: number,
): string | null {
  return repoUrl ? `${repoUrl}${PULL_PATHS[provider](pullNumber)}` : null
}

/** An issue under a repo's page. */
export function issueWebUrl(
  provider: VcsProvider,
  repoUrl: string | null,
  issueNumber: number,
): string | null {
  return repoUrl ? `${repoUrl}${ISSUE_PATHS[provider](issueNumber)}` : null
}

/** A branch's file listing under a repo's page. */
export function branchWebUrl(
  provider: VcsProvider,
  repoUrl: string | null,
  branch: string,
): string | null {
  return repoUrl ? `${repoUrl}${BRANCH_PATHS[provider](branch)}` : null
}
