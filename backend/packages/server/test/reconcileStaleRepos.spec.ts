import type { Clock, StaleRepoRef } from '@cat-factory/kernel'
import { describe, expect, it, vi } from 'vitest'
import { GitHubApiError } from '../src/github/FetchGitHubClient.js'
import { InstallationTokenMintError } from '../src/github/GitHubAppAuth.js'
import type { Logger } from '../src/observability/logger.js'
import {
  GITHUB_RECONCILE_STALE_MS,
  type GitHubReconcileDeps,
  reconcileStaleRepos,
} from '../src/runtime/reconcileStaleRepos.js'

// Pure unit coverage for the shared GitHub reconcile pass (no database) — the single
// implementation both facades drive (the Worker's `github-reconcile` cron and the Node
// `setInterval` sweeper). Asserts the staleness cutoff, the best-effort per-repo
// isolation, and the missed-uninstall tombstone path. Guards item 4's de-duplication:
// one test for one implementation, so the two facades can't silently diverge.

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

// Pin the shared default staleness window both facades sweep with.
const STALE_MS = GITHUB_RECONCILE_STALE_MS

describe('reconcileStaleRepos (shared)', () => {
  it('re-syncs every stale repo at now - staleMs and reports the count', async () => {
    const synced: [string, number][] = []
    const deps = makeDeps(
      [staleRepo(), staleRepo({ workspaceId: 'ws2', githubId: 202 })],
      async (ws, id) => {
        synced.push([ws, id])
      },
    )
    const count = await reconcileStaleRepos(deps, clock, STALE_MS, noopLog)
    expect(deps.listStaleCutoffs).toEqual([clock.now() - STALE_MS])
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
    const count = await reconcileStaleRepos(deps, clock, STALE_MS, noopLog)
    expect(synced).toEqual([1, 3])
    expect(count).toBe(2)
  })

  it('tombstones the installation on a token-mint 404 (missed uninstall webhook)', async () => {
    const deps = makeDeps([staleRepo({ installationId: 42 })], async () => {
      throw new InstallationTokenMintError(42, 404)
    })
    const warn = vi.fn()
    const log = { info: () => {}, warn, error: vi.fn() } as unknown as Logger
    const count = await reconcileStaleRepos(deps, clock, STALE_MS, log)
    expect(count).toBe(0)
    expect(deps.softDeleted).toEqual([[42, clock.now()]])
    // Gone-installation is an expected operational state: warn, not error.
    expect(warn).toHaveBeenCalled()
  })

  it('does NOT tombstone on a repo-level 404 or a mint 401 (transient/JWT faults)', async () => {
    for (const err of [
      new GitHubApiError(404, 'repo gone'),
      new InstallationTokenMintError(7, 401),
    ]) {
      const deps = makeDeps([staleRepo()], async () => {
        throw err
      })
      await reconcileStaleRepos(deps, clock, STALE_MS, noopLog)
      expect(deps.softDeleted).toEqual([])
    }
  })

  // I7: the tombstone/log classifiers read the structured status off the two errors the sync
  // throws (InstallationTokenMintError.status + GitHubApiError.status) — no message parsing — so
  // the remedy text is free to change and a repo-level 404 can never be mistaken for a gone install.
  // The log-level classifier reads the structured status off BOTH errors the sync throws: a
  // repo-level GitHubApiError(404) is an expected "gone repo" state → warn, not error.
  it('logs a repo-level GitHubApiError(404) at warn (gone), not error, without tombstoning', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger
    const deps = makeDeps([staleRepo()], async () => {
      throw new GitHubApiError(404, 'repo gone')
    })
    await reconcileStaleRepos(deps, clock, STALE_MS, log)
    expect(log.warn).toHaveBeenCalledOnce()
    expect(log.error).not.toHaveBeenCalled()
    expect(deps.softDeleted).toEqual([])
  })

  it('logs a genuine (non-gone) fault at error', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger
    const deps = makeDeps([staleRepo()], async () => {
      throw new GitHubApiError(500, 'server error')
    })
    await reconcileStaleRepos(deps, clock, STALE_MS, log)
    expect(log.error).toHaveBeenCalledOnce()
    expect(log.warn).not.toHaveBeenCalled()
  })
})
