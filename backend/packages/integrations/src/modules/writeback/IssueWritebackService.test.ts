import { describe, expect, it } from 'vitest'
import { REVIEW_QUESTION_POST_CLAIM_TTL_MS } from '@cat-factory/kernel'
import type {
  Block,
  PullRequestRef,
  ReviewQuestionPost,
  ReviewQuestionPostKey,
  ReviewQuestionPostRecord,
  ReviewQuestionPostRepository,
  TaskRecord,
  TrackerSettings,
  TrackerSettingsRepository,
  TaskRepository,
} from '@cat-factory/kernel'
import { IssueWritebackService } from './IssueWritebackService.js'

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
    put: async () => {},
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

describe('IssueWritebackService — flag gating', () => {
  it('does nothing when the workspace flag is off and no override is set', async () => {
    const comments: string[] = []
    const svc = new IssueWritebackService({
      trackerSettingsRepository: fakeTrackerSettings(settings()),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
      commentOnGitHubIssue: async (_ws, _id, body) => void comments.push(body),
    })
    await svc.onPullRequestOpened('ws', block(), PR)
    expect(comments).toHaveLength(0)
  })

  it('comments on PR open when the workspace flag is on', async () => {
    const comments: { externalId: string; body: string }[] = []
    const svc = new IssueWritebackService({
      trackerSettingsRepository: fakeTrackerSettings(settings({ writebackCommentOnPrOpen: true })),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
      commentOnGitHubIssue: async (_ws, externalId, body) =>
        void comments.push({ externalId, body }),
    })
    await svc.onPullRequestOpened('ws', block(), PR)
    expect(comments).toHaveLength(1)
    expect(comments[0]!.externalId).toBe('acme/web#3')
    expect(comments[0]!.body).toContain(PR.url)
  })

  it('per-task override off beats a workspace on', async () => {
    const comments: string[] = []
    const svc = new IssueWritebackService({
      trackerSettingsRepository: fakeTrackerSettings(settings({ writebackCommentOnPrOpen: true })),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
      commentOnGitHubIssue: async (_ws, _id, body) => void comments.push(body),
    })
    await svc.onPullRequestOpened('ws', block({ trackerCommentOnPrOpen: 'off' }), PR)
    expect(comments).toHaveLength(0)
  })

  it('per-task override on beats a workspace off', async () => {
    const comments: string[] = []
    const svc = new IssueWritebackService({
      trackerSettingsRepository: fakeTrackerSettings(settings()),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
      commentOnGitHubIssue: async (_ws, _id, body) => void comments.push(body),
    })
    await svc.onPullRequestOpened('ws', block({ trackerCommentOnPrOpen: 'on' }), PR)
    expect(comments).toHaveLength(1)
  })
})

describe('IssueWritebackService — merge writeback', () => {
  it('comments + closes the GitHub issue on merge when resolveOnMerge is on', async () => {
    const comments: string[] = []
    const closed: string[] = []
    const svc = new IssueWritebackService({
      trackerSettingsRepository: fakeTrackerSettings(settings({ writebackResolveOnMerge: true })),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
      commentOnGitHubIssue: async (_ws, _id, body) => void comments.push(body),
      closeGitHubIssue: async (_ws, externalId) => void closed.push(externalId),
    })
    await svc.onPullRequestMerged('ws', block(), PR)
    expect(comments).toHaveLength(1)
    expect(closed).toEqual(['acme/web#3'])
  })

  it('does not close on PR open', async () => {
    const closed: string[] = []
    const svc = new IssueWritebackService({
      trackerSettingsRepository: fakeTrackerSettings(
        settings({ writebackCommentOnPrOpen: true, writebackResolveOnMerge: true }),
      ),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
      commentOnGitHubIssue: async () => {},
      closeGitHubIssue: async (_ws, externalId) => void closed.push(externalId),
    })
    await svc.onPullRequestOpened('ws', block(), PR)
    expect(closed).toHaveLength(0)
  })

  it('isolates a failing issue so the others still get written back', async () => {
    const closed: string[] = []
    const svc = new IssueWritebackService({
      trackerSettingsRepository: fakeTrackerSettings(settings({ writebackResolveOnMerge: true })),
      taskRepository: fakeTasks([githubIssue('acme/web#1'), githubIssue('acme/web#2')]),
      commentOnGitHubIssue: async (_ws, externalId) => {
        if (externalId === 'acme/web#1') throw new Error('boom')
      },
      closeGitHubIssue: async (_ws, externalId) => void closed.push(externalId),
    })
    await svc.onPullRequestMerged('ws', block(), PR)
    // #1's comment threw (so it never closed); #2 still closed.
    expect(closed).toEqual(['acme/web#2'])
  })
})

