import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { TaskSourceKind, TaskSourceProvider } from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import type { TasksModule } from '@cat-factory/orchestration'
import { bugHuntController } from './BugHuntController.js'
import { handleError } from '../../http/errorHandler.js'
import type { AppEnv, ServerContainer } from '../../http/env.js'

// WHAT a hunt scans is decided in the controller, and it is the only place that decision is made:
// the service below it takes a board that is already resolved, so a hunt scoped wrongly here is a
// scan of somebody else's repository that nothing downstream can tell apart from an intended one.
//
// The seam is invisible from either side alone (the service sees a plain board string; the repo
// resolver sees a block id), which is why it is asserted here, and against what the REGISTRY
// declares repo-backed, never a source id listed in the test.

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
 * capturing the board each hunt was handed. `handleError` is mounted because a refusal here is a
 * thrown `DomainError`; without it every refusal would read as a 500.
 */
function harness(opts: { linkedBlock?: string } = {}) {
  const scans: { source: TaskSourceKind; board: string }[] = []
  const resolved: string[] = []
  const tasks = {
    registry: {
      get: (kind: TaskSourceKind) => PROVIDERS.find((p) => p.kind === kind),
      list: () => PROVIDERS,
    },
    bugHuntService: {
      // The real guard, byte for byte: an unregistered source is refused here rather than by
      // whatever the board question would otherwise have made of it.
      requireProvider(source: TaskSourceKind) {
        const found = PROVIDERS.find((p) => p.kind === source)
        if (!found) {
          throw new ValidationError(
            `The '${source}' source cannot back a bug hunt on this deployment.`,
          )
        }
        return found
      },
      async hunt(_workspaceId: string, source: TaskSourceKind, input: { board: string }) {
        scans.push({ source, board: input.board })
        return { source, board: input.board, candidates: [], scanned: 0, truncated: false }
      },
    },
  } as unknown as TasksModule

  const container = {
    tasks,
    resolveRepoTarget: async (_workspaceId: string, blockId: string) => {
      resolved.push(blockId)
      if (blockId !== opts.linkedBlock) {
        // Exactly what the real resolver raises for a block under no repo-linked service.
        throw new ValidationError('Block is not under a repo-linked service')
      }
      return { owner: 'acme', name: 'web' }
    },
  } as unknown as ServerContainer

  const app = new Hono<AppEnv>()
  app.onError(handleError)
  app.use('*', async (c, next) => {
    c.set('container', container)
    await next()
  })
  app.route('/workspaces/:workspaceId', bugHuntController())

  async function hunt(source: string, body: Record<string, unknown>) {
    const res = await app.request(`/workspaces/ws-1/bug-hunt/${source}/hunts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() }
  }

  return { hunt, scans, resolved }
}

describe('bug hunt board scope', () => {
  it('hunts the service repo for EVERY repo-backed source, not just GitHub', async () => {
    const { hunt, scans } = harness({ linkedBlock: 'blk-1' })

    expect((await hunt('github', { containerId: 'blk-1', board: null })).status).toBe(200)
    expect((await hunt('gitlab', { containerId: 'blk-1', board: null })).status).toBe(200)

    // `owner/name`, the slug both vendors' board legs are split back out of.
    expect(scans).toEqual([
      { source: 'github', board: 'acme/web' },
      { source: 'gitlab', board: 'acme/web' },
    ])
  })

  it('refuses a board NAMED for a repo-backed source rather than scanning somewhere else', async () => {
    const { hunt, scans, resolved } = harness({ linkedBlock: 'blk-1' })

    const { status, body } = await hunt('github', {
      containerId: 'blk-1',
      board: 'someone-else/web',
    })

    expect(status).toBe(422)
    expect(body.error.details.reason).toBe('board_from_service')
    expect(scans).toEqual([])
    // Decidable from the body alone, so it lands BEFORE the repository read. Resolving first
    // would answer a stale client sitting on an unlinked service with "link a repo", send them
    // to fix that, and only then tell them the board they named was never allowed.
    expect(resolved).toEqual([])
  })

  it('refuses a source this deployment cannot hunt, rather than asking it for a board', async () => {
    // The board question is answered off the provider's own declaration, so an unregistered or
    // unwired source has no answer to give: it must reach the refusal that names the missing
    // capability, not `missing_board`, whose fix ("pick a board") is impossible on a surface that
    // renders no board control for it.
    const { hunt, scans, resolved } = harness({ linkedBlock: 'blk-1' })

    const { status, body } = await hunt('acme:servicenow', { containerId: 'blk-1', board: null })

    expect(status).toBe(422)
    expect(body.error.details?.reason).toBeUndefined()
    expect(body.error.message).toContain('cannot back a bug hunt')
    expect(scans).toEqual([])
    expect(resolved).toEqual([])
  })

  it('refuses a repo-backed hunt from a service with no repository linked', async () => {
    const { hunt, scans } = harness({ linkedBlock: 'blk-1' })

    const { status, body } = await hunt('gitlab', { containerId: 'blk-nowhere', board: null })

    expect(status).toBe(422)
    expect(body.error.details.reason).toBe('repo_not_linked')
    // The missing link is the board's service→repo link; naming GitHub would send a GitLab
    // deployment to an integration it does not run.
    expect(body.error.message).not.toMatch(/GitHub/i)
    expect(scans).toEqual([])
  })

  it('scans the named board for a repo-less source, resolving no repository at all', async () => {
    // `blk-nowhere` has no repo link, so a resolution attempt would refuse the request. Jira
    // declares no `repoScope`, so there is nothing to resolve and the hunt runs.
    const { hunt, scans } = harness({ linkedBlock: 'blk-1' })

    expect((await hunt('jira', { containerId: 'blk-nowhere', board: 'PROJ' })).status).toBe(200)
    expect(scans).toEqual([{ source: 'jira', board: 'PROJ' }])
  })

  it('refuses a repo-less hunt that named no board, rather than scanning unscoped', async () => {
    const { hunt, scans } = harness({ linkedBlock: 'blk-1' })

    const { status, body } = await hunt('jira', { containerId: 'blk-1', board: null })

    expect(status).toBe(422)
    expect(body.error.details.reason).toBe('missing_board')
    expect(scans).toEqual([])
  })
})
