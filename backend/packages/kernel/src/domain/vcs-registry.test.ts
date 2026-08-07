import { describe, expect, it } from 'vitest'
import { defaultVcsRegistry, type VcsProviderBundle } from './vcs-registry.js'
import type { VcsClient } from '../ports/vcs-client.js'

// The seam a GitLab deployment lives or dies by: an adapter package registers its bundle on the
// instance the facade injects, and every caller holding a `VcsConnectionRef` resolves through
// that same instance. What matters is that `get`/`has`/`require`/`resolve` agree about every
// state, and that an unregistered provider is a NAMED throw rather than a crash deep in a call.

const bundleFor = (provider: 'github' | 'gitlab'): VcsProviderBundle => ({
  provider,
  client: { kind: provider } as unknown as VcsClient,
})

describe('VcsProviderRegistry', () => {
  it('starts empty: nothing is registered until a facade registers it', () => {
    const registry = defaultVcsRegistry()
    expect(registry.providers()).toEqual([])
    expect(registry.has('github')).toBe(false)
    expect(registry.get('github')).toBeUndefined()
  })

  it('reads a registered bundle back by reference', () => {
    const registry = defaultVcsRegistry()
    const bundle = bundleFor('gitlab')
    registry.register(bundle)
    expect(registry.get('gitlab')).toBe(bundle)
    expect(registry.has('gitlab')).toBe(true)
    expect(registry.require('gitlab')).toBe(bundle)
  })

  it('keys on the bundle’s OWN provider, so it can never be filed under another', () => {
    const registry = defaultVcsRegistry()
    registry.register(bundleFor('gitlab'))
    expect(registry.providers()).toEqual(['gitlab'])
    expect(registry.has('github')).toBe(false)
  })

  it('a later registration of the same provider replaces the earlier adapter', () => {
    const registry = defaultVcsRegistry()
    const first = bundleFor('github')
    const override = { ...bundleFor('github'), provisioning: undefined }
    registry.register(first)
    registry.register(override)
    expect(registry.require('github')).toBe(override)
    expect(registry.providers()).toEqual(['github'])
  })

  it('lists providers in registration order', () => {
    const registry = defaultVcsRegistry()
    registry.register(bundleFor('gitlab'))
    registry.register(bundleFor('github'))
    expect(registry.providers()).toEqual(['gitlab', 'github'])
  })

  it('`require` names the missing provider instead of failing deep in a call', () => {
    expect(() => defaultVcsRegistry().require('gitlab')).toThrow(
      'VCS provider "gitlab" is not registered.',
    )
  })

  it('`resolve` reads the provider off the connection ref', () => {
    const registry = defaultVcsRegistry()
    const bundle = bundleFor('gitlab')
    registry.register(bundle)
    expect(registry.resolve({ provider: 'gitlab', connectionId: '7' })).toBe(bundle)
    expect(() => registry.resolve({ provider: 'github', connectionId: '7' })).toThrow(
      'VCS provider "github" is not registered.',
    )
  })
})
