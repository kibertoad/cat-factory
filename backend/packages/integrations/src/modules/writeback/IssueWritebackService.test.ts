import { describe, expect, it } from 'vitest'
import type {
  Block,
  PullRequestRef,
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
    getByUrl: async () => null,
    listByWorkspace: async () => issues,
    listByBlock: async () => issues,
    linkBlock: async () => {},
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
