import { describe, it, expect } from 'vitest'
import {
  appInstallationManageUrl,
  githubNewRepoUrl,
  VCS_PROVIDER_ICONS,
  VCS_PROVIDER_LABELS,
  VCS_PROVIDER_NEW_REPO_URLS,
  VCS_PROVIDER_TOKEN_URLS,
} from './vcs'
import type { GitHubConnection, VcsProvider } from '~/types/domain'

/**
 * The one place VCS presentation switches on the provider. What is pinned here is the pair of
 * decisions a component must never make for itself: which affordances belong to a GitHub-App
 * installation (and therefore vanish on a pasted token), and which host page a manual
 * repo-creation link opens.
 */
const connection = (over: Partial<GitHubConnection> = {}): GitHubConnection => ({
  installationId: 42,
  accountLogin: 'acme',
  targetType: 'User',
  connectedAt: 0,
  provider: 'github',
  method: 'app',
  canCreateRepos: false,
  canManageWorkflows: true,
  ...over,
})

describe('appInstallationManageUrl', () => {
  it('links a personal App installation to the user settings page', () => {
    expect(appInstallationManageUrl(connection())).toBe(
      'https://github.com/settings/installations/42',
    )
  })

  it('links an organization App installation to the org settings page', () => {
    expect(appInstallationManageUrl(connection({ targetType: 'Organization' }))).toBe(
      'https://github.com/organizations/acme/settings/installations/42',
    )
  })

  // The whole point of the helper: a pasted token has no installation, so there is no page to
  // send the user to. Both modals used to build the github.com URL from the connection
  // unconditionally, which put a "Grant the App access" button that 404s in front of every
  // GitLab-connected workspace.
  it('has no URL for a PAT connection, whatever its provider', () => {
    expect(
      appInstallationManageUrl(connection({ provider: 'gitlab', method: 'pat' })),
    ).toBeUndefined()
    expect(
      appInstallationManageUrl(connection({ provider: 'github', method: 'pat' })),
    ).toBeUndefined()
  })

  it('has no URL when there is no connection', () => {
    expect(appInstallationManageUrl(null)).toBeUndefined()
  })

  // A backend predating the `method` field must read as "not an App": hiding a link is
  // recoverable, offering one that 404s on the user's own host is not.
  it('treats a connection with no stated method as not an App one', () => {
    const legacy = { ...connection(), method: undefined } as unknown as GitHubConnection
    expect(appInstallationManageUrl(legacy)).toBeUndefined()
  })
})

describe('githubNewRepoUrl', () => {
  it('prefills the new-repository form with everything the caller knows', () => {
    const url = new URL(githubNewRepoUrl({ owner: 'acme', name: 'api', private: true }))
    expect(url.origin + url.pathname).toBe(VCS_PROVIDER_NEW_REPO_URLS.github)
    expect(url.searchParams.get('owner')).toBe('acme')
    expect(url.searchParams.get('name')).toBe('api')
    expect(url.searchParams.get('visibility')).toBe('private')
  })

  it('omits what the caller has not filled in yet, and marks a public repo public', () => {
    const url = new URL(githubNewRepoUrl({ name: '', private: false }))
    expect(url.searchParams.has('owner')).toBe(false)
    expect(url.searchParams.has('name')).toBe(false)
    expect(url.searchParams.get('visibility')).toBe('public')
  })
})

describe('provider presentation maps', () => {
  const providers: VcsProvider[] = ['github', 'gitlab']

  // Each map is an exhaustive Record, so this only guards against an entry left empty: the
  // typecheck already fails when a provider joins the union with no row.
  it.each(providers)('has a label, icon, token URL and new-repo URL for %s', (provider) => {
    expect(VCS_PROVIDER_LABELS[provider]).toBeTruthy()
    expect(VCS_PROVIDER_ICONS[provider]).toMatch(/^i-lucide-/)
    expect(VCS_PROVIDER_TOKEN_URLS[provider]).toMatch(/^https:\/\//)
    expect(VCS_PROVIDER_NEW_REPO_URLS[provider]).toMatch(/^https:\/\//)
  })
})
