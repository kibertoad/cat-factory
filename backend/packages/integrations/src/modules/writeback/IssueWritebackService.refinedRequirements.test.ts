import { describe, expect, it } from 'vitest'
import type {
  RefinedRequirementsPostKey,
  RefinedRequirementsPostRecord,
  RefinedRequirementsPostRepository,
  TaskRecord,
  TaskRepository,
  TaskSourceKind,
  TaskSourceProvider,
  TrackerSettingsRepository,
} from '@cat-factory/kernel'
import { IssueWritebackService } from './IssueWritebackService.js'
import { PLATFORM_COMMENT_MARKER } from './reviewReplies.logic.js'

const DOCUMENT = '# Export Requirements\n\n## Overview\nAsk @alice whether this closes #42.'

function issue(source: TaskSourceKind, externalId: string): TaskRecord {
  return { workspaceId: 'ws', source, externalId, linkedBlockId: 'blk_1' } as TaskRecord
}

function tasks(issues: TaskRecord[]): TaskRepository {
  return { listByBlock: async () => issues } as unknown as TaskRepository
}

const NO_SETTINGS = { get: async () => null } as unknown as TrackerSettingsRepository

/** An in-memory marker store with the same claim rules the two SQL dialects implement. */
function memoryMarkers(): RefinedRequirementsPostRepository & {
  rows: Map<string, RefinedRequirementsPostRecord>
} {
  const rows = new Map<string, RefinedRequirementsPostRecord>()
  const id = (key: RefinedRequirementsPostKey) =>
    [key.workspaceId, key.reviewId, key.issueRef, key.documentHash].join('|')
  return {
    rows,
    async claim(key, window) {
      const row = rows.get(id(key))
      const stale = row?.status === 'pending' && row.updatedAt <= window.reclaimPendingBefore
      if (row && row.status !== 'failed' && !stale) return false
      rows.set(id(key), {
        ...key,
        status: 'pending',
        attempts: (row?.attempts ?? 0) + 1,
        error: null,
        updatedAt: window.now,
      })
      return true
    },
    async settle(key, outcome, now) {
      const row = rows.get(id(key))
      if (!row) return
      rows.set(id(key), {
        ...row,
        status: outcome.status,
        error: outcome.status === 'failed' ? outcome.error : null,
        updatedAt: now,
      })
    },
    async get(key) {
      return rows.get(id(key)) ?? null
    },
  }
}

function recordingSource(kind: TaskSourceKind, fail = false) {
  const bodies: { externalId: string; body: string }[] = []
  const provider = {
    kind,
    writeback: {
      authenticates: 'out-of-band',
      async comment(_ctx: unknown, externalId: string, body: string) {
        if (fail) throw new Error('tracker down for https://x.test/?token=sk-secret')
        bodies.push({ externalId, body })
      },
    },
  } as unknown as TaskSourceProvider
  return { provider, bodies }
}

