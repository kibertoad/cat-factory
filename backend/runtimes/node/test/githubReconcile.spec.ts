import type { Clock, StaleRepoRef } from '@cat-factory/kernel'
import type { Logger } from '@cat-factory/server'
import { describe, expect, it, vi } from 'vitest'
import {
  GITHUB_RECONCILE_STALE_MS,
  type GitHubReconcileDeps,
  reconcileStaleRepos,
} from '../src/githubReconcile.js'

// Pure unit coverage for the Node GitHub reconcile pass (no database) — the analogue of
// the Worker's `github-reconcile` cron. Asserts the staleness cutoff, the best-effort
// per-repo isolation, and the missed-uninstall tombstone path.

const staleRepo = (over: Partial<StaleRepoRef> = {}): StaleRepoRef => ({
  workspaceId: 'ws1',
  githubId: 101,
  installationId: 7,
  owner: 'acme',
  name: 'shop',
  ...over,
})

const clock: Clock = { now: () => 1_000_000_000 }

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger

function makeDeps(
  stale: StaleRepoRef[],
  syncRepoById: GitHubReconcileDeps['syncRepoById'],
): GitHubReconcileDeps & { listStaleCutoffs: number[]; softDeleted: [number, number][] } {
  const listStaleCutoffs: number[] = []
  const softDeleted: [number, number][] = []
  return {
    listStaleCutoffs,
    softDeleted,
    repoProjectionRepository: {
      listStale: async (cutoff) => {
        listStaleCutoffs.push(cutoff)
        return stale
      },
    },
    installationRepository: {
      softDelete: async (installationId, at) => {
        softDeleted.push([installationId, at])
      },
    },
    syncRepoById,
  }
}

describe('reconcileStaleRepos (Node)', () => {
  it('re-syncs every stale repo at now - staleMs and reports the count', async () => {
    const synced: [string, number][] = []
    const deps = makeDeps(
      [staleRepo(), staleRepo({ workspaceId: 'ws2', githubId: 202 })],
      async (ws, id) => {
        synced.push([ws, id])
      },
    )
    const count = await reconcileStaleRepos(deps, clock, GITHUB_RECONCILE_STALE_MS, noopLog)
    expect(deps.listStaleCutoffs).toEqual([clock.now() - GITHUB_RECONCILE_STALE_MS])
    expect(synced).toEqual([
      ['ws1', 101],
      ['ws2', 202],
    ])
    expect(count).toBe(2)
    expect(deps.softDeleted).toEqual([])
  })

  it('one failing repo does not abort the rest (best-effort pass)', async () => {
    const synced: number[] = []
    const deps = makeDeps(
      [staleRepo({ githubId: 1 }), staleRepo({ githubId: 2 }), staleRepo({ githubId: 3 })],
      async (_ws, id) => {
        if (id === 2) throw new Error('boom')
        synced.push(id)
      },
    )
    const count = await reconcileStaleRepos(deps, clock, GITHUB_RECONCILE_STALE_MS, noopLog)
    expect(synced).toEqual([1, 3])
    expect(count).toBe(2)
  })

  it('tombstones the installation on a token-mint 404 (missed uninstall webhook)', async () => {
    const deps = makeDeps([staleRepo({ installationId: 42 })], async () => {
      throw new Error('Failed to mint installation token for 42 (HTTP 404)')
    })
    const warn = vi.fn()
    const log = { info: () => {}, warn, error: vi.fn() } as unknown as Logger
    const count = await reconcileStaleRepos(deps, clock, GITHUB_RECONCILE_STALE_MS, log)
    expect(count).toBe(0)
    expect(deps.softDeleted).toEqual([[42, clock.now()]])
    // Gone-installation is an expected operational state: warn, not error.
    expect(warn).toHaveBeenCalled()
  })

  it('does NOT tombstone on a repo-level 404 or a mint 401 (transient/JWT faults)', async () => {
    for (const message of [
      'GitHub request failed (HTTP 404)',
      'Failed to mint installation token for 7 (HTTP 401)',
    ]) {
      const deps = makeDeps([staleRepo()], async () => {
        throw new Error(message)
      })
      await reconcileStaleRepos(deps, clock, GITHUB_RECONCILE_STALE_MS, noopLog)
      expect(deps.softDeleted).toEqual([])
    }
  })
})
