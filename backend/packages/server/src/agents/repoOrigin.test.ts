import { describe, expect, it } from 'vitest'
import type { AppConfig } from '../config/types.js'
import type { RepoTarget } from './repoTargeting.js'
import { deploymentRepoOrigin, harnessGitLabHost, type RepoOriginConfig } from './repoOrigin.js'

// `deploymentRepoOrigin` is what a HOSTED facade wires into the `ResolveRepoOrigin` seam. Until it
// existed, both hosted facades wired nothing, so every dispatch fell through to `githubRepoOrigin`
// and a GitLab-only deployment handed its containers a github.com clone URL while gating and
// merging on GitLab.

const REPO: RepoTarget = {
  owner: 'group/sub',
  name: 'widgets',
  baseBranch: 'main',
  installationId: 1,
  repoId: '10',
}

const config = (input: {
  github?: boolean
  gitlab?: boolean
  apiBase?: string
}): RepoOriginConfig => ({
  github: { enabled: input.github ?? false },
  gitlab: {
    enabled: input.gitlab ?? false,
    apiBase: input.apiBase ?? 'https://gitlab.com/api/v4',
  },
})

describe('deploymentRepoOrigin', () => {
  it('clones GitHub when no GitLab connection is configured', () => {
    expect(deploymentRepoOrigin(config({ github: true }))(REPO)).toEqual({
      cloneUrl: 'https://github.com/group/sub/widgets.git',
      provider: 'github',
    })
    expect(deploymentRepoOrigin(config({}))(REPO).provider).toBe('github')
  })

  it('clones the configured GitLab instance on a GitLab-only deployment', () => {
    const origin = deploymentRepoOrigin(
      config({ gitlab: true, apiBase: 'https://gitlab.acme.dev/api/v4' }),
    )
    expect(origin(REPO)).toEqual({
      cloneUrl: 'https://gitlab.acme.dev/group/sub/widgets.git',
      provider: 'gitlab',
    })
  })

  // A relative-URL install keeps its own prefix, the same inversion the SPA's links use.
  it('keeps a relative-URL install prefix in the clone URL', () => {
    const origin = deploymentRepoOrigin(
      config({ gitlab: true, apiBase: 'https://acme.dev/gitlab/api/v4' }),
    )
    expect(origin(REPO).cloneUrl).toBe('https://acme.dev/gitlab/group/sub/widgets.git')
  })

  // The GitHub App wins wherever both are configured, matching `engineVcsClient`, so the client
  // that opens the request and the URL the container clones name the same host.
  it('clones GitHub when both providers are configured', () => {
    expect(deploymentRepoOrigin(config({ github: true, gitlab: true }))(REPO).provider).toBe(
      'github',
    )
  })

  // Falling back to github.com here resolves to a real page belonging to somebody else, so the
  // failure has to arrive as one.
  it('throws rather than falling back when the GitLab base names no web host', () => {
    const origin = deploymentRepoOrigin(config({ gitlab: true, apiBase: 'https://acme.dev/proxy' }))
    expect(() => origin(REPO)).toThrow(/GITLAB_API_BASE/)
  })

  it('accepts a full AppConfig without narrowing at the call site', () => {
    const full = { github: { enabled: true }, gitlab: { enabled: false, apiBase: '' } }
    expect(deploymentRepoOrigin(full as AppConfig)(REPO).provider).toBe('github')
  })
})

describe('harnessGitLabHost', () => {
  it('names the host the harness must accept a clone credential for', () => {
    expect(harnessGitLabHost({ enabled: true, apiBase: 'https://gitlab.acme.dev/api/v4' })).toBe(
      'gitlab.acme.dev',
    )
    expect(harnessGitLabHost({ enabled: true, apiBase: 'https://acme.dev/gitlab/api/v4' })).toBe(
      'acme.dev',
    )
  })

  // Keyed on the GitLab connection ALONE: on a deployment running both, the GitLab workspaces
  // still clone GitLab, so withholding the host here would refuse them at checkout.
  it('names it even when a GitHub App is configured beside it', () => {
    expect(harnessGitLabHost({ enabled: true, apiBase: 'https://gitlab.com/api/v4' })).toBe(
      'gitlab.com',
    )
  })

  it('answers undefined when the deployment reaches no GitLab instance', () => {
    expect(
      harnessGitLabHost({ enabled: false, apiBase: 'https://gitlab.com/api/v4' }),
    ).toBeUndefined()
  })

  it('answers undefined for a base that names no host', () => {
    expect(harnessGitLabHost({ enabled: true, apiBase: 'https://acme.dev/proxy' })).toBeUndefined()
  })
})
