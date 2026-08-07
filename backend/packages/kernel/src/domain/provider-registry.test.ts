import { describe, expect, it } from 'vitest'
import { defaultProviderRegistry, defineProviderToken } from './provider-registry.js'

// The registry a gate's `wired()` and `probe()` both read: `isWired` and `require` must agree
// about every state, since the whole point of the token is to remove the `getFoo()!` assertion
// that followed a separate `wired()` check.

interface Licenses {
  check(): string
}

const LICENSES = defineProviderToken<Licenses>('license')
const impl: Licenses = { check: () => 'ok' }

describe('defineProviderToken', () => {
  it('mints a DISTINCT identity per call, even for the same description', () => {
    // Two registrants that happen to pick the same word must not collide in the map.
    const a = defineProviderToken<Licenses>('license')
    const b = defineProviderToken<Licenses>('license')
    expect(a.key).not.toBe(b.key)
    const registry = defaultProviderRegistry()
    registry.wire(a, impl)
    expect(registry.isWired(b)).toBe(false)
  })

  it('carries the description used in the unwired error', () => {
    expect(defineProviderToken('license').description).toBe('license')
  })
})

describe('ProviderRegistry', () => {
  it('starts empty, so a fresh build never inherits a previous build’s wiring', () => {
    expect(defaultProviderRegistry().isWired(LICENSES)).toBe(false)
    expect(defaultProviderRegistry().get(LICENSES)).toBeUndefined()
  })

  it('reads back the wired impl by reference', () => {
    const registry = defaultProviderRegistry()
    registry.wire(LICENSES, impl)
    expect(registry.get(LICENSES)).toBe(impl)
    expect(registry.isWired(LICENSES)).toBe(true)
    expect(registry.require(LICENSES)).toBe(impl)
  })

  it('a later wiring of the same token replaces the earlier one', () => {
    const registry = defaultProviderRegistry()
    const replacement: Licenses = { check: () => 'replaced' }
    registry.wire(LICENSES, impl)
    registry.wire(LICENSES, replacement)
    expect(registry.require(LICENSES)).toBe(replacement)
  })

  it('wiring `undefined` CLEARS the token rather than storing an undefined impl', () => {
    // `get` would answer `undefined` either way; only `isWired` tells the two apart, and it is
    // what a gate's `wired()` reads, so a stored-undefined would report a gate as wired and
    // then throw inside its own `probe()`.
    const registry = defaultProviderRegistry()
    registry.wire(LICENSES, impl)
    registry.wire(LICENSES, undefined)
    expect(registry.isWired(LICENSES)).toBe(false)
    expect(registry.get(LICENSES)).toBeUndefined()
  })

  it('`require` throws naming the token when nothing is wired', () => {
    expect(() => defaultProviderRegistry().require(LICENSES)).toThrow(
      'Provider "license" is not wired.',
    )
  })

  it('keeps tokens independent of one another', () => {
    const OTHER = defineProviderToken<Licenses>('other')
    const registry = defaultProviderRegistry()
    registry.wire(LICENSES, impl)
    expect(registry.isWired(OTHER)).toBe(false)
    expect(() => registry.require(OTHER)).toThrow('Provider "other" is not wired.')
  })
})
