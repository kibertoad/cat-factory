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
 * Where a user creates a repository by hand, for the flows that need one to exist before a
 * run can target it. Only reached when the deployment can't create it for the user
 * (`connection.canCreateRepos`), so it is a convenience link, never the only route.
 *
 * GitHub's page accepts a prefill query string ({@link githubNewRepoUrl}); GitLab's does not,
 * so its entry is the bare form.
 */
export const VCS_PROVIDER_NEW_REPO_URLS: Record<VcsProvider, string> = {
  github: 'https://github.com/new',
  gitlab: 'https://gitlab.com/projects/new',
}

/**
 * The App installation's settings page, where a user grants it access to a repository it
 * can't see yet — or `undefined` when the connection is not a GitHub-App one.
 *
 * A pasted PAT has no installation and no such page: what it can reach is decided by the
 * token's scope and the user's project membership on the host, so there is nothing to link
 * to and the callers drop the affordance rather than pointing at a URL that 404s. Keyed on
 * the connection's own `method` (see the contract) rather than on `provider`, and absent
 * `method` counts as "not an App", which is the fail-safe direction.
 */
export function appInstallationManageUrl(connection: GitHubConnection | null): string | undefined {
  if (!connection || connection.method !== 'app') return undefined
  return connection.targetType === 'Organization'
    ? `https://github.com/organizations/${connection.accountLogin}/settings/installations/${connection.installationId}`
    : `https://github.com/settings/installations/${connection.installationId}`
}

/**
 * GitHub's new-repository page, prefilled with what the bootstrap flow already knows so the
 * user creates the right repo in one click. GitHub is the only provider whose form takes a
 * prefill, so every other one gets its bare {@link VCS_PROVIDER_NEW_REPO_URLS} entry.
 */
export function githubNewRepoUrl(prefill: {
  owner?: string
  name?: string
  description?: string
  private: boolean
}): string {
  const params = new URLSearchParams()
  if (prefill.owner) params.set('owner', prefill.owner)
  if (prefill.name) params.set('name', prefill.name)
  if (prefill.description) params.set('description', prefill.description)
  params.set('visibility', prefill.private ? 'private' : 'public')
  return `${VCS_PROVIDER_NEW_REPO_URLS.github}?${params.toString()}`
}
