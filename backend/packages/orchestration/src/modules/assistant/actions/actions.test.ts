import { UNATTRIBUTED_BLOCK_EDIT_AUTHORITY } from '@cat-factory/contracts'
import type {
  AddServiceFromRepoInput,
  Block,
  GitHubRepo,
  UpdateBlockInput,
} from '@cat-factory/contracts'
import type { Service } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { AssistantActionContext } from '../types.js'
import { createAssistantActions } from './index.js'
import type { AssistantActionDeps, AssistantIssueMatch } from './deps.js'

// What this covers: the platform half of a turn, everything the model does NOT decide.
//
// Each action resolves the names the model copied against real board state, and the assertions
// below are mostly about the cases where that resolution FAILS: an unknown or ambiguous service, a
// repository the workspace has not connected, an issue URL no tracker claims or two do. Those are
// the answers a turn gives instead of acting, and getting one of them wrong is how an assistant
// silently does something to the wrong service.

function frame(id: string, title: string, over: Partial<Block> = {}): Block {
  return {
    id,
    title,
    type: 'service',
    description: '',
    position: { x: 0, y: 0 },
    status: 'planned',
    progress: 0,
    dependsOn: [],
    executionId: null,
    level: 'frame',
    parentId: null,
    ...over,
  }
}

function repo(
  githubId: number,
  owner: string,
  name: string,
  over: Partial<GitHubRepo> = {},
): GitHubRepo {
  return {
    githubId,
    installationId: 1,
    owner,
    name,
    defaultBranch: 'main',
    private: false,
    syncedAt: 0,
    ...over,
  }
}

function service(id: string, frameBlockId: string, repoGithubId: number | null): Service {
  return {
    id,
    accountId: 'acc_1',
    frameBlockId,
    installationId: repoGithubId === null ? null : 1,
    repoGithubId,
    createdAt: 0,
  }
}

interface Harness {
  deps: AssistantActionDeps
  patches: { id: string; patch: UpdateBlockInput }[]
  added: AddServiceFromRepoInput[]
  filed: { containerId: string; externalId: string }[]
}

function harness(
  over: {
    blocks?: Block[]
    repos?: GitHubRepo[]
    services?: Service[]
    matches?: AssistantIssueMatch[]
    withRepos?: boolean
    withIssues?: boolean
  } = {},
): Harness {
  const blocks = over.blocks ?? [frame('f1', 'Checkout'), frame('f2', 'Payments')]
  const patches: Harness['patches'] = []
  const added: AddServiceFromRepoInput[] = []
  const filed: Harness['filed'] = []
  const board = {
    listBoardBlocks: async () => blocks,
    updateBlock: async (_ws: string, id: string, patch: UpdateBlockInput) => {
      patches.push({ id, patch })
      const target = blocks.find((b) => b.id === id)!
      return { ...target, ...patch } as Block
    },
  }
  const repos = {
    listRepos: async () => over.repos ?? [repo(10, 'acme', 'payments')],
    addServiceFromRepo: async (_ws: string, input: AddServiceFromRepoInput) => {
      added.push(input)
      return frame('f3', 'payments')
    },
    listServicesForFrames: async () => over.services ?? [],
  }
  const issues = {
    matchIssueSources: async () =>
      over.matches ?? [{ source: 'github', externalId: 'acme/payments#12' }],
    importIssue: async () => ({
      source: 'github' as const,
      externalId: 'acme/payments#12',
      title: 'Card charges time out',
      url: 'https://github.com/acme/payments/issues/12',
      status: 'open',
      type: 'Bug',
      assignee: null,
      priority: null,
      labels: [],
      description: '',
      comments: [],
      excerpt: '',
      linkedBlockId: null,
      syncedAt: 0,
    }),
    createTaskFromIssue: async (input: { containerId: string; externalId: string }) => {
      filed.push({ containerId: input.containerId, externalId: input.externalId })
      return {
        block: frame('t1', 'Card charges time out', { level: 'task', parentId: input.containerId }),
      }
    },
  }
  return {
    patches,
    added,
    filed,
    deps: {
      board,
      ...(over.withRepos === false ? {} : { repos }),
      ...(over.withIssues === false ? {} : { issues }),
    } as unknown as AssistantActionDeps,
  }
}

function context(args: Record<string, string>): AssistantActionContext {
  return {
    workspaceId: 'ws_1',
    arguments: args,
    editor: UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
    userId: 'u_1',
  }
}

