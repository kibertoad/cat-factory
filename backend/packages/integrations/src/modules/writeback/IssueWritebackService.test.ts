import { describe, expect, it } from 'vitest'
import { DEFAULT_TRACKER_WRITEBACK } from '@cat-factory/contracts'
import { REVIEW_QUESTION_POST_CLAIM_TTL_MS } from '@cat-factory/kernel'
import type {
  Block,
  PullRequestRef,
  ReviewQuestionPost,
  ReviewQuestionPostKey,
  ReviewQuestionPostRecord,
  ReviewQuestionPostRepository,
  TaskConnectionStore,
  SealedConnectionOpenResult,
  TaskConnectionRecord,
  TaskInProgressMark,
  TaskRecord,
  TaskSourceKind,
  TaskSourceProvider,
  TaskWritebackContext,
  TrackerSettings,
  TrackerSettingsRepository,
  TaskRepository,
} from '@cat-factory/kernel'
import { IssueWritebackService } from './IssueWritebackService.js'

// What this service owns is the SHARED half of every writeback: the workspace settings gating,
// the linked-issue fan-out and its per-issue isolation, the reply-channel resolution and the
// parked-review idempotency marker. The vendor half rides each source's own provider, so these
// tests drive a RECORDING source rather than a stubbed Jira/Linear transport, and each vendor
// adapter is tested beside itself (`tasks/writeback/*.test.ts`).

const PR: PullRequestRef = { url: 'https://github.com/acme/web/pull/7', number: 7 }

function block(overrides: Partial<Block> = {}): Block {
  return { id: 'blk_1', ...overrides } as Block
}

function settings(overrides: Partial<TrackerSettings> = {}): TrackerSettings {
  return {
    tracker: null,
    jiraProjectKey: null,
    linearTeamId: null,
    writebackCommentOnPrOpen: false,
    writebackResolveOnMerge: false,
    writebackQuestionsOnPark: false,
    updatedAt: 0,
    ...overrides,
  }
}

function fakeTrackerSettings(value: TrackerSettings): TrackerSettingsRepository {
  return {
    get: async () => value,
    merge: async () => value,
  }
}

function fakeTasks(issues: TaskRecord[]): TaskRepository {
  return {
    upsert: async () => {},
    get: async () => null,
    listByRefs: async () => [],
    getByUrl: async () => null,
    listByWorkspace: async () => issues,
    listByBlock: async () => issues,
    linkBlock: async () => {},
    claimBlockLink: async () => true,
    unlinkAllFromBlock: async () => {},
    unlinkAllFromBlocks: async () => {},
  }
}

/**
 * A connection store whose rows carry (or lack) a minted inbound webhook secret: the one fact
 * that decides whether a reply typed on the ticket reaches the run, and therefore whether the
 * question comment may tell a reporter to type one. The same read hands each adapter its
 * credential bag.
 */
function fakeConnections(
  options: {
    webhookSecret?: string
    /** The stored-row READ itself fails, before any source is opened. */
    throws?: boolean
    /** Sources whose sealed bag will not open, the rest of the batch answering normally. */
    unreadable?: readonly TaskSourceKind[]
    /** Extra credential fields the opened bag carries, as a vendor connection would. */
    credentials?: Record<string, string>
  } = {},
): TaskConnectionStore {
  const unreadable = new Set(options.unreadable ?? [])
  return {
    getByWorkspace: async () => null,
    listBySources: async (_ws, sources) => {
      if (options.throws) throw new Error('cipher unavailable')
      return sources.map(
        (source): SealedConnectionOpenResult<TaskSourceKind, TaskConnectionRecord> =>
          unreadable.has(source)
            ? { source, status: 'unreadable' as const, cause: new Error('corrupt envelope') }
            : {
                source,
                status: 'opened' as const,
                connection: {
                  workspaceId: 'ws',
                  source,
                  credentials: {
                    ...options.credentials,
                    ...(options.webhookSecret ? { webhookSecret: options.webhookSecret } : {}),
                  },
                  label: source,
                  createdAt: 0,
                  deletedAt: null,
                },
              },
      )
    },
    listSummaries: async () => [],
    upsert: async () => {},
    softDelete: async () => {},
  }
}

function githubIssue(externalId: string): TaskRecord {
  return {
    workspaceId: 'ws',
    source: 'github',
    externalId,
    title: 't',
    url: `https://github.com/${externalId}`,
    status: '',
    type: '',
    assignee: null,
    priority: null,
    labels: [],
    description: '',
    comments: [],
    excerpt: '',
    linkedBlockId: 'blk_1',
    syncedAt: 0,
    deletedAt: null,
  }
}

