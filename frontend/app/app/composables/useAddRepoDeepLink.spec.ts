import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import type { GitHubAvailableRepo } from '~/types/domain'
import {
  captureAddRepoDeepLink,
  prefilledRepoMatch,
  prefillProviderMismatch,
} from './useAddRepoDeepLink'

function setUrl(search: string): void {
  history.replaceState(null, '', `/${search}`)
}

function repo(owner: string, name: string): GitHubAvailableRepo {
  return { owner, name, githubId: owner.length + name.length } as GitHubAvailableRepo
}

describe('captureAddRepoDeepLink', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setUrl('')
  })

  it('parses the link an integration builds, and strips only its own params', () => {
    setUrl('?addRepo=kibertoad%2Fsimpler-service3&provider=github&ws=ws_1&keep=yes')
    expect(captureAddRepoDeepLink()).toEqual({
      repo: 'kibertoad/simpler-service3',
      provider: 'github',
      workspaceId: 'ws_1',
    })
    expect(window.location.search).toBe('?keep=yes')
    expect(captureAddRepoDeepLink()).toBeNull()
  })

  it('takes a GitLab project under nested groups', () => {
    setUrl('?addRepo=acme/platform/payments')
    expect(captureAddRepoDeepLink()).toMatchObject({ repo: 'acme/platform/payments' })
  })

  it('drops a value that is not a repository path, and still strips it', () => {
    setUrl('?addRepo=payments')
    expect(captureAddRepoDeepLink()).toBeNull()
    expect(window.location.search).toBe('')
  })
})

describe('prefilledRepoMatch', () => {
  it('matches the full path regardless of case, never a longer name', () => {
    const wanted = repo('Kibertoad', 'simpler-service3')
    const found = prefilledRepoMatch({ repo: 'kibertoad/simpler-service3', provider: null }, [
      repo('kibertoad', 'simpler-service30'),
      wanted,
    ])
    expect(found).toBe(wanted)
  })
})

describe('prefillProviderMismatch', () => {
  it('flags a link for another host only when the board is connected', () => {
    const prefill = { repo: 'acme/payments', provider: 'gitlab' }
    expect(prefillProviderMismatch(prefill, 'github')).toBe(true)
    expect(prefillProviderMismatch(prefill, 'gitlab')).toBe(false)
    expect(prefillProviderMismatch(prefill, null)).toBe(false)
    expect(prefillProviderMismatch({ ...prefill, provider: null }, 'github')).toBe(false)
  })
})
