import { describe, it, expect } from 'vitest'
import {
  appInstallationManageUrl,
  branchWebUrl,
  issueWebUrl,
  newRepoUrl,
  pullWebUrl,
  repoWebUrl,
  VCS_PROVIDER_ICONS,
  VCS_PROVIDER_LABELS,
  vcsTokenCreateUrl,
} from './vcs'
import type { GitHubConnection, VcsProvider } from '~/types/domain'

/**
 * The one place VCS presentation switches on the provider. What is pinned here is the set of
 * decisions a component must never make for itself: which affordances belong to a GitHub-App
 * installation (and therefore vanish on a pasted token), how each provider addresses a merge
 * request / issue / branch, and which links may fall back to a provider's public instance when
 * the deployment could not name its own host — one may, the rest must withhold.
 */
const connection = (over: Partial<GitHubConnection> = {}): GitHubConnection => ({
  installationId: 42,
  accountLogin: 'acme',
  targetType: 'User',
  connectedAt: 0,
  provider: 'github',
  method: 'app',
  webUrl: 'https://github.com',
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

  // A GitHub Enterprise Server installation's settings live on that server, and its installation
  // id means nothing anywhere else.
  it('links an Enterprise installation to its own host', () => {
    expect(appInstallationManageUrl(connection({ webUrl: 'https://ghe.acme.dev' }))).toBe(
      'https://ghe.acme.dev/settings/installations/42',
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

  it('has no URL when the deployment could not name the host', () => {
    expect(appInstallationManageUrl(connection({ webUrl: null }))).toBeUndefined()
  })

  it('has no URL when there is no connection', () => {
    expect(appInstallationManageUrl(null)).toBeUndefined()
  })
})

describe('newRepoUrl', () => {
  it('prefills the GitHub new-repository form with everything the caller knows', () => {
    const url = new URL(
      newRepoUrl('github', 'https://github.com', { owner: 'acme', name: 'api', private: true }) ??
        'about:blank',
    )
    expect(url.origin + url.pathname).toBe('https://github.com/new')
    expect(url.searchParams.get('owner')).toBe('acme')
    expect(url.searchParams.get('name')).toBe('api')
    expect(url.searchParams.get('visibility')).toBe('private')
  })

  it('omits what the caller has not filled in yet, and marks a public repo public', () => {
    const url = new URL(
      newRepoUrl('github', 'https://github.com', { name: '', private: false }) ?? 'about:blank',
    )
    expect(url.searchParams.has('owner')).toBe(false)
    expect(url.searchParams.has('name')).toBe(false)
    expect(url.searchParams.get('visibility')).toBe('public')
  })

  // Now that the connection states its host, a self-managed GitLab gets the button back — on its
  // OWN instance. GitLab's form takes no prefill, so it is the bare page.
  it('opens the new-project page on the GitLab instance the workspace is bound to', () => {
    expect(newRepoUrl('gitlab', 'https://gitlab.acme.dev', { name: 'api', private: false })).toBe(
      'https://gitlab.acme.dev/projects/new',
    )
  })

  // Withheld rather than guessed at: the public instance would look like it worked, and the user
  // would create the project on a server the bootstrap run never pushes to.
  it('withholds a page when the deployment could not name a host', () => {
    expect(newRepoUrl('gitlab', null, { name: 'api', private: false })).toBeUndefined()
  })

  it('withholds a page when no provider is resolved', () => {
    expect(
      newRepoUrl(null, 'https://gitlab.acme.dev', { name: 'api', private: false }),
    ).toBeUndefined()
  })
})

describe('repo / pull / issue / branch links', () => {
  const repo = { owner: 'acme/platform', name: 'api' }

  // The repo path itself is provider-neutral: `owner` already carries GitLab's full group path,
  // nested groups included. Only what hangs off it differs.
  it('builds a repo page under the connection’s own host', () => {
    expect(repoWebUrl('https://gitlab.acme.dev', repo)).toBe(
      'https://gitlab.acme.dev/acme/platform/api',
    )
    expect(repoWebUrl('https://github.com/', { owner: 'acme', name: 'api' })).toBe(
      'https://github.com/acme/api',
    )
  })

  it('addresses a pull request and a merge request the way each provider does', () => {
    const base = 'https://gitlab.acme.dev/acme/api'
    expect(pullWebUrl('gitlab', base, 7)).toBe(`${base}/-/merge_requests/7`)
    expect(pullWebUrl('github', 'https://github.com/acme/api', 7)).toBe(
      'https://github.com/acme/api/pull/7',
    )
  })

  it('addresses an issue and a branch the way each provider does', () => {
    const base = 'https://gitlab.acme.dev/acme/api'
    expect(issueWebUrl('gitlab', base, 3)).toBe(`${base}/-/issues/3`)
    expect(branchWebUrl('gitlab', base, 'feat/sso')).toBe(`${base}/-/tree/feat/sso`)
    expect(issueWebUrl('github', 'https://github.com/acme/api', 3)).toBe(
      'https://github.com/acme/api/issues/3',
    )
    expect(branchWebUrl('github', 'https://github.com/acme/api', 'feat/sso')).toBe(
      'https://github.com/acme/api/tree/feat/sso',
    )
  })

  // With no host there is no repo page, and everything built on one goes with it rather than
  // being rendered against a guessed instance.
  it('withholds every link when the host is unknown', () => {
    expect(repoWebUrl(null, repo)).toBeNull()
    expect(pullWebUrl('gitlab', null, 7)).toBeNull()
    expect(issueWebUrl('gitlab', null, 3)).toBeNull()
    expect(branchWebUrl('gitlab', null, 'main')).toBeNull()
  })
})

describe('vcsTokenCreateUrl', () => {
  it('points at the token page on the instance being connected', () => {
    expect(vcsTokenCreateUrl('gitlab', 'https://gitlab.acme.dev')).toBe(
      'https://gitlab.acme.dev/-/user_settings/personal_access_tokens',
    )
  })

  // The one builder that may fall back: it renders during connect (and on the sign-in screen,
  // where nothing is connected at all), and a settings page on the wrong instance costs a click
  // rather than a run.
  it('falls back to the provider’s public instance when no host is known', () => {
    expect(vcsTokenCreateUrl('gitlab')).toBe(
      'https://gitlab.com/-/user_settings/personal_access_tokens',
    )
    expect(vcsTokenCreateUrl('github', null)).toBe('https://github.com/settings/tokens/new')
  })
})

describe('provider presentation maps', () => {
  const providers: VcsProvider[] = ['github', 'gitlab']

  // Each map is an exhaustive Record, so this only guards against an entry left empty: the
  // typecheck already fails when a provider joins the union with no row.
  it.each(providers)('has a label, icon and token URL for %s', (provider) => {
    expect(VCS_PROVIDER_LABELS[provider]).toBeTruthy()
    expect(VCS_PROVIDER_ICONS[provider]).toMatch(/^i-lucide-/)
    expect(vcsTokenCreateUrl(provider)).toMatch(/^https:\/\//)
  })
})