describe('IssueWritebackService — Jira dispatch', () => {
  function jiraIssue(): TaskRecord {
    return { ...githubIssue('PROJ-1'), source: 'jira', externalId: 'PROJ-1' }
  }

  it('comments then transitions the Jira issue to a Done-category status on merge', async () => {
    const calls: { method: string; url: string; body: string | undefined }[] = []
    const fetchImpl = async (
      url: string,
      init: { method: string; headers: Record<string, string>; body?: string },
    ) => {
      // Mirror the real `fetch`: a GET/HEAD with ANY non-null body throws. This is
      // what makes the empty-string-body bug surface in production but not in a
      // permissive fake — so assert it here too.
      if ((init.method === 'GET' || init.method === 'HEAD') && init.body != null) {
        throw new TypeError('Request with GET/HEAD method cannot have body.')
      }
      calls.push({ method: init.method, url, body: init.body })
      if (url.endsWith('/transitions') && init.method === 'GET') {
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({
            transitions: [
              { id: '11', to: { statusCategory: { key: 'indeterminate' } } },
              { id: '31', to: { statusCategory: { key: 'done' } } },
            ],
          }),
        }
      }
      return { ok: true, status: 204, text: async () => '', json: async () => null }
    }
    const svc = new IssueWritebackService({
      trackerSettingsRepository: fakeTrackerSettings(settings({ writebackResolveOnMerge: true })),
      taskRepository: fakeTasks([jiraIssue()]),
      resolveJiraConnection: async () => ({
        baseUrl: 'https://acme.atlassian.net',
        accountEmail: 'a@b.c',
        apiToken: 'tok',
      }),
      fetchImpl,
    })
    await svc.onPullRequestMerged('ws', block(), PR)
    const comment = calls.find((c) => c.url.endsWith('/comment'))
    const getTransitions = calls.find((c) => c.url.endsWith('/transitions') && c.method === 'GET')
    const postTransition = calls.find((c) => c.url.endsWith('/transitions') && c.method === 'POST')
    expect(comment).toBeDefined()
    expect(getTransitions).toBeDefined()
    // The GET must carry no body (a real `fetch` throws otherwise).
    expect(getTransitions!.body).toBeUndefined()
    expect(postTransition).toBeDefined()
    expect(postTransition!.body).toContain('"id":"31"')
  })
})

