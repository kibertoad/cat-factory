import { describe, expect, it, vi } from 'vitest'
import type { ResolveUserGitHubToken } from '@cat-factory/kernel'
import { PatPreferringAppRegistry } from '../src/github/PatPreferringAppRegistry.js'
import type { AppTokenSource } from '../src/github/GitHubAppRegistry.js'
import { runWithInitiator } from '../src/github/runInitiatorContext.js'

// PatPreferringAppRegistry prefers the run initiator's PAT over the wrapped App token. This
// pins the perf fix (performance-optimizations item 2c): within ONE `runWithInitiator`
// scope — exactly one gate probe / merge boundary — the initiator's PAT is resolved a
// single time, even though a probe fans out into several GitHub `request()`s (each of which
// re-mints via `installationToken`), and `installationPermissions` also consults it.

function innerSource(): AppTokenSource {
  return {
    defaultAppId: '',
    apps: () => [{ appId: '' }],
    authForApp: () => ({ appJwt: async () => 'jwt' }),
    installationToken: async () => 'app-token',
    installationPermissions: async () => ({ contents: 'write' }),
  }
}

describe('PatPreferringAppRegistry PAT scope memo', () => {
  it('resolves the initiator PAT once across many calls within one runWithInitiator scope', async () => {
    const resolve = vi.fn<ResolveUserGitHubToken>(async () => 'pat-123')
    const registry = new PatPreferringAppRegistry(innerSource(), resolve)

    const tokens = await runWithInitiator('user_1', async () => {
      // Four mint calls + one permissions check — what one CI poll fans out to.
      const results = await Promise.all([
        registry.installationToken(42),
        registry.installationToken(42),
        registry.installationToken(42),
        registry.installationToken(42),
      ])
      const perms = await registry.installationPermissions(42)
      return { results, perms }
    })

    expect(tokens.results).toEqual(['pat-123', 'pat-123', 'pat-123', 'pat-123'])
    // A PAT is authoritative via the repo's user-role permissions, so the App map is empty.
    expect(tokens.perms).toEqual({})
    // The whole probe did a SINGLE DB read + decrypt.
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('re-resolves per scope (memo does not leak across probes)', async () => {
    const resolve = vi.fn<ResolveUserGitHubToken>(async () => 'pat-123')
    const registry = new PatPreferringAppRegistry(innerSource(), resolve)

    await runWithInitiator('user_1', () => registry.installationToken(42))
    await runWithInitiator('user_1', () => registry.installationToken(42))

    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('falls back to the wrapped App token when the initiator has no PAT', async () => {
    const resolve = vi.fn<ResolveUserGitHubToken>(async () => null)
    const registry = new PatPreferringAppRegistry(innerSource(), resolve)

    const token = await runWithInitiator('user_1', () => registry.installationToken(42))
    expect(token).toBe('app-token')
    // With no PAT, permissions defer to the wrapped App source.
    const perms = await runWithInitiator('user_1', () => registry.installationPermissions(42))
    expect(perms).toEqual({ contents: 'write' })
  })

  it('resolves directly (no memo) outside any initiator scope', async () => {
    const resolve = vi.fn<ResolveUserGitHubToken>(async () => 'pat-123')
    const registry = new PatPreferringAppRegistry(innerSource(), resolve)

    // No ambient initiator → the App token, resolve never consulted.
    const token = await registry.installationToken(42)
    expect(token).toBe('app-token')
    expect(resolve).not.toHaveBeenCalled()
  })
})
