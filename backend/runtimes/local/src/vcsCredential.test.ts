import { describe, expect, it } from 'vitest'
import { ConflictError } from '@cat-factory/kernel'
import {
  createLocalVcsCredentialSource,
  gitlabVcsHost,
  harnessAllowedHosts,
} from './vcsCredential.js'
import { createLocalVcsCredentialStore } from './sqlite/vcsCredentialStore.js'

/** A real (in-memory) sealed store, so precedence is asserted against the actual persistence. */
const memoryStore = () =>
  createLocalVcsCredentialStore(':memory:', Buffer.alloc(32).toString('base64'))

describe('createLocalVcsCredentialSource', () => {
  it('has no credential when neither env nor the store holds one', () => {
    const source = createLocalVcsCredentialSource({}, memoryStore)
    expect(source.current()).toBeUndefined()
    expect(source.envProviders()).toEqual([])
    expect(source.installBlockedReason()).toBeUndefined()
    expect(source.installable()).toEqual(['github', 'gitlab'])
  })

  it('serves an installed credential immediately, with no restart', async () => {
    const source = createLocalVcsCredentialSource({}, memoryStore)
    await source.install('github', 'ghp_new', { login: 'octocat' })
    expect(source.current()).toEqual({ provider: 'github', token: 'ghp_new', origin: 'stored' })
  })

  it('notifies listeners so the wiring that cannot be resolved per call re-derives', async () => {
    const source = createLocalVcsCredentialSource({}, memoryStore)
    const seen: (string | undefined)[] = []
    source.onChange((credential) => seen.push(credential?.token))
    await source.install('gitlab', 'glpat_new')
    expect(seen).toEqual(['glpat_new'])
  })

  it('lets `.env` win over a stored credential, and refuses to install beside it', async () => {
    const store = memoryStore()
    store.write({ provider: 'gitlab', token: 'glpat_stored', login: null })
    const source = createLocalVcsCredentialSource({ GITHUB_PAT: 'ghp_env' }, () => store)
    expect(source.current()).toEqual({ provider: 'github', token: 'ghp_env', origin: 'env' })
    expect(source.envProviders()).toEqual(['github'])
    expect(source.installable()).toEqual([])
    expect(source.installBlockedReason()).toBe('env_configured')
    await expect(source.install('github', 'ghp_pasted')).rejects.toBeInstanceOf(ConflictError)
  })

  it('REPLACES a stored credential, because the sign-in screen is the only way back in', async () => {
    const source = createLocalVcsCredentialSource({}, memoryStore)
    await source.install('github', 'ghp_expired')
    expect(source.installable()).toEqual(['github', 'gitlab'])
    await source.install('gitlab', 'glpat_fresh')
    expect(source.current()).toEqual({ provider: 'gitlab', token: 'glpat_fresh', origin: 'stored' })
  })

  it('cannot install with nothing to seal the token with', async () => {
    // No ENCRYPTION_KEY and no injected store: the flow closes, and says which of the two
    // reasons it is so the screen never shows a box that would silently discard the token.
    const source = createLocalVcsCredentialSource({})
    expect(source.installBlockedReason()).toBe('no_encryption_key')
    expect(source.installable()).toEqual([])
    await expect(source.install('github', 'ghp_x')).rejects.toThrow(/ENCRYPTION_KEY/)
  })
})

describe('gitlabVcsHost', () => {
  it('is undefined unless the credential in use is a GitLab one', () => {
    expect(gitlabVcsHost({}, undefined)).toBeUndefined()
    expect(gitlabVcsHost({}, { provider: 'github', token: 'x', origin: 'env' })).toBeUndefined()
  })

  it('defaults to gitlab.com, else the configured instance host', () => {
    const credential = { provider: 'gitlab', token: 'x', origin: 'env' } as const
    expect(gitlabVcsHost({}, credential)).toBe('gitlab.com')
    expect(gitlabVcsHost({ GITLAB_API_BASE: 'https://git.acme.com/api/v4' }, credential)).toBe(
      'git.acme.com',
    )
    expect(gitlabVcsHost({ GITLAB_API_BASE: 'not a url' }, credential)).toBe('gitlab.com')
  })
})

describe('harnessAllowedHosts', () => {
  const gitlab = { provider: 'gitlab', token: 'x', origin: 'stored' } as const

  it('is undefined in GitHub mode with no extra hosts (harness keeps its github.com default)', () => {
    expect(harnessAllowedHosts({}, undefined)).toBeUndefined()
  })

  it('adds the GitLab host so the harness will not reject a GitLab clone URL', () => {
    expect(harnessAllowedHosts({}, gitlab)).toBe('gitlab.com')
    expect(harnessAllowedHosts({ GITLAB_API_BASE: 'https://git.acme.com/api/v4' }, gitlab)).toBe(
      'git.acme.com',
    )
  })

  it('merges operator-set GITHUB_ALLOWED_HOSTS with the GitLab host (deduped)', () => {
    const out = harnessAllowedHosts({ GITHUB_ALLOWED_HOSTS: 'gitlab.com, ghe.internal' }, gitlab)
    expect(out?.split(',').sort()).toEqual(['ghe.internal', 'gitlab.com'])
  })
})
