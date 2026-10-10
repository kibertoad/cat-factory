import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { TaskSearchRepoScope, TaskSourceKind, TaskSourceProvider } from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import type { TasksModule } from '@cat-factory/orchestration'
import { taskSourceController } from './TaskSourceController.js'
import { handleError } from '../../http/errorHandler.js'
import type { AppEnv, ServerContainer } from '../../http/env.js'

// The search route resolves the repo scope a source's `search` will be handed, and it is the ONLY
// place that decision is made: a repo-backed provider REFUSES a null scope, so a source the
// controller declines to resolve for cannot be searched at all, however correct the provider is.
// That seam is invisible from either side on its own (the provider's own tests pass a scope
// directly, and the controller's resolution is a `void` side effect on an argument), which is
// exactly why it is asserted here, against what the REGISTRY declares rather than a source list.

/** A provider stub carrying only what the controller reads: whether the source is repo-backed. */
function provider(kind: TaskSourceKind, repoBacked: boolean): TaskSourceProvider {
  return {
    kind,
    ...(repoBacked ? { repoScope: { matches: () => true } } : {}),
  } as TaskSourceProvider
}

const PROVIDERS: TaskSourceProvider[] = [
  provider('github', true),
  provider('gitlab', true),
  provider('jira', false),
]

/**
 * Mount the controller over a container whose repo resolution answers for `linkedBlock` only,
 * capturing the scope each search was handed. `handleError` is mounted because a refusal here is
 * a thrown `DomainError`; without it every refusal would read as a 500.
 */
function harness(opts: { linkedBlock?: string } = {}) {
  const calls: { source: TaskSourceKind; scope: TaskSearchRepoScope | null }[] = []
  const tasks = {
    registry: {
      get: (kind: TaskSourceKind) => PROVIDERS.find((p) => p.kind === kind),
      list: () => PROVIDERS,
    },
    importService: {
      async search(
        _workspaceId: string,
        source: TaskSourceKind,
        _query: string,
        scope: TaskSearchRepoScope | null,
      ) {
        calls.push({ source, scope })
        return []
      },
    },
  } as unknown as TasksModule

  const container = {
    tasks,
    resolveRepoTarget: async (_workspaceId: string, blockId: string) => {
      if (blockId !== opts.linkedBlock) {
        // Exactly what the real resolver raises for a block under no repo-linked service.
        throw new ValidationError('Block is not under a repo-linked service')
      }
      return { owner: 'acme/platform', name: 'web' }
    },
  } as unknown as ServerContainer

  const app = new Hono<AppEnv>()
  app.onError(handleError)
  app.use('*', async (c, next) => {
    c.set('container', container)
    await next()
  })
  app.route('/workspaces/:workspaceId', taskSourceController())

  async function search(source: string, blockId: string) {
    const res = await app.request(`/workspaces/ws-1/task-sources/${source}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'crash on save', blockId }),
    })
    return { status: res.status, body: await res.json() }
  }

  return { search, calls }
}

describe('task search scope resolution', () => {
  it('resolves the block repo for EVERY repo-backed source, not just GitHub', async () => {
    const { search, calls } = harness({ linkedBlock: 'blk-1' })

    expect((await search('github', 'blk-1')).status).toBe(200)
    expect((await search('gitlab', 'blk-1')).status).toBe(200)

    // A null scope here is what makes a repo-backed provider refuse the search outright.
    expect(calls).toEqual([
      { source: 'github', scope: { owner: 'acme/platform', repo: 'web' } },
      { source: 'gitlab', scope: { owner: 'acme/platform', repo: 'web' } },
    ])
  })

  it('hands a repo-less source an explicit null without resolving anything', async () => {
    // `blk-nowhere` has no repo link, so a resolution attempt would refuse the request. Jira
    // declares no `repoScope`, so there is nothing to resolve and the search runs.
    const { search, calls } = harness({ linkedBlock: 'blk-1' })

    expect((await search('jira', 'blk-nowhere')).status).toBe(200)
    expect(calls).toEqual([{ source: 'jira', scope: null }])
  })

  it('refuses a repo-backed search from an unlinked service, naming no vendor', async () => {
    const { search, calls } = harness({ linkedBlock: 'blk-1' })

    const { status, body } = await search('gitlab', 'blk-nowhere')

    expect(status).toBe(422)
    expect(body.error.details.reason).toBe('repo_not_linked')
    // The missing link is the board's service→repo link; naming GitHub would send a GitLab
    // deployment to an integration it does not run.
    expect(body.error.message).not.toMatch(/GitHub/i)
    expect(calls).toEqual([])
  })

  it('leaves an unregistered source to the service, which owns the registration refusal', async () => {
    const { search, calls } = harness({ linkedBlock: 'blk-1' })

    expect((await search('acme:servicenow', 'blk-nowhere')).status).toBe(200)
    expect(calls).toEqual([{ source: 'acme:servicenow', scope: null }])
  })
})
