import { describe, expect, it, vi } from 'vitest'
import type { InitiatorPatGate, Logger, ResolveUserGitHubToken } from '@cat-factory/kernel'
import { createRecordingLogger } from '@cat-factory/kernel'
import { PatPreferringAppRegistry } from '../src/github/PatPreferringAppRegistry.js'
import type { AppTokenSource } from '../src/github/GitHubAppRegistry.js'
import { runWithInitiator } from '../src/github/runInitiatorContext.js'
import { createResolveRunInitiatorToken } from '../src/github/runInitiatorToken.js'

// PatPreferringAppRegistry prefers the run initiator's PAT over the wrapped App token, and
// only where the run's WORKSPACE permits it. Two properties are pinned here:
//
//  - the perf fix (performance-optimizations item 2c): within ONE `runWithInitiator` scope —
//    exactly one gate probe / merge boundary — the initiator's PAT is resolved a single time,
//    even though a probe fans out into several GitHub `request()`s (each of which re-mints via
//    `installationToken`), and `installationPermissions` also consults it;
//  - the `allowInitiatorPat` control (backend/docs/security-model.md): a workspace that turned
//    it off gets the deployment credential, and an UNREADABLE policy fails closed the same way.

function innerSource(): AppTokenSource {
  return {
    defaultAppId: '',
    apps: () => [{ appId: '' }],
    authForApp: () => ({ appJwt: async () => 'jwt' }),
    installationToken: async () => 'app-token',
    installationPermissions: async () => ({ contents: 'write' }),
  }
}

/** A registry whose decision is the real shared one, over the supplied PAT resolve + policy. */
function registryOver(
  resolve: ResolveUserGitHubToken,
  opts: { initiatorPatGate?: InitiatorPatGate; logger?: Logger } = {},
): PatPreferringAppRegistry {
  return new PatPreferringAppRegistry(
    innerSource(),
    createResolveRunInitiatorToken({ resolveUserGitHubToken: resolve, ...opts }),
  )
}

const SCOPE = { workspaceId: 'ws_1', initiatedBy: 'user_1' }

