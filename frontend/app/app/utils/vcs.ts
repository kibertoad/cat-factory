import type { GitHubConnection, VcsProvider } from '~/types/domain'

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

/** Where a user creates a personal access token for the provider (the PAT connect flow). */
export const VCS_PROVIDER_TOKEN_URLS: Record<VcsProvider, string> = {
  github: 'https://github.com/settings/tokens/new',
  gitlab: 'https://gitlab.com/-/user_settings/personal_access_tokens',
}

/**
 * Where a user creates a repository by hand, for the flows that need one to exist before a run
 * can target it, or `null` where the SPA cannot name the instance the workspace is connected
 * to, in which case the affordance is WITHHELD rather than pointed somewhere plausible.
 *
 * `gitlab` is null for that reason: a deployment may be bound to any self-hosted instance and
 * nothing on the wire carries its web host yet (the connection is the proposed carrier; see
 * the initiative tracker's slice 5). `https://gitlab.com/projects/new` would be a guess about
 * which server the user's projects live on, and the cost of being wrong is not a dead link: a
 * project created on the wrong instance looks like success until the bootstrap push cannot
 * find it. This is the same rule the callers already apply when no provider is resolved at
 * all, so the two cases collapse into {@link newRepoUrl} returning `undefined`.
 *
 * A `Record` rather than a switch so a provider joining the union has to state its answer.
 */
const NEW_REPO_PAGES: Record<VcsProvider, string | null> = {
  github: 'https://github.com/new',
  gitlab: null,
}

/**
 * The App installation's settings page, where a user grants it access to a repository it
 * can't see yet — or `undefined` when the connection is not a GitHub-App one.
 *
 * A pasted PAT has no installation and no such page: what it can reach is decided by the
 * token's scope and the user's project membership on the host, so there is nothing to link
 * to and the callers drop the affordance rather than pointing at a URL that 404s. Keyed on the
 * connection's own `method` (see the contract) rather than on `provider`, and asked as
 * `=== 'app'` so anything that is not an App installation withholds the link.
 */
export function appInstallationManageUrl(connection: GitHubConnection | null): string | undefined {
  if (!connection || connection.method !== 'app') return undefined
  return connection.targetType === 'Organization'
    ? `https://github.com/organizations/${connection.accountLogin}/settings/installations/${connection.installationId}`
    : `https://github.com/settings/installations/${connection.installationId}`
}

/**
 * The host's new-repository page for a manual create, or `undefined` where there is no page
 * this deployment can honestly send the user to (see {@link NEW_REPO_PAGES}), including a
 * null `provider`, which is what a surface rendering before anything is connected has when
 * the deployment offers several. A caller that gets `undefined` hides the affordance.
 *
 * GitHub's form is the only one that takes a prefill, so what the bootstrap flow already
 * knows is carried over and the user creates the right repo in one click. `visibility` is
 * always stated: the caller's toggle has an answer either way, unlike the text fields.
 */
export function newRepoUrl(
  provider: VcsProvider | null,
  prefill: { owner?: string; name?: string; description?: string; private: boolean },
): string | undefined {
  const page = provider ? NEW_REPO_PAGES[provider] : null
  if (page === null) return undefined
  if (provider !== 'github') return page
  const params = new URLSearchParams()
  if (prefill.owner) params.set('owner', prefill.owner)
  if (prefill.name) params.set('name', prefill.name)
  if (prefill.description) params.set('description', prefill.description)
  params.set('visibility', prefill.private ? 'private' : 'public')
  return `${page}?${params.toString()}`
}
