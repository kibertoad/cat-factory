import { describe, expect, it } from 'vitest'
import { SSO_ERROR_REASONS } from '@cat-factory/contracts'
import en from '../../i18n/locales/en.json'
import { SSO_ERROR_MESSAGE_KEYS } from './sso'

// The copy side of the SSO refusal contract. The `Record<SsoLoginFailure, string>` type already
// forces every reason to name a key, but a key is only a STRING: nothing there checks it exists in
// the catalog, and a typo renders the raw key path to a user who just failed to sign in. That is
// the assertion the type and the locale-parity guard structurally cannot make between them (parity
// compares locales to each other, so a key missing from ALL of them is parity-clean).

/** Resolve a dotted i18n key against the catalog, or undefined when it names nothing. */
function lookup(key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      en,
    )
}

describe('SSO_ERROR_MESSAGE_KEYS', () => {
  it('covers every wire reason EXACTLY once, plus the newer-backend fallback', () => {
    // Derived from the vocabulary the backend actually ships rather than a pinned count, so a
    // reason added there fails here until it has wording instead of silently rendering nothing.
    expect(Object.keys(SSO_ERROR_MESSAGE_KEYS).sort()).toEqual(
      [...SSO_ERROR_REASONS, 'unknown'].sort(),
    )
  })

  it('names a key that resolves to real copy for every reason', () => {
    for (const [reason, key] of Object.entries(SSO_ERROR_MESSAGE_KEYS)) {
      const copy = lookup(key)
      expect(typeof copy, `${reason} -> ${key}`).toBe('string')
      expect(copy as string, `${reason} -> ${key}`).not.toBe('')
    }
  })
})