function actionOf(deps: AssistantActionDeps, actionId: string) {
  const action = createAssistantActions(deps).find((entry) => entry.actionId === actionId)
  if (!action) throw new Error(`no ${actionId} in the catalog`)
  return action
}

describe('createAssistantActions', () => {
  it('drops an action whose integration the deployment did not wire', () => {
    const catalog = createAssistantActions(harness({ withRepos: false, withIssues: false }).deps)
    expect(catalog.map((a) => a.actionId)).toEqual(['declare-service-dependency'])
  })
})

describe('declare-service-dependency', () => {
  it('stores the edge on the CONSUMER frame', async () => {
    const h = harness()
    const outcome = await actionOf(h.deps, 'declare-service-dependency').run(
      context({ consumer: 'Checkout', provider: 'Payments', description: 'authorises cards' }),
    )
    expect(h.patches).toEqual([
      {
        id: 'f1',
        patch: { serviceConnections: [{ serviceBlockId: 'f2', description: 'authorises cards' }] },
      },
    ])
    expect(outcome).toMatchObject({
      status: 'performed',
      result: { created: true, consumer: { blockId: 'f1' }, provider: { blockId: 'f2' } },
    })
  })

  it('is idempotent: an edge that already exists reports created: false and writes nothing', async () => {
    const h = harness({
      blocks: [
        frame('f1', 'Checkout', { serviceConnections: [{ serviceBlockId: 'f2' }] }),
        frame('f2', 'Payments'),
      ],
    })
    const outcome = await actionOf(h.deps, 'declare-service-dependency').run(
      context({ consumer: 'Checkout', provider: 'Payments' }),
    )
    expect(h.patches).toEqual([])
    expect(outcome).toMatchObject({ status: 'performed', result: { created: false } })
  })

  it('updates the description of an existing edge in place, keeping the others', async () => {
    const h = harness({
      blocks: [
        frame('f1', 'Checkout', {
          serviceConnections: [
            { serviceBlockId: 'f3' },
            { serviceBlockId: 'f2', description: 'old' },
          ],
        }),
        frame('f2', 'Payments'),
        frame('f3', 'Ledger'),
      ],
    })
    await actionOf(h.deps, 'declare-service-dependency').run(
      context({ consumer: 'Checkout', provider: 'Payments', description: 'authorises cards' }),
    )
    expect(h.patches[0]!.patch.serviceConnections).toEqual([
      { serviceBlockId: 'f3' },
      { serviceBlockId: 'f2', description: 'authorises cards' },
    ])
  })

  it('asks which service was meant rather than picking one', async () => {
    const h = harness({ blocks: [frame('f1', 'Payments API'), frame('f2', 'API Gateway')] })
    expect(
      await actionOf(h.deps, 'declare-service-dependency').run(
        context({ consumer: 'api', provider: 'API Gateway' }),
      ),
    ).toEqual({
      status: 'needs_input',
      reason: 'ambiguous_service',
      field: 'consumer',
      candidates: ['Payments API', 'API Gateway'],
    })
    expect(h.patches).toEqual([])
  })

  it('asks for an argument the request never stated', async () => {
    const h = harness()
    expect(
      await actionOf(h.deps, 'declare-service-dependency').run(context({ consumer: 'Checkout' })),
    ).toEqual({
      status: 'needs_input',
      reason: 'missing_argument',
      field: 'provider',
      candidates: [],
    })
  })
})