describe('PatPreferringAppRegistry PAT scope memo', () => {
  it('resolves the initiator PAT once across many calls within one runWithInitiator scope', async () => {
    const resolve = vi.fn<ResolveUserGitHubToken>(async () => 'pat-123')
    const registry = registryOver(resolve)

    const tokens = await runWithInitiator(SCOPE, async () => {
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
    const registry = registryOver(resolve)

    await runWithInitiator(SCOPE, () => registry.installationToken(42))
    await runWithInitiator(SCOPE, () => registry.installationToken(42))

    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('falls back to the wrapped App token when the initiator has no PAT', async () => {
    const resolve = vi.fn<ResolveUserGitHubToken>(async () => null)
    const registry = registryOver(resolve)

    const token = await runWithInitiator(SCOPE, () => registry.installationToken(42))
    expect(token).toBe('app-token')
    // With no PAT, permissions defer to the wrapped App source.
    const perms = await runWithInitiator(SCOPE, () => registry.installationPermissions(42))
    expect(perms).toEqual({ contents: 'write' })
  })

  it('does not memoize a rejected resolve — a transient failure retries within the scope', async () => {
    // First resolve rejects (transient DB/decrypt error), the retry succeeds. The memo must
    // NOT pin the rejection for the rest of the scope; only the success path is deduped.
    const resolve = vi
      .fn<ResolveUserGitHubToken>()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue('pat-123')
    const registry = registryOver(resolve)

    await runWithInitiator(SCOPE, async () => {
      await expect(registry.installationToken(42)).rejects.toThrow('transient')
      // The eviction lets a subsequent request in the same scope resolve for real.
      expect(await registry.installationToken(42)).toBe('pat-123')
      // And the now-successful value IS memoized for the rest of the scope.
      expect(await registry.installationToken(42)).toBe('pat-123')
    })

    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('resolves directly (no memo) outside any initiator scope', async () => {
    const resolve = vi.fn<ResolveUserGitHubToken>(async () => 'pat-123')
    const registry = registryOver(resolve)

    // No ambient scope → the App token, resolve never consulted.
    const token = await registry.installationToken(42)
    expect(token).toBe('app-token')
    expect(resolve).not.toHaveBeenCalled()
  })
})

describe('PatPreferringAppRegistry workspace credential policy', () => {
  it('uses the App token — and never decrypts the PAT — when the workspace refuses it', async () => {
    const resolve = vi.fn<ResolveUserGitHubToken>(async () => 'pat-123')
    const registry = registryOver(resolve, { initiatorPatGate: async () => false })

    expect(await runWithInitiator(SCOPE, () => registry.installationToken(42))).toBe('app-token')
    // Permissions must fall back to the App's real map too: an empty map would make `canPush`
    // read the repo's user role, which is not what an installation token is bounded by.
    expect(await runWithInitiator(SCOPE, () => registry.installationPermissions(42))).toEqual({
      contents: 'write',
    })
    // The refusal short-circuits BEFORE the secret store, so a refused workspace never
    // decrypts a member's token at all.
    expect(resolve).not.toHaveBeenCalled()
  })

  it('asks the policy per workspace, not once per process', async () => {
    const resolve = vi.fn<ResolveUserGitHubToken>(async () => 'pat-123')
    const gate = vi.fn<InitiatorPatGate>(async (workspaceId) => workspaceId === 'ws_allowed')
    const registry = registryOver(resolve, { initiatorPatGate: gate })

    const allowed = await runWithInitiator(
      { workspaceId: 'ws_allowed', initiatedBy: 'user_1' },
      () => registry.installationToken(42),
    )
    const refused = await runWithInitiator(
      { workspaceId: 'ws_refused', initiatedBy: 'user_1' },
      () => registry.installationToken(42),
    )

    expect(allowed).toBe('pat-123')
    expect(refused).toBe('app-token')
    expect(gate.mock.calls.map(([id]) => id)).toEqual(['ws_allowed', 'ws_refused'])
  })

  it('fails CLOSED to the App token when the policy cannot be read, and says why', async () => {
    // An unreadable settings row is not permission to widen a run's credential: the run
    // proceeds on the narrower App token, attributed to the bot, with the cause logged.
    const resolve = vi.fn<ResolveUserGitHubToken>(async () => 'pat-123')
    const logger = createRecordingLogger()
    const registry = registryOver(resolve, {
      initiatorPatGate: async () => {
        throw new Error('settings row unreadable')
      },
      logger,
    })

    expect(await runWithInitiator(SCOPE, () => registry.installationToken(42))).toBe('app-token')
    expect(resolve).not.toHaveBeenCalled()
    const warned = logger.lines.filter((l) => l.level === 'warn')
    expect(warned).toHaveLength(1)
    expect(warned[0]?.fields).toMatchObject({ workspaceId: 'ws_1' })
    expect(warned[0]?.fields?.err).toContain('settings row unreadable')
  })

  it('applies the preference when no policy is wired at all', async () => {
    // No settings store ⇒ no stored opt-out to honour, which is the pre-existing behaviour
    // (and the situation of a minimal container / test build).
    const resolve = vi.fn<ResolveUserGitHubToken>(async () => 'pat-123')
    const registry = registryOver(resolve)

    expect(await runWithInitiator(SCOPE, () => registry.installationToken(42))).toBe('pat-123')
  })

  it('reads the policy ONCE per scope, not once per minted request', async () => {
    // The whole decision rides the scope memo, not just the decrypt behind it. This is the
    // read that has no cache to hide behind on Cloudflare: `AppCaches.workspaceSettings` is
    // `enabled: false` in the isolate-safe profile, so an un-memoized ask is a live D1 read
    // on every mint — five per CI poll, for the whole life of a PR's CI.
    const resolve = vi.fn<ResolveUserGitHubToken>(async () => 'pat-123')
    const gate = vi.fn<InitiatorPatGate>(async () => true)
    const registry = registryOver(resolve, { initiatorPatGate: gate })

    await runWithInitiator(SCOPE, async () => {
      await Promise.all([
        registry.installationToken(42),
        registry.installationToken(42),
        registry.installationToken(42),
        registry.installationToken(42),
      ])
      await registry.installationPermissions(42)
    })

    expect(gate).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('reports an unreadable policy once per probe, not once per request', async () => {
    // The fail-closed `null` is a decided ANSWER, so it is memoized like any other. Without
    // that, one settings outage during a CI poll costs five reads and five identical warns —
    // the log noise that makes an operator stop reading the line that matters.
    const logger = createRecordingLogger()
    const gate = vi.fn<InitiatorPatGate>(async () => {
      throw new Error('settings row unreadable')
    })
    const registry = registryOver(
      vi.fn<ResolveUserGitHubToken>(async () => 'pat-123'),
      { initiatorPatGate: gate, logger },
    )

    const tokens = await runWithInitiator(SCOPE, () =>
      Promise.all([registry.installationToken(42), registry.installationToken(42)]),
    )

    expect(tokens).toEqual(['app-token', 'app-token'])
    expect(gate).toHaveBeenCalledTimes(1)
    expect(logger.lines.filter((l) => l.level === 'warn')).toHaveLength(1)
  })

  it('evicts a REJECTED decision so a transient decrypt failure cannot poison the scope', async () => {
    // Unchanged from when the memo covered the decrypt alone: a rejection is not an answer,
    // so the next request in the same scope must get a real attempt rather than the failure.
    const resolve = vi
      .fn<ResolveUserGitHubToken>()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue('pat-123')
    const gate = vi.fn<InitiatorPatGate>(async () => true)
    const registry = registryOver(resolve, { initiatorPatGate: gate })

    await runWithInitiator(SCOPE, async () => {
      await expect(registry.installationToken(42)).rejects.toThrow('transient')
      expect(await registry.installationToken(42)).toBe('pat-123')
    })

    expect(resolve).toHaveBeenCalledTimes(2)
    // The policy read is re-asked with it: the eviction drops the whole decision, which is
    // correct — a half-cached decision would be a policy answer paired with no token.
    expect(gate).toHaveBeenCalledTimes(2)
  })
})
