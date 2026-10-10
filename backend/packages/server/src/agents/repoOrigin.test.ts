import { describe, expect, it } from 'vitest'
import type { AppConfig } from '../config/types.js'
import type { RepoTarget } from './repoTargeting.js'
import {
  deploymentRepoOrigin,
  engineVcsProvider,
  harnessGitLabHost,
  type RepoOriginConfig,
} from './repoOrigin.js'

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

  // The mixed-deployment case the App-wins rule leaves behind. The projection knows this repo
  // lives on GitLab; the engine reaches GitHub and mints an App token, so there is no clone URL
  // AND no credential for it. Answering `github.com/<group>/<project>` names a real page owned by
  // somebody else and reports whatever is checked out there as the run's repository.
  it('refuses a repo whose own provider the engine cannot reach', () => {
    const origin = deploymentRepoOrigin(config({ github: true, gitlab: true }))
    expect(() => origin({ ...REPO, provider: 'gitlab' })).toThrow(/group\/sub\/widgets/)
    expect(() => origin({ ...REPO, provider: 'gitlab' })).toThrow(/gitlab repository/)
  })

  it('refuses a GitHub repo on a GitLab-only deployment for the same reason', () => {
    const origin = deploymentRepoOrigin(
      config({ gitlab: true, apiBase: 'https://gitlab.acme.dev/api/v4' }),
    )
    expect(() => origin({ ...REPO, provider: 'github' })).toThrow(/github repository/)
  })

  // A row predating the discriminator column carries none, and reads as the deployment's own
  // provider. Tripping the refusal on those would stop every run on an older workspace.
  it('serves a row that names no provider', () => {
    expect(deploymentRepoOrigin(config({ github: true, gitlab: true }))(REPO).provider).toBe(
      'github',
    )
    expect(
      deploymentRepoOrigin(config({ gitlab: true, apiBase: 'https://gitlab.acme.dev/api/v4' }))(
        REPO,
      ).provider,
    ).toBe('gitlab')
  })

  it('serves a row whose provider agrees with the engine', () => {
    const origin = deploymentRepoOrigin(
      config({ gitlab: true, apiBase: 'https://gitlab.acme.dev/api/v4' }),
    )
    expect(origin({ ...REPO, provider: 'gitlab' }).cloneUrl).toBe(
      'https://gitlab.acme.dev/group/sub/widgets.git',
    )
  })
})

// The rule `deploymentRepoOrigin` and the `RepoFiles` coords resolver both key on, stated once so
// a facade cannot bind a client for one provider beside a clone URL for the other.
describe('engineVcsProvider', () => {
  it('follows the App-wins rule engineVcsClient uses', () => {
    expect(engineVcsProvider(config({ github: true }))).toBe('github')
    expect(engineVcsProvider(config({ github: true, gitlab: true }))).toBe('github')
    expect(engineVcsProvider(config({ gitlab: true }))).toBe('gitlab')
    // Neither configured: nothing to clone, and `github` is the seam's own default.
    expect(engineVcsProvider(config({}))).toBe('github')
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

  // The harness matches on `new URL(cloneUrl).hostname`, which carries no port, so a value that
  // included one would never match and every clone on such an instance would be refused with no
  // port anywhere in the message. On the Worker the value is derived, so there is no operator
  // override to correct it with.
  it('excludes the port, which is what the harness compares against', () => {
    expect(
      harnessGitLabHost({ enabled: true, apiBase: 'http://gitlab.internal:8080/api/v4' }),
    ).toBe('gitlab.internal')
  })
})