/** Everything one source's writeback adapter was asked to do, in order. */
interface RecordedWriteback {
  comments: { workspaceId: string; externalId: string; body: string; credentials: string[] }[]
  resolved: string[]
  marked: { externalId: string; label: string | undefined }[]
}

/** A registered task source whose writeback adapter records what it was asked to do. */
function recordingSource(
  kind: TaskSourceKind,
  over: {
    /** Fail this source's comment: the transport is wired, the call does not land. */
    failComment?: (externalId: string) => Error | null
    /** Drop a capability, the way a vendor without the notion would. */
    omit?: ('resolve' | 'markInProgress')[]
    /**
     * Where this adapter gets its authority. Defaults to `stored-connection`, the strict answer,
     * so a case that wants the credentialless behaviour has to ask for it.
     */
    authenticates?: 'stored-connection' | 'out-of-band'
  } = {},
): { provider: TaskSourceProvider; recorded: RecordedWriteback } {
  const recorded: RecordedWriteback = { comments: [], resolved: [], marked: [] }
  const omitted = new Set(over.omit ?? [])
  const adapter = {
    authenticates: over.authenticates ?? 'stored-connection',
    async comment(ctx: TaskWritebackContext, externalId: string, body: string) {
      const failure = over.failComment?.(externalId)
      if (failure) throw failure
      recorded.comments.push({
        workspaceId: ctx.workspaceId,
        externalId,
        body,
        credentials: Object.keys(ctx.credentials).sort(),
      })
    },
    ...(omitted.has('resolve')
      ? {}
      : {
          async resolve(_ctx: TaskWritebackContext, externalId: string) {
            recorded.resolved.push(externalId)
          },
        }),
    ...(omitted.has('markInProgress')
      ? {}
      : {
          async markInProgress(
            _ctx: TaskWritebackContext,
            externalId: string,
            mark: TaskInProgressMark,
          ) {
            recorded.marked.push({ externalId, label: mark.label })
          },
        }),
  }
  return { provider: { kind, writeback: adapter } as unknown as TaskSourceProvider, recorded }
}

/** The common case: one recording GitHub Issues source, plus the service built over it. */
function serviceWith(
  deps: Omit<ConstructorParameters<typeof IssueWritebackService>[0], 'taskSourceProviders'>,
  source = recordingSource('github'),
): { svc: IssueWritebackService; recorded: RecordedWriteback } {
  return {
    svc: new IssueWritebackService({ ...deps, taskSourceProviders: [source.provider] }),
    recorded: source.recorded,
  }
}

describe('IssueWritebackService — flag gating', () => {
  it('does nothing when the workspace flag is off and no override is set', async () => {
    const { svc, recorded } = serviceWith({
      trackerSettingsRepository: fakeTrackerSettings(settings()),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
    })
    await svc.onPullRequestOpened('ws', block(), PR)
    expect(recorded.comments).toHaveLength(0)
  })

  it('comments on PR open when the workspace flag is on', async () => {
    const { svc, recorded } = serviceWith({
      trackerSettingsRepository: fakeTrackerSettings(settings({ writebackCommentOnPrOpen: true })),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
    })
    await svc.onPullRequestOpened('ws', block(), PR)
    expect(recorded.comments).toHaveLength(1)
    expect(recorded.comments[0]!.externalId).toBe('acme/web#3')
    expect(recorded.comments[0]!.body).toContain(PR.url)
  })

  it('per-task override off beats a workspace on', async () => {
    const { svc, recorded } = serviceWith({
      trackerSettingsRepository: fakeTrackerSettings(settings({ writebackCommentOnPrOpen: true })),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
    })
    await svc.onPullRequestOpened('ws', block({ trackerCommentOnPrOpen: 'off' }), PR)
    expect(recorded.comments).toHaveLength(0)
  })

  it('per-task override on beats a workspace off', async () => {
    const { svc, recorded } = serviceWith({
      trackerSettingsRepository: fakeTrackerSettings(settings()),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
    })
    await svc.onPullRequestOpened('ws', block({ trackerCommentOnPrOpen: 'on' }), PR)
    expect(recorded.comments).toHaveLength(1)
  })
})