describe('add-service-from-repo', () => {
  it('resolves a pasted URL to the projected repository and adds the service', async () => {
    const h = harness()
    const outcome = await actionOf(h.deps, 'add-service-from-repo').run(
      context({ repoUrl: 'https://github.com/ACME/Payments' }),
    )
    expect(h.added).toEqual([{ repoGithubId: 10 }])
    expect(outcome).toEqual({
      status: 'performed',
      result: {
        actionId: 'add-service-from-repo',
        service: { blockId: 'f3', title: 'payments' },
        repo: { owner: 'acme', name: 'payments', directory: null },
        created: true,
      },
    })
  })

  it('takes the monorepo subdirectory from a URL that points into the tree', async () => {
    const h = harness({ repos: [repo(10, 'acme', 'monorepo')] })
    await actionOf(h.deps, 'add-service-from-repo').run(
      context({ repoUrl: 'https://github.com/acme/monorepo/tree/main/packages/api' }),
    )
    expect(h.added).toEqual([{ repoGithubId: 10, directory: 'packages/api', isMonorepo: true }])
  })

  it('reports an existing service the board now MOUNTS as created: false', async () => {
    // `addServiceFromRepo` dedupes a whole-repo service across the account and mounts the existing
    // one; a caller told only "here is your service" would read that as a fresh import.
    const h = harness({ blocks: [frame('f3', 'payments')] })
    expect(
      await actionOf(h.deps, 'add-service-from-repo').run(
        context({ repoUrl: 'https://github.com/acme/payments' }),
      ),
    ).toMatchObject({ status: 'performed', result: { created: false } })
  })

  it('names the near-misses when the workspace has not connected that repository', async () => {
    const h = harness({ repos: [repo(10, 'other-org', 'payments')] })
    expect(
      await actionOf(h.deps, 'add-service-from-repo').run(
        context({ repoUrl: 'https://github.com/acme/payments' }),
      ),
    ).toEqual({
      status: 'needs_input',
      reason: 'unknown_repository',
      field: 'repoUrl',
      candidates: ['other-org/payments'],
    })
    expect(h.added).toEqual([])
  })

  it('refuses a value that is not a repository URL at all', async () => {
    const h = harness()
    expect(
      await actionOf(h.deps, 'add-service-from-repo').run(
        context({ repoUrl: 'the payments repo' }),
      ),
    ).toMatchObject({ reason: 'unreadable_repository_url', field: 'repoUrl' })
  })
})

describe('create-task-from-issue', () => {
  it('files the task under the service backed by the issue’s own repository', async () => {
    const h = harness({
      blocks: [frame('f1', 'Checkout'), frame('f2', 'Payments')],
      services: [service('svc_1', 'f2', 10), service('svc_2', 'f1', 11)],
    })
    const outcome = await actionOf(h.deps, 'create-task-from-issue').run(
      context({ issueUrl: 'https://github.com/acme/payments/issues/12' }),
    )
    expect(h.filed).toEqual([{ containerId: 'f2', externalId: 'acme/payments#12' }])
    expect(outcome).toEqual({
      status: 'performed',
      result: {
        actionId: 'create-task-from-issue',
        task: { blockId: 't1', title: 'Card charges time out' },
        service: { blockId: 'f2', title: 'Payments' },
        issue: {
          source: 'github',
          externalId: 'acme/payments#12',
          url: 'https://github.com/acme/payments/issues/12',
        },
      },
    })
  })

  it('prefers the service the request named over the one the repository implies', async () => {
    const h = harness({ services: [service('svc_1', 'f2', 10)] })
    await actionOf(h.deps, 'create-task-from-issue').run(
      context({ issueUrl: 'https://github.com/acme/payments/issues/12', service: 'Checkout' }),
    )
    expect(h.filed).toEqual([{ containerId: 'f1', externalId: 'acme/payments#12' }])
  })

  it('asks which service when the repository backs several (a monorepo)', async () => {
    const h = harness({
      services: [service('svc_1', 'f1', 10), service('svc_2', 'f2', 10)],
    })
    expect(
      await actionOf(h.deps, 'create-task-from-issue').run(
        context({ issueUrl: 'https://github.com/acme/payments/issues/12' }),
      ),
    ).toEqual({
      status: 'needs_input',
      reason: 'unresolved_issue_service',
      field: 'service',
      candidates: ['Checkout', 'Payments'],
    })
    expect(h.filed).toEqual([])
  })

  it('asks which tracker when two connected sources both claim the reference', async () => {
    const h = harness({
      matches: [
        { source: 'jira', externalId: 'PROJ-12' },
        { source: 'linear', externalId: 'PROJ-12' },
      ],
    })
    expect(
      await actionOf(h.deps, 'create-task-from-issue').run(context({ issueUrl: 'PROJ-12' })),
    ).toEqual({
      status: 'needs_input',
      reason: 'ambiguous_issue_source',
      field: 'issueUrl',
      candidates: ['jira', 'linear'],
    })
  })

  it('says no connected tracker recognises the reference', async () => {
    const h = harness({ matches: [] })
    expect(
      await actionOf(h.deps, 'create-task-from-issue').run(
        context({ issueUrl: 'https://example.test/tickets/9' }),
      ),
    ).toMatchObject({ reason: 'unknown_issue_source', field: 'issueUrl' })
  })
})
