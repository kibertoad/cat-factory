import { describe, expect, it } from 'vitest'
import type { ProviderSubscriptionTokenRecord } from '@cat-factory/kernel'
import { chooseToken, windowUsage } from './providers.logic.js'

const WINDOW = 5 * 60 * 60 * 1000

function token(
  id: string,
  over: Partial<ProviderSubscriptionTokenRecord> = {},
): ProviderSubscriptionTokenRecord {
  return {
    id,
    workspaceId: 'ws',
    vendor: 'claude',
    label: id,
    tokenCipher: `cipher-${id}`,
    createdAt: 1000,
    lastUsedAt: null,
    windowStartedAt: null,
    inputTokens: 0,
    outputTokens: 0,
    requestCount: 0,
    enabled: true,
    isDefault: false,
    deletedAt: null,
    ...over,
  }
}

describe('windowUsage', () => {
  it('is zero for a token with no usage window', () => {
    expect(windowUsage(token('a'), 10_000, WINDOW)).toBe(0)
  })

  it('sums input+output inside the window', () => {
    const t = token('a', { windowStartedAt: 1000, inputTokens: 100, outputTokens: 50 })
    expect(windowUsage(t, 1000 + WINDOW - 1, WINDOW)).toBe(150)
  })

  it('resets to zero once the window has aged out', () => {
    const t = token('a', { windowStartedAt: 1000, inputTokens: 100, outputTokens: 50 })
    expect(windowUsage(t, 1000 + WINDOW, WINDOW)).toBe(0)
  })
})

describe('chooseToken', () => {
  it('returns null for an empty pool', () => {
    expect(chooseToken([], 0, WINDOW)).toBeNull()
  })

  it('prefers the least-loaded token in the current window', () => {
    const busy = token('busy', { windowStartedAt: 1000, inputTokens: 900, outputTokens: 100 })
    const idle = token('idle', { windowStartedAt: 1000, inputTokens: 10, outputTokens: 0 })
    expect(chooseToken([busy, idle], 2000, WINDOW)?.id).toBe('idle')
  })

  it('falls back to round-robin (least-recently-leased) on equal usage', () => {
    const older = token('older', { lastUsedAt: 100 })
    const newer = token('newer', { lastUsedAt: 500 })
    expect(chooseToken([newer, older], 2000, WINDOW)?.id).toBe('older')
  })

  it('prefers a never-leased token over a leased one when usage ties', () => {
    const used = token('used', { lastUsedAt: 100 })
    const fresh = token('fresh', { lastUsedAt: null })
    expect(chooseToken([used, fresh], 2000, WINDOW)?.id).toBe('fresh')
  })

  it('never chooses a disabled token, even if it is the least-loaded', () => {
    const idleDisabled = token('idle', {
      windowStartedAt: 1000,
      inputTokens: 0,
      outputTokens: 0,
      enabled: false,
    })
    const busyEnabled = token('busy', {
      windowStartedAt: 1000,
      inputTokens: 900,
      outputTokens: 100,
    })
    expect(chooseToken([idleDisabled, busyEnabled], 2000, WINDOW)?.id).toBe('busy')
  })

  it('returns null when every token is disabled', () => {
    expect(chooseToken([token('a', { enabled: false })], 2000, WINDOW)).toBeNull()
  })

  it('prefers a pinned default over the least-loaded token', () => {
    const idle = token('idle', { windowStartedAt: 1000, inputTokens: 0, outputTokens: 0 })
    const busyDefault = token('busy', {
      windowStartedAt: 1000,
      inputTokens: 900,
      outputTokens: 100,
      isDefault: true,
    })
    expect(chooseToken([idle, busyDefault], 2000, WINDOW)?.id).toBe('busy')
  })

  it('ignores a default that is disabled and falls back to rotation', () => {
    const disabledDefault = token('def', { isDefault: true, enabled: false })
    const idle = token('idle', { windowStartedAt: 1000, inputTokens: 1, outputTokens: 0 })
    expect(chooseToken([disabledDefault, idle], 2000, WINDOW)?.id).toBe('idle')
  })

  it('ignores stale-window usage so an aged-out busy token is eligible again', () => {
    const stale = token('stale', {
      windowStartedAt: 1000,
      inputTokens: 9999,
      outputTokens: 9999,
      lastUsedAt: 1000,
    })
    const recent = token('recent', {
      windowStartedAt: 1000 + WINDOW,
      inputTokens: 5,
      outputTokens: 5,
      lastUsedAt: 1000 + WINDOW,
    })
    // At a time past the stale token's window, its usage reads 0 and it wins the
    // load comparison (0 < 10).
    expect(chooseToken([stale, recent], 1000 + WINDOW + 10, WINDOW)?.id).toBe('stale')
  })
})