describe('IssueWritebackService: dispatch through the source registry', () => {
  it('hands the adapter the workspace and its stored credential bag', async () => {
    // The credentials a vendor adapter authenticates with come from the SAME per-source read
    // that decides the reply channel, so the two halves of the writeback cannot end up pointing
    // at different connections.
    const { svc, recorded } = serviceWith({
      trackerSettingsRepository: fakeTrackerSettings(settings({ writebackCommentOnPrOpen: true })),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
      taskConnectionStore: fakeConnections({ credentials: { apiToken: 'tok' } }),
    })
    await svc.onPullRequestOpened('ws', block(), PR)
    expect(recorded.comments[0]!.workspaceId).toBe('ws')
    expect(recorded.comments[0]!.credentials).toEqual(['apiToken'])
  })

  it('writes back to a source the deployment REGISTERED, with no wiring of its own', async () => {
    // The whole point of the capability: a tracker a deployment registers gets the loop by
    // declaring a writeback adapter, where the vendor chain this replaced could not have reached
    // it however it was wired.
    const custom = recordingSource('acme-tracker' as TaskSourceKind)
    const svc = new IssueWritebackService({
      trackerSettingsRepository: fakeTrackerSettings(settings({ writebackResolveOnMerge: true })),
      taskRepository: fakeTasks([
        { ...githubIssue('ACME-9'), source: 'acme-tracker' as TaskSourceKind },
      ]),
      taskSourceProviders: [custom.provider],
    })
    await svc.onPullRequestMerged('ws', block(), PR)
    expect(custom.recorded.comments).toHaveLength(1)
    expect(custom.recorded.resolved).toEqual(['ACME-9'])
  })

  it('does nothing for a source with no registered provider', async () => {
    // Not a throw: a stale row for a source this deployment no longer wires has nothing to write
    // back through, and the fire-and-forget hooks report it rather than failing the run.
    const linear = recordingSource('linear')
    const svc = new IssueWritebackService({
      trackerSettingsRepository: fakeTrackerSettings(settings({ writebackCommentOnPrOpen: true })),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
      taskSourceProviders: [linear.provider],
    })
    await svc.onPullRequestOpened('ws', block(), PR)
    expect(linear.recorded.comments).toHaveLength(0)
  })
})

describe('IssueWritebackService: merge writeback', () => {
  it('comments + resolves for a workspace with NO settings row, which is the default stance', async () => {
    // The absent row is the common case, not an edge one: nothing writes `tracker_settings` until
    // somebody opens the panel or calls `PATCH /api/v1/tracker/writeback`, so this is what happens
    // to every issue on a board that has configured nothing. It used to be nothing at all, and the
    // symptom was a merged pull request beside an issue still sitting open with no explanation on
    // it. Read from the shared constant, so a change of stance moves this test rather than being
    // silently contradicted by it.
    const absent: TrackerSettingsRepository = {
      get: async () => null,
      merge: async () => settings(),
    }
    const { svc, recorded } = serviceWith({
      trackerSettingsRepository: absent,
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
    })
    await svc.onPullRequestMerged('ws', block(), PR)
    expect(DEFAULT_TRACKER_WRITEBACK.writebackResolveOnMerge).toBe(true)
    expect(recorded.resolved).toEqual(['acme/web#3'])
    expect(recorded.comments).toHaveLength(1)
  })

  it('still honours a per-task override that turns the default OFF', async () => {
    // The override is the escape hatch the flipped default makes matter: a task whose ticket must
    // stay open says so on the block, and the workspace default no longer answers for it.
    const absent: TrackerSettingsRepository = {
      get: async () => null,
      merge: async () => settings(),
    }
    const { svc, recorded } = serviceWith({
      trackerSettingsRepository: absent,
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
    })
    await svc.onPullRequestMerged('ws', block({ trackerResolveOnMerge: 'off' }), PR)
    expect(recorded.resolved).toEqual([])
    expect(recorded.comments).toHaveLength(0)
  })

  it('comments + resolves the issue on merge when resolveOnMerge is on', async () => {
    const { svc, recorded } = serviceWith({
      trackerSettingsRepository: fakeTrackerSettings(settings({ writebackResolveOnMerge: true })),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
    })
    await svc.onPullRequestMerged('ws', block(), PR)
    expect(recorded.comments).toHaveLength(1)
    expect(recorded.resolved).toEqual(['acme/web#3'])
  })

  it('does not resolve on PR open', async () => {
    const { svc, recorded } = serviceWith({
      trackerSettingsRepository: fakeTrackerSettings(
        settings({ writebackCommentOnPrOpen: true, writebackResolveOnMerge: true }),
      ),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
    })
    await svc.onPullRequestOpened('ws', block(), PR)
    expect(recorded.resolved).toHaveLength(0)
  })

  it('comments and leaves the issue open when the source cannot resolve one', async () => {
    // A vendor with no closable notion omits `resolve`. The comment still lands and the issue
    // stays open, which is a real answer rather than a failure.
    const { svc, recorded } = serviceWith(
      {
        trackerSettingsRepository: fakeTrackerSettings(settings({ writebackResolveOnMerge: true })),
        taskRepository: fakeTasks([githubIssue('acme/web#3')]),
      },
      recordingSource('github', { omit: ['resolve'] }),
    )
    await svc.onPullRequestMerged('ws', block(), PR)
    expect(recorded.comments).toHaveLength(1)
    expect(recorded.resolved).toEqual([])
  })

  it('isolates a failing issue so the others still get written back', async () => {
    const { svc, recorded } = serviceWith(
      {
        trackerSettingsRepository: fakeTrackerSettings(settings({ writebackResolveOnMerge: true })),
        taskRepository: fakeTasks([githubIssue('acme/web#1'), githubIssue('acme/web#2')]),
      },
      recordingSource('github', {
        failComment: (externalId) => (externalId === 'acme/web#1' ? new Error('boom') : null),
      }),
    )
    await svc.onPullRequestMerged('ws', block(), PR)
    // #1's comment threw (so it never resolved); #2 still resolved.
    expect(recorded.resolved).toEqual(['acme/web#2'])
  })
})

