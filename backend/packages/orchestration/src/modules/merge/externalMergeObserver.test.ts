import type { MergeTrackRecord, MergeTrackRecordPatch } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { MergeTrackRecordService } from './MergeTrackRecordService.js'
import { makeExternalMergeObserver } from './externalMergeObserver.js'

// The external-merge path: a human clicks merge on the provider, bypassing the merge card. The
// webhook ingest knows only `(repoId, prNumber)`, so the record written at the merger step is
// found by exactly that pair — which is why a record persisted with a null `repoId` makes this
// whole path dead. These tests pin the lookup key, the one-nudge-per-merge rule, and the
// idempotence a re-delivered webhook demands.

const WS = 'ws_1'
const REPO_ID = '987654'
const PR = 42

function baseRecord(overrides: Partial<MergeTrackRecord> = {}): MergeTrackRecord {
  return {
    id: 'mtr_exec_1',
    blockId: 'task_login',
    executionId: 'exec_1',
    changeClass: 'source',
    changedFileCount: 3,
    complexity: 0.2,
    risk: 0.2,
    impact: 0.2,
    riskPolicyId: null,
    riskPolicyName: 'Balanced',
    decision: 'pending_review',
    reviewEffort: null,
    prNumber: PR,
    prUrl: 'https://github.test/acme/repo/pull/42',
    repoId: REPO_ID,
    provider: 'github',
    createdAt: 1,
    resolvedAt: null,
    taggedAt: null,
    ...overrides,
  }
}

/** An in-memory repository that records the calls the observer makes. */
function fakeRepo(record: MergeTrackRecord | null) {
  const patches: MergeTrackRecordPatch[] = []
  const lookups: Array<{ repoId: string; prNumber: number }> = []
  let stored = record
  return {
    patches,
    lookups,
    get current() {
      return stored
    },
    repository: {
      insertIfAbsent: async (_ws: string, r: MergeTrackRecord) => r,
      get: async () => stored,
      getByExecution: async () => stored,
      getLatestByBlock: async () => stored,
      getByPullRequest: async (_ws: string, repoId: string, prNumber: number) => {
        lookups.push({ repoId, prNumber })
        return stored && stored.repoId === repoId && stored.prNumber === prNumber ? stored : null
      },
      patch: async (_ws: string, _id: string, patch: MergeTrackRecordPatch) => {
        patches.push(patch)
        if (stored) stored = { ...stored, ...patch } as MergeTrackRecord
      },
      rollupByClass: async () => [],
    },
  }
}

function makeService(repo: ReturnType<typeof fakeRepo>) {
  return new MergeTrackRecordService({
    mergeTrackRecordRepository: repo.repository,
    workspaceRepository: { get: async () => ({ id: WS }) } as never,
    clock: { now: () => 1_000 },
  })
}

/** Captures the notifications the observer raises. */
function fakeNotifications() {
  const raised: Array<{
    type: string
    blockId?: string | null
    payload?: Record<string, unknown>
  }> = []
  return { raised, service: { raise: async (_ws: string, n: never) => void raised.push(n) } }
}

describe('makeExternalMergeObserver', () => {
  it('attributes a pending record as external_merged and nudges for the effort tag', async () => {
    const repo = fakeRepo(baseRecord())
    const notifications = fakeNotifications()
    const observe = makeExternalMergeObserver({
      trackRecord: makeService(repo),
      notifications: notifications.service as never,
    })

    await observe(WS, REPO_ID, PR)

    // The lookup key is the only thing a webhook delivery can supply.
    expect(repo.lookups).toEqual([{ repoId: REPO_ID, prNumber: PR }])
    expect(repo.current?.decision).toBe('external_merged')
    expect(repo.current?.resolvedAt).toBe(1_000)
    expect(notifications.raised).toHaveLength(1)
    expect(notifications.raised[0]!.type).toBe('merge_tag_request')
    // The card must carry the record id: an external merge has no run the block lookup would
    // find reliably, so the tag route is addressed by id.
    expect(notifications.raised[0]!.payload).toMatchObject({
      mergeTrackRecordId: 'mtr_exec_1',
      changeClass: 'source',
    })
  })

  it('raises no second nudge when the webhook delivery is repeated', async () => {
    const repo = fakeRepo(baseRecord())
    const notifications = fakeNotifications()
    const observe = makeExternalMergeObserver({
      trackRecord: makeService(repo),
      notifications: notifications.service as never,
    })

    await observe(WS, REPO_ID, PR)
    await observe(WS, REPO_ID, PR)

    expect(repo.current?.decision).toBe('external_merged')
    expect(notifications.raised).toHaveLength(1)
  })

  it('ignores the echo of a merge cat-factory performed itself', async () => {
    // An already-resolved record means the merge went through cat-factory; this delivery is our
    // own merge coming back, not a human acting on the provider.
    const repo = fakeRepo(baseRecord({ decision: 'auto_merged', resolvedAt: 5 }))
    const notifications = fakeNotifications()
    const observe = makeExternalMergeObserver({
      trackRecord: makeService(repo),
      notifications: notifications.service as never,
    })

    await observe(WS, REPO_ID, PR)

    expect(repo.current?.decision).toBe('auto_merged')
    expect(repo.patches).toHaveLength(0)
    expect(notifications.raised).toHaveLength(0)
  })

  it('does nothing for a pull request with no track record', async () => {
    const repo = fakeRepo(null)
    const notifications = fakeNotifications()
    const observe = makeExternalMergeObserver({
      trackRecord: makeService(repo),
      notifications: notifications.service as never,
    })

    await observe(WS, 'other-repo', 7)

    expect(repo.patches).toHaveLength(0)
    expect(notifications.raised).toHaveLength(0)
  })
})

describe('MergeTrackRecordService.resolveDecision', () => {
  it('does not re-decide a record that already landed, but still accepts a later tag', async () => {
    // The stale-card case: a PR merged on the provider is recorded `external_merged`, and its
    // merge-review card is still open. Dismissing that card must NOT rewrite a merged PR as
    // `rejected` — that would corrupt the rollup this record exists to produce.
    const repo = fakeRepo(baseRecord({ decision: 'external_merged', resolvedAt: 5 }))
    const service = makeService(repo)

    await service.resolveDecision(WS, 'exec_1', 'rejected')
    expect(repo.current?.decision).toBe('external_merged')
    expect(repo.patches).toHaveLength(0)

    await service.resolveDecision(WS, 'exec_1', 'human_merged', 'minor')
    expect(repo.current?.decision).toBe('external_merged')
    expect(repo.current?.reviewEffort).toBe('minor')
  })

  it('settles a still-pending record normally', async () => {
    const repo = fakeRepo(baseRecord())
    const service = makeService(repo)

    await service.resolveDecision(WS, 'exec_1', 'human_merged', 'none')

    expect(repo.current?.decision).toBe('human_merged')
    expect(repo.current?.reviewEffort).toBe('none')
    expect(repo.current?.taggedAt).toBe(1_000)
  })
})