describe('IssueWritebackService.postRefinedRequirements', () => {
  it('posts the document as a marked comment on every linked issue, never twice', async () => {
    const github = recordingSource('github')
    const jira = recordingSource('jira')
    const svc = new IssueWritebackService({
      trackerSettingsRepository: NO_SETTINGS,
      taskRepository: tasks([issue('github', 'acme/web#3'), issue('jira', 'ENG-7')]),
      taskSourceProviders: [github.provider, jira.provider],
      refinedRequirementsPostRepository: memoryMarkers(),
    })

    const first = await svc.postRefinedRequirements('ws', 'blk_1', {
      reviewId: 'rr_1',
      document: DOCUMENT,
    })
    expect(first.issues).toEqual([
      { source: 'github', externalId: 'acme/web#3', outcome: 'posted' },
      { source: 'jira', externalId: 'ENG-7', outcome: 'posted' },
    ])
    const body = github.bodies[0]!.body
    expect(body.startsWith(PLATFORM_COMMENT_MARKER)).toBe(true)
    expect(body).toContain('## Overview')
    // Model-authored text reaches a host-parsed surface defused: no mention, no cross-link.
    expect(body).not.toContain('@alice')
    expect(body).not.toContain('#42')

    const again = await svc.postRefinedRequirements('ws', 'blk_1', {
      reviewId: 'rr_1',
      document: DOCUMENT,
    })
    expect(again.issues.map((r) => r.outcome)).toEqual(['already_posted', 'already_posted'])
    expect(github.bodies).toHaveLength(1)
    expect(jira.bodies).toHaveLength(1)
  })

  it('posts a REVISED document again, since the document is part of the key', async () => {
    const github = recordingSource('github')
    const svc = new IssueWritebackService({
      trackerSettingsRepository: NO_SETTINGS,
      taskRepository: tasks([issue('github', 'acme/web#3')]),
      taskSourceProviders: [github.provider],
      refinedRequirementsPostRepository: memoryMarkers(),
    })
    await svc.postRefinedRequirements('ws', 'blk_1', { reviewId: 'rr_1', document: DOCUMENT })
    const revised = await svc.postRefinedRequirements('ws', 'blk_1', {
      reviewId: 'rr_1',
      document: `${DOCUMENT}\n\n## Out of Scope\nPrinting.`,
    })
    expect(revised.issues[0]!.outcome).toBe('posted')
    expect(github.bodies).toHaveLength(2)
  })

  it('reports a live claim as in flight rather than posting a second copy', async () => {
    const github = recordingSource('github')
    const markers = memoryMarkers()
    markers.claim = async () => false
    const svc = new IssueWritebackService({
      trackerSettingsRepository: NO_SETTINGS,
      taskRepository: tasks([issue('github', 'acme/web#3')]),
      taskSourceProviders: [github.provider],
      refinedRequirementsPostRepository: markers,
    })
    const result = await svc.postRefinedRequirements('ws', 'blk_1', {
      reviewId: 'rr_1',
      document: DOCUMENT,
    })
    expect(result.issues[0]!.outcome).toBe('in_flight')
    expect(github.bodies).toHaveLength(0)
  })

  it('isolates a failing tracker, records the scrubbed cause, and retries it on the next post', async () => {
    const broken = recordingSource('jira', true)
    const github = recordingSource('github')
    const markers = memoryMarkers()
    const svc = new IssueWritebackService({
      trackerSettingsRepository: NO_SETTINGS,
      taskRepository: tasks([issue('jira', 'ENG-7'), issue('github', 'acme/web#3')]),
      taskSourceProviders: [broken.provider, github.provider],
      refinedRequirementsPostRepository: markers,
    })
    const result = await svc.postRefinedRequirements('ws', 'blk_1', {
      reviewId: 'rr_1',
      document: DOCUMENT,
    })
    expect(result.issues.map((r) => r.outcome)).toEqual(['failed', 'posted'])
    const failed = [...markers.rows.values()].find((row) => row.status === 'failed')!
    expect(failed.error).not.toContain('sk-secret')

    const retry = await svc.postRefinedRequirements('ws', 'blk_1', {
      reviewId: 'rr_1',
      document: DOCUMENT,
    })
    expect(retry.issues.map((r) => r.outcome)).toEqual(['failed', 'already_posted'])
    expect([...markers.rows.values()].find((row) => row.status === 'failed')!.attempts).toBe(2)
  })

  it('reports a source with no writeback as unsupported and takes no claim for it', async () => {
    const markers = memoryMarkers()
    const svc = new IssueWritebackService({
      trackerSettingsRepository: NO_SETTINGS,
      taskRepository: tasks([issue('acme-tracker' as TaskSourceKind, 'A-1')]),
      taskSourceProviders: [],
      refinedRequirementsPostRepository: markers,
    })
    const result = await svc.postRefinedRequirements('ws', 'blk_1', {
      reviewId: 'rr_1',
      document: DOCUMENT,
    })
    expect(result.issues[0]!.outcome).toBe('unsupported')
    expect(markers.rows.size).toBe(0)
  })

  it('returns an empty result for a block with no linked issues', async () => {
    const svc = new IssueWritebackService({
      trackerSettingsRepository: NO_SETTINGS,
      taskRepository: tasks([]),
      refinedRequirementsPostRepository: memoryMarkers(),
    })
    expect(
      await svc.postRefinedRequirements('ws', 'blk_1', { reviewId: 'rr_1', document: DOCUMENT }),
    ).toEqual({ issues: [] })
  })

  it('refuses rather than posting unguarded when no marker store is wired', async () => {
    const svc = new IssueWritebackService({
      trackerSettingsRepository: NO_SETTINGS,
      taskRepository: tasks([issue('github', 'acme/web#3')]),
    })
    await expect(
      svc.postRefinedRequirements('ws', 'blk_1', { reviewId: 'rr_1', document: DOCUMENT }),
    ).rejects.toMatchObject({ code: 'unavailable' })
  })
})