describe('IssueWritebackService — issue pickup (bug intake)', () => {
  it('comments with the run link and marks the issue in progress', async () => {
    const { svc, recorded } = serviceWith({
      // Both writeback flags OFF: pickup is intake semantics, not settings-gated.
      trackerSettingsRepository: fakeTrackerSettings(settings()),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
    })
    await svc.onIssuePickedUp('ws', 'blk_1', {
      runUrl: 'https://app.example.test/run/1',
      inProgressLabel: 'bot-working',
    })
    expect(recorded.comments).toHaveLength(1)
    expect(recorded.comments[0]!.body).toContain('https://app.example.test/run/1')
    expect(recorded.marked).toEqual([{ externalId: 'acme/web#3', label: 'bot-working' }])
  })

  it('leaves the label unset when the schedule names none, so the adapter picks its default', async () => {
    // The default belongs to the source that needs a label at all (GitHub and GitLab have no
    // workflow status); a vendor WITH one must not be handed a label to apply instead.
    const { svc, recorded } = serviceWith({
      trackerSettingsRepository: fakeTrackerSettings(settings()),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
    })
    await svc.onIssuePickedUp('ws', 'blk_1', {})
    expect(recorded.marked).toEqual([{ externalId: 'acme/web#3', label: undefined }])
  })

  it('isolates a failing issue so the others are still marked', async () => {
    const { svc, recorded } = serviceWith(
      {
        trackerSettingsRepository: fakeTrackerSettings(settings()),
        taskRepository: fakeTasks([githubIssue('acme/web#1'), githubIssue('acme/web#2')]),
      },
      recordingSource('github', {
        failComment: (externalId) => (externalId === 'acme/web#1' ? new Error('boom') : null),
      }),
    )
    await svc.onIssuePickedUp('ws', 'blk_1', {})
    expect(recorded.marked.map((m) => m.externalId)).toEqual(['acme/web#2'])
  })

  it('does nothing when the block has no linked issue', async () => {
    const { svc, recorded } = serviceWith({
      trackerSettingsRepository: fakeTrackerSettings(settings()),
      taskRepository: fakeTasks([]),
    })
    await svc.onIssuePickedUp('ws', 'blk_1', {})
    expect(recorded.comments).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// postReviewQuestions — the headless clarification loop's question echo (slice 2a of
// backend/docs/adr/0047-headless-clarification-loop.md). The engine has already established that
// the run is headless and the review has open findings; what is asserted here is the
// provider's half: the workspace opt-in, and the idempotency that keeps a REPLAYING durable
// driver from re-posting the same questions onto an issue a human is reading.
// ---------------------------------------------------------------------------

/** The marker key every case below reads back: the one linked issue of `block()`. */
function markerKey(): ReviewQuestionPostKey {
  return { workspaceId: 'ws', reviewId: 'rr_1', iteration: 1, issueRef: 'github:acme/web#3' }
}

function questionPost(over: Partial<ReviewQuestionPost> = {}): ReviewQuestionPost {
  return {
    subject: 'requirements',
    reviewId: 'rr_1',
    iteration: 1,
    maxIterations: 6,
    runId: 'exe_9',
    findings: [{ id: 'itm_1', title: 'Which currencies?', detail: 'The spec omits them.' }],
    ...over,
  }
}

/** An in-memory marker store with the same claim-once/retry-on-failure contract as both repos. */
function fakeMarkers(): ReviewQuestionPostRepository & {
  rows: Map<string, ReviewQuestionPostRecord>
} {
  const rows = new Map<string, ReviewQuestionPostRecord>()
  const k = (key: ReviewQuestionPostKey) =>
    `${key.workspaceId}|${key.reviewId}|${key.iteration}|${key.issueRef}`
  return {
    rows,
    async claim(key, window) {
      const existing = rows.get(k(key))
      // Mirrors both repos' claim predicate: a `failed` row retries, and a `pending` one is
      // stealable only once it is old enough to be abandoned rather than in flight.
      const abandoned =
        existing?.status === 'pending' && existing.updatedAt <= window.reclaimPendingBefore
      if (existing && existing.status !== 'failed' && !abandoned) return false
      rows.set(k(key), {
        ...key,
        status: 'pending',
        attempts: (existing?.attempts ?? 0) + 1,
        error: null,
        updatedAt: window.now,
      })
      return true
    },
    async settle(key, outcome, now) {
      const existing = rows.get(k(key))
      if (!existing) return
      rows.set(k(key), {
        ...existing,
        status: outcome.status,
        error: outcome.status === 'failed' ? outcome.error : null,
        updatedAt: now,
      })
    },
    async get(key) {
      return rows.get(k(key)) ?? null
    },
  }
}

describe('IssueWritebackService.postReviewQuestions', () => {
  it('posts the rendered questions when the workspace opted in', async () => {
    const { svc, recorded } = serviceWith({
      trackerSettingsRepository: fakeTrackerSettings(settings({ writebackQuestionsOnPark: true })),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
      reviewQuestionPostRepository: fakeMarkers(),
    })
    const outcome = await svc.postReviewQuestions('ws', block(), questionPost())
    expect(outcome).toEqual({ posted: 1, skipped: 0, failed: 0 })
    expect(recorded.comments[0]!.body).toContain('`itm_1`')
  })

  it('stays off by default — the loop is opt-in per workspace', async () => {
    const { svc, recorded } = serviceWith({
      trackerSettingsRepository: fakeTrackerSettings(settings()),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
      reviewQuestionPostRepository: fakeMarkers(),
    })
    expect(await svc.postReviewQuestions('ws', block(), questionPost())).toEqual({
      posted: 0,
      skipped: 0,
      failed: 0,
    })
    expect(recorded.comments).toEqual([])
  })

  it('posts a CLARITY park with both flags off — asking a bug reporter is intake, not opt-in', async () => {
    const { svc, recorded } = serviceWith({
      // Workspace flag off AND the per-task override off: neither governs this subject, because
      // asking the reporter for what they left out is how the bug gets fixed at all.
      trackerSettingsRepository: fakeTrackerSettings(settings()),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
      reviewQuestionPostRepository: fakeMarkers(),
      taskConnectionStore: fakeConnections({ webhookSecret: 'whsec' }),
    })
    const outcome = await svc.postReviewQuestions(
      'ws',
      block({ trackerQuestionsOnPark: 'off' }),
      questionPost({ subject: 'clarity', reviewId: 'clr_1' }),
    )
    expect(outcome).toEqual({ posted: 1, skipped: 0, failed: 0 })
    // The id is what makes it answerable from the ticket at all: the bespoke echo this replaced
    // rendered the question prose alone.
    expect(recorded.comments[0]!.body).toContain('`itm_1`')
    expect(recorded.comments[0]!.body).toContain('@cat-factory answer <id>')
    // …and the copy is about the bug, not about requirements the reporter never wrote.
    expect(recorded.comments[0]!.body).toContain('fix this bug')
  })

  it('honours the per-task override in both directions', async () => {
    const on = serviceWith({
      trackerSettingsRepository: fakeTrackerSettings(settings()),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
      reviewQuestionPostRepository: fakeMarkers(),
    })
    await on.svc.postReviewQuestions('ws', block({ trackerQuestionsOnPark: 'on' }), questionPost())
    expect(on.recorded.comments).toHaveLength(1)

    const off = serviceWith({
      trackerSettingsRepository: fakeTrackerSettings(settings({ writebackQuestionsOnPark: true })),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
      reviewQuestionPostRepository: fakeMarkers(),
    })
    await off.svc.postReviewQuestions(
      'ws',
      block({ trackerQuestionsOnPark: 'off' }),
      questionPost(),
    )
    expect(off.recorded.comments).toEqual([])
  })

  it('posts ONCE across driver replays, and again on the next reviewer pass', async () => {
    const { svc, recorded } = serviceWith({
      trackerSettingsRepository: fakeTrackerSettings(settings({ writebackQuestionsOnPark: true })),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
      reviewQuestionPostRepository: fakeMarkers(),
    })
    await svc.postReviewQuestions('ws', block(), questionPost())
    const replay = await svc.postReviewQuestions('ws', block(), questionPost())
    expect(replay).toEqual({ posted: 0, skipped: 1, failed: 0 })
    expect(recorded.comments).toHaveLength(1)

    // A re-review bumps the iteration, which is part of the key: new findings DO get asked.
    await svc.postReviewQuestions('ws', block(), questionPost({ iteration: 2 }))
    expect(recorded.comments).toHaveLength(2)
  })

  it('records a failed post and RETRIES it on the next replay', async () => {
    let fail = true
    const markers = fakeMarkers()
    const { svc, recorded } = serviceWith(
      {
        trackerSettingsRepository: fakeTrackerSettings(
          settings({ writebackQuestionsOnPark: true }),
        ),
        taskRepository: fakeTasks([githubIssue('acme/web#3')]),
        reviewQuestionPostRepository: markers,
      },
      recordingSource('github', { failComment: () => (fail ? new Error('tracker down') : null) }),
    )
    expect(await svc.postReviewQuestions('ws', block(), questionPost())).toEqual({
      posted: 0,
      skipped: 0,
      failed: 1,
    })
    const marker = await markers.get(markerKey())
    expect(marker?.status).toBe('failed')
    expect(marker?.error).toContain('tracker down')

    fail = false
    expect(await svc.postReviewQuestions('ws', block(), questionPost())).toEqual({
      posted: 1,
      skipped: 0,
      failed: 0,
    })
    expect(recorded.comments).toHaveLength(1)
  })

  it('passes through with no marker store — posting unguarded would spam on every replay', async () => {
    const { svc, recorded } = serviceWith({
      trackerSettingsRepository: fakeTrackerSettings(settings({ writebackQuestionsOnPark: true })),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
    })
    expect(await svc.postReviewQuestions('ws', block(), questionPost())).toEqual({
      posted: 0,
      skipped: 0,
      failed: 0,
    })
    expect(recorded.comments).toEqual([])
  })

  it('does not mark an unwired source as posted; wiring it later must still deliver', async () => {
    const markers = fakeMarkers()
    const svc = new IssueWritebackService({
      trackerSettingsRepository: fakeTrackerSettings(settings({ writebackQuestionsOnPark: true })),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
      reviewQuestionPostRepository: markers,
      // No `github` provider registered at all.
      taskSourceProviders: [],
    })
    expect(await svc.postReviewQuestions('ws', block(), questionPost())).toEqual({
      posted: 0,
      skipped: 0,
      failed: 1,
    })
    const marker = await markers.get(markerKey())
    expect(marker?.status).toBe('failed')
  })

  it('does not mark an UNREADABLE connection as posted; the row exists and would not open', async () => {
    // Distinct from the unwired case above: the source IS registered, so this is a failure to
    // retry rather than a capability to add, and recording it as posted would mute the iteration.
    const markers = fakeMarkers()
    const { svc } = serviceWith({
      trackerSettingsRepository: fakeTrackerSettings(settings({ writebackQuestionsOnPark: true })),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
      reviewQuestionPostRepository: markers,
      taskConnectionStore: fakeConnections({ unreadable: ['github'] }),
    })
    expect(await svc.postReviewQuestions('ws', block(), questionPost())).toEqual({
      posted: 0,
      skipped: 0,
      failed: 1,
    })
    expect((await markers.get(markerKey()))?.status).toBe('failed')
  })

  it('does not mark an UNRESOLVED target as posted; reconnecting the App must still deliver', async () => {
    // A writeback adapter throws when it cannot resolve the issue (a workspace whose installation
    // is gone). Recording that as `posted` would mute this iteration permanently.
    const markers = fakeMarkers()
    const { svc } = serviceWith(
      {
        trackerSettingsRepository: fakeTrackerSettings(
          settings({ writebackQuestionsOnPark: true }),
        ),
        taskRepository: fakeTasks([githubIssue('acme/web#3')]),
        reviewQuestionPostRepository: markers,
      },
      recordingSource('github', {
        failComment: () => new Error('Cannot resolve GitHub issue acme/web#3 for this workspace'),
      }),
    )
    expect(await svc.postReviewQuestions('ws', block(), questionPost())).toEqual({
      posted: 0,
      skipped: 0,
      failed: 1,
    })
    expect((await markers.get(markerKey()))?.status).toBe('failed')
  })

  it('scrubs a credential out of the stored failure message', async () => {
    // The row is read back by operators; a transport error can quote the request it made.
    const markers = fakeMarkers()
    const { svc } = serviceWith(
      {
        trackerSettingsRepository: fakeTrackerSettings(
          settings({ writebackQuestionsOnPark: true }),
        ),
        taskRepository: fakeTasks([githubIssue('acme/web#3')]),
        reviewQuestionPostRepository: markers,
      },
      recordingSource('github', {
        failComment: () =>
          new Error('POST failed: authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123'),
      }),
    )
    await svc.postReviewQuestions('ws', block(), questionPost())
    const marker = await markers.get(markerKey())
    expect(marker?.error).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123')
    expect(marker?.error).toContain('[REDACTED]')
  })

  it('re-posts after a claim was ABANDONED mid-post, but not while one is in flight', async () => {
    // A poster killed between the claim and the comment (an evicted isolate, a killed durable
    // step) leaves a `pending` row nobody will settle. Without the takeover window that row is
    // terminal in practice: the questions never arrive AND nothing retries.
    const markers = fakeMarkers()
    let now = 10 * REVIEW_QUESTION_POST_CLAIM_TTL_MS
    const { svc, recorded } = serviceWith({
      trackerSettingsRepository: fakeTrackerSettings(settings({ writebackQuestionsOnPark: true })),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
      reviewQuestionPostRepository: markers,
      clock: { now: () => now },
    })

    // Simulate the death: claim the marker, then never settle it.
    await markers.claim(markerKey(), { now, reclaimPendingBefore: now - 1 })

    // A replay one tick short of the window must NOT steal a post that may still be in flight.
    now += REVIEW_QUESTION_POST_CLAIM_TTL_MS - 1
    expect(await svc.postReviewQuestions('ws', block(), questionPost())).toEqual({
      posted: 0,
      skipped: 1,
      failed: 0,
    })
    expect(recorded.comments).toEqual([])

    // Past the window the claim is abandoned, so the next replay takes it over and delivers.
    now += 1
    expect(await svc.postReviewQuestions('ws', block(), questionPost())).toEqual({
      posted: 1,
      skipped: 0,
      failed: 0,
    })
    expect(recorded.comments).toHaveLength(1)
    expect((await markers.get(markerKey()))?.status).toBe('posted')
  })
})

// ---------------------------------------------------------------------------
// Which answer channels the comment may offer.
//
// The comment leads with `@cat-factory answer <id> …` because the reporter is reading it in their
// tracker — but that path fails closed without a minted per-connection webhook secret, and a
// workspace on pull-based intake has none. Printing the grammar there is advice that silently does
// nothing, followed by the one person who came in through the ticket. So the provider establishes
// the fact (it owns the settings read and the linked-issue lookup already) and the renderer offers
// only what works.
// ---------------------------------------------------------------------------

describe('IssueWritebackService.postReviewQuestions — answer channels', () => {
  /** Post one question comment and hand back what landed on the issue. */
  async function postWith(
    connections: TaskConnectionStore | undefined,
    issues = [githubIssue('acme/web#3')],
  ): Promise<string> {
    const { svc, recorded } = serviceWith({
      trackerSettingsRepository: fakeTrackerSettings(settings({ writebackQuestionsOnPark: true })),
      taskRepository: fakeTasks(issues),
      reviewQuestionPostRepository: fakeMarkers(),
      ...(connections ? { taskConnectionStore: connections } : {}),
    })
    expect(await svc.postReviewQuestions('ws', block(), questionPost())).toEqual({
      posted: 1,
      skipped: 0,
      failed: 0,
    })
    return recorded.comments[0]!.body
  }

  it('offers the ticket grammar once a webhook secret is minted', async () => {
    expect(await postWith(fakeConnections({ webhookSecret: 'whsec' }))).toContain(
      '@cat-factory answer <id>',
    )
  })

  it('offers the API path ALONE on a connection with no secret', async () => {
    // The exact configuration a workspace lands in by connecting a tracker and importing tickets
    // without ever minting a delivery secret: supported, common, and the reply path fails closed.
    const body = await postWith(fakeConnections())
    expect(body).not.toContain('@cat-factory')
    expect(body).toContain('/decisions/requirements/findings/<id>/reply')
  })

  it('offers the API path alone when the facade wired no connection store at all', async () => {
    // Absent ⇒ unwired, never assumed wired: a facade that cannot establish the fact cannot
    // promise the channel.
    expect(await postWith(undefined)).not.toContain('@cat-factory')
  })

  it('refuses the post outright when the whole connection read fails', async () => {
    // The read that establishes the channel is also the one that authenticates the adapter, so a
    // batch-wide failure costs the POST as well as the grammar. Reported as failed and retried,
    // never posted with a promise the deployment cannot keep.
    const { svc } = serviceWith({
      trackerSettingsRepository: fakeTrackerSettings(settings({ writebackQuestionsOnPark: true })),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
      reviewQuestionPostRepository: fakeMarkers(),
      taskConnectionStore: fakeConnections({ throws: true }),
    })
    expect(await svc.postReviewQuestions('ws', block(), questionPost())).toEqual({
      posted: 0,
      skipped: 0,
      failed: 1,
    })
  })

  it('still posts through an OUT-OF-BAND source when the connection read fails', async () => {
    // GitHub Issues and GitLab Issues authenticate through the workspace's VCS installation and
    // only ever read the tracker row for the inbound reply secret. Treating an unreadable row as
    // one fact for every source made a rotated `TASKS_ENCRYPTION_KEY` or a transient DB blip take
    // the PR notice, the close-on-merge, the pickup claim and the question echo away from them
    // too. The adapter's own declaration is what keeps the two apart.
    const { svc, recorded } = serviceWith(
      {
        trackerSettingsRepository: fakeTrackerSettings(
          settings({ writebackQuestionsOnPark: true }),
        ),
        taskRepository: fakeTasks([githubIssue('acme/web#3')]),
        reviewQuestionPostRepository: fakeMarkers(),
        taskConnectionStore: fakeConnections({ throws: true }),
      },
      recordingSource('github', { authenticates: 'out-of-band' }),
    )
    expect(await svc.postReviewQuestions('ws', block(), questionPost())).toEqual({
      posted: 1,
      skipped: 0,
      failed: 0,
    })
    // What the unreadable row actually carried is still WITHHELD: the reply grammar is a promise
    // about a channel this deployment could not confirm, and telling a reporter to answer where
    // nothing listens is the failure the resolution exists to prevent.
    expect(recorded.comments[0]!.body).not.toContain('@cat-factory')
  })

  it('keeps a HEALTHY source wired when a different one is unreadable', async () => {
    // The other half of the rule above, and the one a batch-wide catch got wrong: unreadable is a
    // fact about the source that was unreadable. A corrupt Linear envelope is no evidence about
    // the workspace's GitHub connection, so folding them together silently took a working reply
    // channel away from a healthy ticket.
    const body = await postWith(fakeConnections({ webhookSecret: 'whsec', unreadable: ['linear'] }))
    expect(body).toContain('@cat-factory answer <id>')
  })

  it('reads the connections ONCE for the whole block, not once per linked issue', async () => {
    // A block can carry several issues on one tracker; the reply channel is a property of the
    // `(workspace, source)` connection, and each read opens a credential bag, which on a
    // mothership-mode node is a round trip.
    let reads = 0
    const counting: TaskConnectionStore = {
      ...fakeConnections({ webhookSecret: 'whsec' }),
      listBySources: async (_ws, sources) => {
        reads += 1
        return sources.map((source) => ({
          source,
          status: 'opened' as const,
          connection: {
            workspaceId: 'ws',
            source,
            credentials: { webhookSecret: 'whsec' },
            label: source,
            createdAt: 0,
            deletedAt: null,
          },
        }))
      },
    }
    const { svc } = serviceWith({
      trackerSettingsRepository: fakeTrackerSettings(settings({ writebackQuestionsOnPark: true })),
      taskRepository: fakeTasks([
        githubIssue('acme/web#3'),
        githubIssue('acme/web#4'),
        githubIssue('acme/web#5'),
      ]),
      reviewQuestionPostRepository: fakeMarkers(),
      taskConnectionStore: counting,
    })
    expect(await svc.postReviewQuestions('ws', block(), questionPost())).toEqual({
      posted: 3,
      skipped: 0,
      failed: 0,
    })
    expect(reads).toBe(1)
  })
})
