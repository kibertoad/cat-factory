import { describe, expect, it } from 'vitest'
import { ConflictError, UnavailableError } from '@cat-factory/kernel'
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
    expect(source.installable()).toEqual([])
    // A 409, not the 503 the no-key case raises: the two blocked causes need different refusals
    // (a credential owned elsewhere vs a capability never configured), which is why the source
    // exposes no reason enum for a caller to re-map.
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
    // No ENCRYPTION_KEY and no injected store: the flow closes, so the screen never shows a box
    // that would silently discard the token, and the refusal names the capability that is missing.
    const source = createLocalVcsCredentialSource({})
    expect(source.installable()).toEqual([])
    await expect(source.install('github', 'ghp_x')).rejects.toBeInstanceOf(UnavailableError)
    await expect(source.install('github', 'ghp_x')).rejects.toThrow(/ENCRYPTION_KEY/)
  })

  it('stays closed after `close()` rather than re-opening a torn-down store', async () => {
    // `close()` is a shutdown (and the boot path's throwaway read), so a later use must NOT open a
    // second handle on a source whose owner has already released it. The install path is where
    // that is observable: it refuses like a deployment with no store at all.
    let opens = 0
    const source = createLocalVcsCredentialSource({}, () => {
      opens += 1
      return memoryStore()
    })
    await source.install('github', 'ghp_first')
    expect(opens).toBe(1)
    source.close()
    await expect(source.install('github', 'ghp_second')).rejects.toBeInstanceOf(UnavailableError)
    expect(opens).toBe(1)
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
    // A relative-URL install keeps its prefix in the clone URL and still allow-lists the bare host.
    expect(gitlabVcsHost({ GITLAB_API_BASE: 'https://acme.dev/gitlab/api/v4' }, credential)).toBe(
      'acme.dev',
    )
  })

  // A base the shared inversion cannot read names no host, so nothing is allow-listed and the
  // clone URL refuses to be built. Answering `gitlab.com` (which this used to do) allow-listed a
  // host the deployment does not use, on exactly the misconfiguration an operator has to see.
  it('names no host for a base it cannot invert', () => {
    const credential = { provider: 'gitlab', token: 'x', origin: 'env' } as const
    expect(gitlabVcsHost({ GITLAB_API_BASE: 'not a url' }, credential)).toBeUndefined()
    expect(gitlabVcsHost({ GITLAB_API_BASE: 'https://acme.dev/proxy' }, credential)).toBeUndefined()
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