describe('IssueWritebackService — Linear dispatch', () => {
  function linearIssue(): TaskRecord {
    return { ...githubIssue('ENG-1'), source: 'linear', externalId: 'ENG-1' }
  }

  it('looks up the issue UUID + completed state, then comments and transitions on merge', async () => {
    const operations: string[] = []
    const fetchImpl = async (
      _url: string,
      init: { method: string; headers: Record<string, string>; body?: string },
    ) => {
      const body = JSON.parse(init.body ?? '{}') as {
        query: string
        variables: Record<string, unknown>
      }
      if (body.query.includes('IssueResolveLookup')) {
        operations.push('resolve-lookup')
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({
            data: {
              issue: {
                id: 'uuid-1',
                team: { states: { nodes: [{ id: 'st-done', type: 'completed' }] } },
              },
            },
          }),
        }
      }
      if (body.query.includes('IssueId')) {
        operations.push('id-lookup')
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({ data: { issue: { id: 'uuid-1' } } }),
        }
      }
      if (body.query.includes('CommentCreate')) {
        operations.push('comment')
        expect((body.variables.input as { issueId: string }).issueId).toBe('uuid-1')
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({ data: { commentCreate: { success: true } } }),
        }
      }
      if (body.query.includes('IssueUpdate')) {
        operations.push('update')
        expect((body.variables.input as { stateId: string }).stateId).toBe('st-done')
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({ data: { issueUpdate: { success: true } } }),
        }
      }
      throw new Error(`unexpected query: ${body.query}`)
    }
    const svc = new IssueWritebackService({
      trackerSettingsRepository: fakeTrackerSettings(settings({ writebackResolveOnMerge: true })),
      taskRepository: fakeTasks([linearIssue()]),
      resolveLinearConnection: async () => ({ apiKey: 'lin_api_x' }),
      fetchImpl,
    })
    await svc.onPullRequestMerged('ws', block(), PR)
    expect(operations).toContain('comment')
    expect(operations).toContain('update')
  })

  it('marks the Linear issue in-progress (started state) on pickup', async () => {
    const operations: string[] = []
    const fetchImpl = async (
      _url: string,
      init: { method: string; headers: Record<string, string>; body?: string },
    ) => {
      const body = JSON.parse(init.body ?? '{}') as {
        query: string
        variables: Record<string, unknown>
      }
      if (body.query.includes('IssueResolveLookup')) {
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({
            data: {
              issue: {
                id: 'uuid-1',
                team: {
                  states: {
                    nodes: [
                      { id: 'st-progress', type: 'started' },
                      { id: 'st-done', type: 'completed' },
                    ],
                  },
                },
              },
            },
          }),
        }
      }
      if (body.query.includes('IssueId')) {
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({ data: { issue: { id: 'uuid-1' } } }),
        }
      }
      if (body.query.includes('CommentCreate')) {
        operations.push('comment')
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({ data: { commentCreate: { success: true } } }),
        }
      }
      if (body.query.includes('IssueUpdate')) {
        operations.push('update')
        expect((body.variables.input as { stateId: string }).stateId).toBe('st-progress')
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({ data: { issueUpdate: { success: true } } }),
        }
      }
      throw new Error(`unexpected query: ${body.query}`)
    }
    const svc = new IssueWritebackService({
      trackerSettingsRepository: fakeTrackerSettings(settings()),
      taskRepository: fakeTasks([linearIssue()]),
      resolveLinearConnection: async () => ({ apiKey: 'lin_api_x' }),
      fetchImpl,
    })
    await svc.onIssuePickedUp('ws', 'blk_1', { runUrl: 'https://app.example.test/run/1' })
    expect(operations).toEqual(['comment', 'update'])
  })

  it('passes through when no Linear connection is wired', async () => {
    let called = false
    const svc = new IssueWritebackService({
      trackerSettingsRepository: fakeTrackerSettings(settings({ writebackCommentOnPrOpen: true })),
      taskRepository: fakeTasks([linearIssue()]),
      // no resolveLinearConnection / fetchImpl → linearRequest returns null
      fetchImpl: async () => {
        called = true
        return { ok: true, status: 200, text: async () => '', json: async () => ({}) }
      },
    })
    await svc.onPullRequestOpened('ws', block(), PR)
    expect(called).toBe(false)
  })
})

