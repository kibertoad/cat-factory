import { describe, expect, it } from 'vitest'
import { createRecordingLogger, WRITEBACK_POST_CLAIM_TTL_MS } from '@cat-factory/kernel'
import type {
  TaskRecord,
  TaskRepository,
  TaskSourceKind,
  TaskSourceProvider,
  TrackerSettingsRepository,
} from '@cat-factory/kernel'
import { IssueWritebackService } from './IssueWritebackService.js'
import { PLATFORM_COMMENT_MARKER } from './reviewReplies.logic.js'
import { memoryWritebackPosts } from './test-support/memory-writeback-posts.js'

const DOCUMENT = '# Export Requirements\n\n## Overview\nAsk @alice whether this closes #42.'

function issue(source: TaskSourceKind, externalId: string): TaskRecord {
  return { workspaceId: 'ws', source, externalId, linkedBlockId: 'blk_1' } as TaskRecord
}

function tasks(issues: TaskRecord[]): TaskRepository {
  return { listByBlock: async () => issues } as unknown as TaskRepository
}

const NO_SETTINGS = { get: async () => null } as unknown as TrackerSettingsRepository

const memoryMarkers = memoryWritebackPosts

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
      writebackPostRepository: memoryMarkers(),
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
      writebackPostRepository: memoryMarkers(),
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
    markers.claim = async () => 'held'
    const svc = new IssueWritebackService({
      trackerSettingsRepository: NO_SETTINGS,
      taskRepository: tasks([issue('github', 'acme/web#3')]),
      taskSourceProviders: [github.provider],
      writebackPostRepository: markers,
    })
    const result = await svc.postRefinedRequirements('ws', 'blk_1', {
      reviewId: 'rr_1',
      document: DOCUMENT,
    })
    expect(result.issues[0]!.outcome).toBe('in_flight')
    expect(github.bodies).toHaveLength(0)
  })

  it('never re-takes an unsettled claim, however old: the comment may already have landed', async () => {
    const github = recordingSource('github')
    const markers = memoryMarkers()
    let now = 1
    const logger = createRecordingLogger()
    const svc = new IssueWritebackService({
      trackerSettingsRepository: NO_SETTINGS,
      taskRepository: tasks([issue('github', 'acme/web#3')]),
      taskSourceProviders: [github.provider],
      writebackPostRepository: markers,
      clock: { now: () => now },
      sleep: async () => {},
      logger,
    })
    // The comment lands, then every settle attempt fails: the row is left `pending`.
    markers.settle = async () => {
      throw new Error('persistence RPC unreachable')
    }
    const first = await svc.postRefinedRequirements('ws', 'blk_1', {
      reviewId: 'rr_1',
      document: DOCUMENT,
    })
    expect(first.issues[0]!.outcome).toBe('posted')
    expect(logger.lines.filter((line) => line.level === 'error')).toMatchObject([
      {
        msg: 'writeback marker could not be settled; the post stays held',
        fields: { attempts: 3 },
      },
    ])

    now += 1_000 * WRITEBACK_POST_CLAIM_TTL_MS
    const later = await svc.postRefinedRequirements('ws', 'blk_1', {
      reviewId: 'rr_1',
      document: DOCUMENT,
    })
    expect(later.issues[0]!.outcome).toBe('in_flight')
    expect(github.bodies).toHaveLength(1)
  })

  it('retries a settle that fails transiently, so the post reads as already posted', async () => {
    const github = recordingSource('github')
    const markers = memoryMarkers()
    const settle = markers.settle.bind(markers)
    let failures = 2
    markers.settle = async (...args) => {
      if (failures-- > 0) throw new Error('blip')
      return settle(...args)
    }
    const logger = createRecordingLogger()
    const svc = new IssueWritebackService({
      trackerSettingsRepository: NO_SETTINGS,
      taskRepository: tasks([issue('github', 'acme/web#3')]),
      taskSourceProviders: [github.provider],
      writebackPostRepository: markers,
      sleep: async () => {},
      logger,
    })
    await svc.postRefinedRequirements('ws', 'blk_1', { reviewId: 'rr_1', document: DOCUMENT })
    const again = await svc.postRefinedRequirements('ws', 'blk_1', {
      reviewId: 'rr_1',
      document: DOCUMENT,
    })
    expect(again.issues[0]!.outcome).toBe('already_posted')
    expect(logger.lines.filter((line) => line.level === 'error')).toEqual([])
  })

  it('isolates a failing tracker, records the scrubbed cause, and retries it on the next post', async () => {
    const broken = recordingSource('jira', true)
    const github = recordingSource('github')
    const markers = memoryMarkers()
    const svc = new IssueWritebackService({
      trackerSettingsRepository: NO_SETTINGS,
      taskRepository: tasks([issue('jira', 'ENG-7'), issue('github', 'acme/web#3')]),
      taskSourceProviders: [broken.provider, github.provider],
      writebackPostRepository: markers,
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
      writebackPostRepository: markers,
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
      writebackPostRepository: memoryMarkers(),
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
