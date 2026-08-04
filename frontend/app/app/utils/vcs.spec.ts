import { describe, it, expect } from 'vitest'
import {
  appInstallationManageUrl,
  newRepoUrl,
  VCS_PROVIDER_ICONS,
  VCS_PROVIDER_LABELS,
  VCS_PROVIDER_TOKEN_URLS,
} from './vcs'
import type { GitHubConnection, VcsProvider } from '~/types/domain'

/**
 * The one place VCS presentation switches on the provider. What is pinned here is the pair of
 * decisions a component must never make for itself: which affordances belong to a GitHub-App
 * installation (and therefore vanish on a pasted token), and which host page a manual
 * repo-creation link may open, including the hosts it must refuse to guess at.
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
})

describe('newRepoUrl', () => {
  it('prefills the GitHub new-repository form with everything the caller knows', () => {
    const url = new URL(
      newRepoUrl('github', { owner: 'acme', name: 'api', private: true }) ?? 'about:blank',
    )
    expect(url.origin + url.pathname).toBe('https://github.com/new')
    expect(url.searchParams.get('owner')).toBe('acme')
    expect(url.searchParams.get('name')).toBe('api')
    expect(url.searchParams.get('visibility')).toBe('private')
  })

  it('omits what the caller has not filled in yet, and marks a public repo public', () => {
    const url = new URL(newRepoUrl('github', { name: '', private: false }) ?? 'about:blank')
    expect(url.searchParams.has('owner')).toBe(false)
    expect(url.searchParams.has('name')).toBe(false)
    expect(url.searchParams.get('visibility')).toBe('public')
  })

  // A deployment may be bound to any self-hosted GitLab and nothing on the wire names its web
  // host yet, so there is no page this can honestly open. Withheld rather than guessed at:
  // gitlab.com would look like it worked, and the user would create the project on a server
  // the bootstrap run never pushes to.
  it('withholds a page for GitLab, whose instance the SPA cannot name', () => {
    expect(newRepoUrl('gitlab', { name: 'api', private: false })).toBeUndefined()
  })

  it('withholds a page when no provider is resolved', () => {
    expect(newRepoUrl(null, { name: 'api', private: false })).toBeUndefined()
  })
})

describe('provider presentation maps', () => {
  const providers: VcsProvider[] = ['github', 'gitlab']

  // Each map is an exhaustive Record, so this only guards against an entry left empty: the
  // typecheck already fails when a provider joins the union with no row.
  it.each(providers)('has a label, icon and token URL for %s', (provider) => {
    expect(VCS_PROVIDER_LABELS[provider]).toBeTruthy()
    expect(VCS_PROVIDER_ICONS[provider]).toMatch(/^i-lucide-/)
    expect(VCS_PROVIDER_TOKEN_URLS[provider]).toMatch(/^https:\/\//)
  })
})