describe('IssueWritebackService — issue pickup (bug intake)', () => {
  it('comments with the run link and applies the in-progress label to a GitHub issue', async () => {
    const comments: { externalId: string; body: string }[] = []
    const labels: { externalId: string; label: string }[] = []
    const svc = new IssueWritebackService({
      // Both writeback flags OFF: pickup is intake semantics, not settings-gated.
      trackerSettingsRepository: fakeTrackerSettings(settings()),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
      commentOnGitHubIssue: async (_ws, externalId, body) =>
        void comments.push({ externalId, body }),
      labelGitHubIssue: async (_ws, externalId, label) => void labels.push({ externalId, label }),
    })
    await svc.onIssuePickedUp('ws', 'blk_1', {
      runUrl: 'https://app.example.test/run/1',
      inProgressLabel: 'bot-working',
    })
    expect(comments).toHaveLength(1)
    expect(comments[0]!.body).toContain('https://app.example.test/run/1')
    expect(labels).toEqual([{ externalId: 'acme/web#3', label: 'bot-working' }])
  })

  it('defaults the GitHub label to in-progress when the schedule names none', async () => {
    const labels: string[] = []
    const svc = new IssueWritebackService({
      trackerSettingsRepository: fakeTrackerSettings(settings()),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
      commentOnGitHubIssue: async () => {},
      labelGitHubIssue: async (_ws, _id, label) => void labels.push(label),
    })
    await svc.onIssuePickedUp('ws', 'blk_1', {})
    expect(labels).toEqual(['in-progress'])
  })

  it('echoes clarification questions as a comment on the linked issue (best-effort, not gated)', async () => {
    const comments: string[] = []
    const svc = new IssueWritebackService({
      // Both writeback flags OFF: echoing the ask is intake semantics, not settings-gated.
      trackerSettingsRepository: fakeTrackerSettings(settings()),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
      commentOnGitHubIssue: async (_ws, _id, body) => void comments.push(body),
    })
    await svc.postQuestions('ws', 'blk_1', ['  ', 'What are the repro steps?', 'Which browser?'])
    expect(comments).toHaveLength(1)
    // Blank questions are dropped; the rest render as a markdown list.
    expect(comments[0]!).toContain('- What are the repro steps?')
    expect(comments[0]!).toContain('- Which browser?')
  })

  it('posts nothing when there are no non-blank questions or no linked issue', async () => {
    const comments: string[] = []
    const deps = {
      trackerSettingsRepository: fakeTrackerSettings(settings()),
      commentOnGitHubIssue: async (_ws: string, _id: string, body: string) =>
        void comments.push(body),
    }
    const withIssue = new IssueWritebackService({
      ...deps,
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
    })
    await withIssue.postQuestions('ws', 'blk_1', ['   ', ''])
    const noIssue = new IssueWritebackService({ ...deps, taskRepository: fakeTasks([]) })
    await noIssue.postQuestions('ws', 'blk_1', ['A real question?'])
    expect(comments).toHaveLength(0)
  })

  it('transitions a Jira issue into the In Progress (indeterminate) category', async () => {
    const calls: { method: string; url: string; body: string | undefined }[] = []
    const fetchImpl = async (
      url: string,
      init: { method: string; headers: Record<string, string>; body?: string },
    ) => {
      calls.push({ method: init.method, url, body: init.body })
      if (url.endsWith('/transitions') && init.method === 'GET') {
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({
            transitions: [
              { id: '11', to: { statusCategory: { key: 'indeterminate' } } },
              { id: '31', to: { statusCategory: { key: 'done' } } },
            ],
          }),
        }
      }
      return { ok: true, status: 204, text: async () => '', json: async () => null }
    }
    const svc = new IssueWritebackService({
      trackerSettingsRepository: fakeTrackerSettings(settings()),
      taskRepository: fakeTasks([{ ...githubIssue('PROJ-1'), source: 'jira' }]),
      resolveJiraConnection: async () => ({
        baseUrl: 'https://acme.atlassian.net',
        accountEmail: 'a@b.c',
        apiToken: 'tok',
      }),
      fetchImpl,
    })
    await svc.onIssuePickedUp('ws', 'blk_1', {})
    const postTransition = calls.find((c) => c.url.endsWith('/transitions') && c.method === 'POST')
    expect(postTransition).toBeDefined()
    // The pickup mark lands in In Progress, NOT the resolve (Done) transition.
    expect(postTransition!.body).toContain('"id":"11"')
    expect(calls.find((c) => c.url.endsWith('/comment'))).toBeDefined()
  })

  it('isolates a failing issue so the others are still marked', async () => {
    const labels: string[] = []
    const svc = new IssueWritebackService({
      trackerSettingsRepository: fakeTrackerSettings(settings()),
      taskRepository: fakeTasks([githubIssue('acme/web#1'), githubIssue('acme/web#2')]),
      commentOnGitHubIssue: async (_ws, externalId) => {
        if (externalId === 'acme/web#1') throw new Error('boom')
      },
      labelGitHubIssue: async (_ws, externalId) => void labels.push(externalId),
    })
    await svc.onIssuePickedUp('ws', 'blk_1', {})
    expect(labels).toEqual(['acme/web#2'])
  })

  it('does nothing when the block has no linked issue', async () => {
    const comments: string[] = []
    const svc = new IssueWritebackService({
      trackerSettingsRepository: fakeTrackerSettings(settings()),
      taskRepository: fakeTasks([]),
      commentOnGitHubIssue: async (_ws, _id, body) => void comments.push(body),
    })
    await svc.onIssuePickedUp('ws', 'blk_1', {})
    expect(comments).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// postReviewQuestions — the headless clarification loop's question echo (slice 2a of
// docs/initiatives/headless-clarification-loop.md). The engine has already established that
// the run is headless and the review has open findings; what is asserted here is the
// provider's half: the workspace opt-in, and the idempotency that keeps a REPLAYING durable
// driver from re-posting the same questions onto an issue a human is reading.
// ---------------------------------------------------------------------------

/** The marker key every case below reads back — the one linked issue of `block()`. */
function markerKey(): ReviewQuestionPostKey {
  return { workspaceId: 'ws', reviewId: 'rr_1', iteration: 1, issueRef: 'github:acme/web#3' }
}

function questionPost(over: Partial<ReviewQuestionPost> = {}): ReviewQuestionPost {
  return {
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
    const comments: string[] = []
    const svc = new IssueWritebackService({
      trackerSettingsRepository: fakeTrackerSettings(settings({ writebackQuestionsOnPark: true })),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
      reviewQuestionPostRepository: fakeMarkers(),
      commentOnGitHubIssue: async (_ws, _id, body) => void comments.push(body),
    })
    const outcome = await svc.postReviewQuestions('ws', block(), questionPost())
    expect(outcome).toEqual({ posted: 1, skipped: 0, failed: 0 })
    expect(comments[0]).toContain('`itm_1`')
  })

  it('stays off by default — the loop is opt-in per workspace', async () => {
    const comments: string[] = []
    const svc = new IssueWritebackService({
      trackerSettingsRepository: fakeTrackerSettings(settings()),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
      reviewQuestionPostRepository: fakeMarkers(),
      commentOnGitHubIssue: async (_ws, _id, body) => void comments.push(body),
    })
    expect(await svc.postReviewQuestions('ws', block(), questionPost())).toEqual({
      posted: 0,
      skipped: 0,
      failed: 0,
    })
    expect(comments).toEqual([])
  })

  it('honours the per-task override in both directions', async () => {
    const on: string[] = []
    const onSvc = new IssueWritebackService({
      trackerSettingsRepository: fakeTrackerSettings(settings()),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
      reviewQuestionPostRepository: fakeMarkers(),
      commentOnGitHubIssue: async (_ws, _id, body) => void on.push(body),
    })
    await onSvc.postReviewQuestions('ws', block({ trackerQuestionsOnPark: 'on' }), questionPost())
    expect(on).toHaveLength(1)

    const off: string[] = []
    const offSvc = new IssueWritebackService({
      trackerSettingsRepository: fakeTrackerSettings(settings({ writebackQuestionsOnPark: true })),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
      reviewQuestionPostRepository: fakeMarkers(),
      commentOnGitHubIssue: async (_ws, _id, body) => void off.push(body),
    })
    await offSvc.postReviewQuestions('ws', block({ trackerQuestionsOnPark: 'off' }), questionPost())
    expect(off).toEqual([])
  })

  it('posts ONCE across driver replays, and again on the next reviewer pass', async () => {
    const comments: string[] = []
    const markers = fakeMarkers()
    const svc = new IssueWritebackService({
      trackerSettingsRepository: fakeTrackerSettings(settings({ writebackQuestionsOnPark: true })),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
      reviewQuestionPostRepository: markers,
      commentOnGitHubIssue: async (_ws, _id, body) => void comments.push(body),
    })
    await svc.postReviewQuestions('ws', block(), questionPost())
    const replay = await svc.postReviewQuestions('ws', block(), questionPost())
    expect(replay).toEqual({ posted: 0, skipped: 1, failed: 0 })
    expect(comments).toHaveLength(1)

    // A re-review bumps the iteration, which is part of the key — new findings DO get asked.
    await svc.postReviewQuestions('ws', block(), questionPost({ iteration: 2 }))
    expect(comments).toHaveLength(2)
  })

  it('records a failed post and RETRIES it on the next replay', async () => {
    let fail = true
    const comments: string[] = []
    const markers = fakeMarkers()
    const svc = new IssueWritebackService({
      trackerSettingsRepository: fakeTrackerSettings(settings({ writebackQuestionsOnPark: true })),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
      reviewQuestionPostRepository: markers,
      commentOnGitHubIssue: async (_ws, _id, body) => {
        if (fail) throw new Error('tracker down')
        comments.push(body)
      },
    })
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
    expect(comments).toHaveLength(1)
  })

  it('passes through with no marker store — posting unguarded would spam on every replay', async () => {
    const comments: string[] = []
    const svc = new IssueWritebackService({
      trackerSettingsRepository: fakeTrackerSettings(settings({ writebackQuestionsOnPark: true })),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
      commentOnGitHubIssue: async (_ws, _id, body) => void comments.push(body),
    })
    expect(await svc.postReviewQuestions('ws', block(), questionPost())).toEqual({
      posted: 0,
      skipped: 0,
      failed: 0,
    })
    expect(comments).toEqual([])
  })

  it('does not mark an unwired transport as posted — wiring it later must still deliver', async () => {
    const markers = fakeMarkers()
    const svc = new IssueWritebackService({
      trackerSettingsRepository: fakeTrackerSettings(settings({ writebackQuestionsOnPark: true })),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
      reviewQuestionPostRepository: markers,
      // No commentOnGitHubIssue seam.
    })
    expect(await svc.postReviewQuestions('ws', block(), questionPost())).toEqual({
      posted: 0,
      skipped: 0,
      failed: 1,
    })
    const marker = await markers.get(markerKey())
    expect(marker?.status).toBe('failed')
  })

  it('does not mark an UNRESOLVED target as posted — reconnecting the App must still deliver', async () => {
    // The facade seams throw when they cannot resolve the issue (a workspace whose installation
    // is gone). Recording that as `posted` would mute this iteration permanently.
    const markers = fakeMarkers()
    const svc = new IssueWritebackService({
      trackerSettingsRepository: fakeTrackerSettings(settings({ writebackQuestionsOnPark: true })),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
      reviewQuestionPostRepository: markers,
      commentOnGitHubIssue: async () => {
        throw new Error('Cannot resolve GitHub issue acme/web#3 for this workspace')
      },
    })
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
    const svc = new IssueWritebackService({
      trackerSettingsRepository: fakeTrackerSettings(settings({ writebackQuestionsOnPark: true })),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
      reviewQuestionPostRepository: markers,
      commentOnGitHubIssue: async () => {
        throw new Error('POST failed: authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123')
      },
    })
    await svc.postReviewQuestions('ws', block(), questionPost())
    const marker = await markers.get(markerKey())
    expect(marker?.error).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123')
    expect(marker?.error).toContain('[REDACTED]')
  })

  it('re-posts after a claim was ABANDONED mid-post, but not while one is in flight', async () => {
    // A poster killed between the claim and the comment (an evicted isolate, a killed durable
    // step) leaves a `pending` row nobody will settle. Without the takeover window that row is
    // terminal in practice: the questions never arrive AND nothing retries.
    const comments: string[] = []
    const markers = fakeMarkers()
    let now = 10 * REVIEW_QUESTION_POST_CLAIM_TTL_MS
    const svc = new IssueWritebackService({
      trackerSettingsRepository: fakeTrackerSettings(settings({ writebackQuestionsOnPark: true })),
      taskRepository: fakeTasks([githubIssue('acme/web#3')]),
      reviewQuestionPostRepository: markers,
      clock: { now: () => now },
      commentOnGitHubIssue: async (_ws, _id, body) => void comments.push(body),
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
    expect(comments).toEqual([])

    // Past the window the claim is abandoned, so the next replay takes it over and delivers.
    now += 1
    expect(await svc.postReviewQuestions('ws', block(), questionPost())).toEqual({
      posted: 1,
      skipped: 0,
      failed: 0,
    })
    expect(comments).toHaveLength(1)
    expect((await markers.get(markerKey()))?.status).toBe('posted')
  })
})
