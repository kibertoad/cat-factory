import { describe, expect, it } from 'vitest'
import { cloudflareCredsHalfSet } from '../src/config.js'
import { missingContainerExecutorPrereqs } from '../src/container.js'

// Pure helpers behind the boot-time "silently-disabled feature" warnings (error-message
// coverage A5/A10). They exist so the "name exactly what's missing" logic is unit-testable
// without booting the whole container, mirroring local mode's `unrecognizedRuntimeId` (A9).

describe('cloudflareCredsHalfSet (A10)', () => {
  it('is undefined when both halves are set', () => {
    expect(
      cloudflareCredsHalfSet({ CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'tok' }),
    ).toBeUndefined()
  })

  it('is undefined when neither half is set', () => {
    expect(cloudflareCredsHalfSet({})).toBeUndefined()
  })

  it('names the missing token when only the account id is set', () => {
    expect(cloudflareCredsHalfSet({ CLOUDFLARE_ACCOUNT_ID: 'acct' })).toEqual({
      set: 'CLOUDFLARE_ACCOUNT_ID',
      missing: 'CLOUDFLARE_API_TOKEN',
    })
  })

  it('names the missing account id when only the token is set', () => {
    expect(cloudflareCredsHalfSet({ CLOUDFLARE_API_TOKEN: 'tok' })).toEqual({
      set: 'CLOUDFLARE_API_TOKEN',
      missing: 'CLOUDFLARE_ACCOUNT_ID',
    })
  })

  it('treats a whitespace-only half as unset (so a blank + a real value is half-set)', () => {
    expect(
      cloudflareCredsHalfSet({ CLOUDFLARE_ACCOUNT_ID: '   ', CLOUDFLARE_API_TOKEN: 'tok' }),
    ).toEqual({ set: 'CLOUDFLARE_API_TOKEN', missing: 'CLOUDFLARE_ACCOUNT_ID' })
    // Both whitespace-only ⇒ both unset ⇒ nothing to warn about.
    expect(
      cloudflareCredsHalfSet({ CLOUDFLARE_ACCOUNT_ID: '  ', CLOUDFLARE_API_TOKEN: '' }),
    ).toBeUndefined()
  })
})

describe('missingContainerExecutorPrereqs (A5)', () => {
  const present = {
    publicUrl: 'https://example.test',
    sessionSecret: 'a'.repeat(32),
    hasRunnerBackend: true,
  }

  it('is empty when every prerequisite is present', () => {
    expect(missingContainerExecutorPrereqs(present)).toEqual([])
  })

  it('names PUBLIC_URL when the public url is missing', () => {
    expect(missingContainerExecutorPrereqs({ ...present, publicUrl: undefined })).toEqual([
      'PUBLIC_URL',
    ])
  })

  it('names AUTH_SESSION_SECRET when the session secret is missing', () => {
    expect(missingContainerExecutorPrereqs({ ...present, sessionSecret: undefined })).toEqual([
      'AUTH_SESSION_SECRET (>= 32 chars)',
    ])
  })

  it('names the runner backend when no transport is resolvable', () => {
    expect(missingContainerExecutorPrereqs({ ...present, hasRunnerBackend: false })).toEqual([
      'a runner backend (self-hosted runner pool)',
    ])
  })

  it('lists every missing prerequisite together, in declaration order', () => {
    expect(
      missingContainerExecutorPrereqs({
        publicUrl: undefined,
        sessionSecret: undefined,
        hasRunnerBackend: false,
      }),
    ).toEqual([
      'PUBLIC_URL',
      'AUTH_SESSION_SECRET (>= 32 chars)',
      'a runner backend (self-hosted runner pool)',
    ])
  })
})
