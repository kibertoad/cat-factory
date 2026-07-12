import { describe, expect, it } from 'vitest'
import type {
  Block,
  Clock,
  EnvironmentHandle,
  EnvironmentTestRunRecord,
  EnvironmentTestRunRecordPatch,
  EnvironmentTestRunRepository,
  IdGenerator,
  RepoFiles,
  RunnerJobRef,
  RunnerJobView,
  RunRepoContext,
  Workspace,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { ConflictError } from '@cat-factory/kernel'
import type { ProvisionArgs, ProvisionDispatch } from '@cat-factory/integrations'
import {
  EnvironmentTestService,
  type EnvironmentTestProvisioning,
  type EnvironmentTestTeardown,
} from './EnvironmentTestService.js'

// EnvironmentTestService state-machine unit. Drives the create-branch → provision →
// tear-down → delete-branch lifecycle over in-memory fakes (no DB / GitHub), covering both
// provision paths (synchronous `completed` + dispatched deploy job), the always-cleanup
// failure path, and the up-front gates. The repository round-trip parity is covered
// separately by the cross-runtime conformance suite.

class InMemoryRunRepo implements EnvironmentTestRunRepository {
  readonly rows = new Map<string, EnvironmentTestRunRecord>()
  private key(ws: string, id: string) {
    return `${ws}:${id}`
  }
  async insert(record: EnvironmentTestRunRecord): Promise<void> {
    this.rows.set(this.key(record.workspaceId, record.id), { ...record })
  }
  async update(ws: string, id: string, patch: EnvironmentTestRunRecordPatch): Promise<void> {
    const cur = this.rows.get(this.key(ws, id))
    if (cur) this.rows.set(this.key(ws, id), { ...cur, ...patch })
  }
  async get(ws: string, id: string): Promise<EnvironmentTestRunRecord | null> {
    return this.rows.get(this.key(ws, id)) ?? null
  }
  async listRunningByWorkspace(ws: string): Promise<EnvironmentTestRunRecord[]> {
    return [...this.rows.values()].filter((r) => r.workspaceId === ws && r.status === 'running')
  }
}

const clock: Clock = { now: () => 1_000 }
let idSeq = 0
const idGenerator: IdGenerator = { next: (p) => `${p}-${++idSeq}` }
const workspaceRepository = {
  get: async (id: string): Promise<Workspace | null> => ({ id, name: 'ws' }) as Workspace,
} as unknown as WorkspaceRepository

function frameBlock(overrides: Partial<Block> = {}): Block {
  return {
    id: 'frame-1',
    level: 'frame',
    provisioning: { type: 'kubernetes' },
    ...overrides,
  } as Block
}

/** A RepoFiles fake that records branch create/delete calls. */
function fakeRepo() {
  const calls = { created: [] as string[], deleted: [] as string[] }
  const repo = {
    getFile: async () => null,
    listDirectory: async () => [],
    headSha: async () => 'base-sha',
    createBranch: async (branch: string) => {
      calls.created.push(branch)
    },
    deleteBranch: async (branch: string) => {
      calls.deleted.push(branch)
    },
    commitFiles: async () => ({ sha: 'c' }) as never,
    openPullRequest: async () => ({ number: 1 }) as never,
  } satisfies RepoFiles
  return { repo, calls }
}

function makeService(opts: {
  runRepo?: InMemoryRunRepo
  dispatch?: ProvisionDispatch
  pollViews?: RunnerJobView[]
  finalize?: EnvironmentHandle
  block?: Block | null
  onStartProvision?: (args: ProvisionArgs) => void
  teardowns?: string[]
  released?: RunnerJobRef[]
  repoContext?: RunRepoContext | null
  canProvision?: { ok: boolean; reason?: string }
}) {
  const runRepo = opts.runRepo ?? new InMemoryRunRepo()
  const teardowns = opts.teardowns ?? []
  const released = opts.released ?? []
  let pollIdx = 0
  const provisioning: EnvironmentTestProvisioning = {
    canProvision: async () => opts.canProvision ?? { ok: true },
    startProvision: async (args) => {
      opts.onStartProvision?.(args)
      return (
        opts.dispatch ?? {
          kind: 'completed',
          handle: { id: 'env-1', url: 'https://x' } as EnvironmentHandle,
        }
      )
    },
    pollProvisionJob: async () => opts.pollViews?.[pollIdx++] ?? { state: 'done' },
    finalizeProvision: async () =>
      opts.finalize ?? ({ id: 'env-1', status: 'ready', url: 'https://x' } as EnvironmentHandle),
    releaseProvisionJob: async (_ws, ref) => {
      released.push(ref)
    },
  }
  const teardown: EnvironmentTestTeardown = {
    teardown: async (_ws, id) => {
      teardowns.push(id)
    },
  }
  const repoCtx =
    opts.repoContext === undefined
      ? { repo: fakeRepo().repo, baseBranch: 'main' }
      : opts.repoContext
  const service = new EnvironmentTestService({
    environmentTestRunRepository: runRepo,
    workspaceRepository,
    blockRepository: {
      get: async () => (opts.block === undefined ? frameBlock() : opts.block),
    } as never,
    provisioning,
    teardown,
    resolveRunRepoContext: async () => repoCtx,
    idGenerator,
    clock,
  })
  return { service, runRepo, teardowns, released }
}

describe('EnvironmentTestService', () => {
  it('rejects an infraless service (nothing to test)', async () => {
    const { service } = makeService({ block: frameBlock({ provisioning: { type: 'infraless' } }) })
    await expect(service.startTest('ws', 'frame-1')).rejects.toBeInstanceOf(ConflictError)
  })

  it('rejects a non-frame block', async () => {
    const { service } = makeService({ block: frameBlock({ level: 'task' }) })
    await expect(service.startTest('ws', 'frame-1')).rejects.toBeInstanceOf(ConflictError)
  })

  it('fails (no vcs) and cleans up when the repo context is unresolved', async () => {
    const { service } = makeService({ repoContext: null })
    const run = await service.startTest('ws', 'frame-1')
    expect(run.status).toBe('failed')
    expect(run.failedStage).toBe('creating_branch')
  })

  it('runs the full happy path on the synchronous (completed) provision path', async () => {
    const { repo, calls } = fakeRepo()
    const { service, teardowns } = makeService({
      repoContext: { repo, baseBranch: 'main' },
      dispatch: {
        kind: 'completed',
        handle: { id: 'env-9', url: 'https://live' } as EnvironmentHandle,
      },
    })
    const started = await service.startTest('ws', 'frame-1')
    expect(started.status).toBe('running')
    expect(started.stage).toBe('provisioning')
    expect(calls.created).toHaveLength(1)
    const branch = calls.created[0]!
    expect(branch).toMatch(/^cat-factory\/env-test\//)

    // provisioning (env already recorded) → tearing_down
    expect((await service.pollEnvTest('ws', started.id)).state).toBe('running')
    // tearing_down → deleting_branch
    expect((await service.pollEnvTest('ws', started.id)).state).toBe('running')
    // deleting_branch → done
    expect((await service.pollEnvTest('ws', started.id)).state).toBe('done')

    const final = await service.getRun('ws', started.id)
    expect(final.status).toBe('succeeded')
    expect(final.stage).toBe('done')
    expect(teardowns).toEqual(['env-9'])
    expect(calls.deleted).toEqual([branch])
  })

  it('passes the real frame as frameId and a synthetic blockId to provisioning', async () => {
    let seen: ProvisionArgs | undefined
    const { service } = makeService({ onStartProvision: (a) => (seen = a) })
    const run = await service.startTest('ws', 'frame-1')
    expect(seen?.frameId).toBe('frame-1')
    expect(seen?.blockId).toBe(`env-test:${run.id}`)
    expect(seen?.serviceProvisioning?.type).toBe('kubernetes')
  })

  it('polls a dispatched deploy job to done, then finalizes + tears down + deletes', async () => {
    const { repo, calls } = fakeRepo()
    const { service, teardowns, released } = makeService({
      repoContext: { repo, baseBranch: 'main' },
      dispatch: { kind: 'dispatched', ref: { runId: 'r', jobId: 'r' } },
      pollViews: [{ state: 'running' }, { state: 'done' }],
      finalize: { id: 'env-k8s', status: 'ready', url: 'https://k8s' } as EnvironmentHandle,
    })
    const started = await service.startTest('ws', 'frame-1')
    expect(started.stage).toBe('provisioning')
    // first poll: deploy job still running
    expect((await service.pollEnvTest('ws', started.id)).state).toBe('running')
    // second poll: done → finalize + advance to tearing_down
    expect((await service.pollEnvTest('ws', started.id)).state).toBe('running')
    // tearing_down → deleting_branch
    await service.pollEnvTest('ws', started.id)
    // deleting_branch → done
    expect((await service.pollEnvTest('ws', started.id)).state).toBe('done')

    expect(released).toHaveLength(1)
    expect(teardowns).toEqual(['env-k8s'])
    expect(calls.deleted).toHaveLength(1)
  })

  it('fails at provisioning and still tears down + deletes the branch', async () => {
    const { repo, calls } = fakeRepo()
    const { service, teardowns } = makeService({
      repoContext: { repo, baseBranch: 'main' },
      dispatch: { kind: 'dispatched', ref: { runId: 'r', jobId: 'r' } },
      pollViews: [{ state: 'failed', error: 'deploy blew up' }],
    })
    const started = await service.startTest('ws', 'frame-1')
    const result = await service.pollEnvTest('ws', started.id)
    expect(result.state).toBe('failed')

    const final = await service.getRun('ws', started.id)
    expect(final.status).toBe('failed')
    expect(final.failedStage).toBe('provisioning')
    expect(final.error).toContain('deploy blew up')
    // No env was finalized (the job failed), so nothing to tear down; the branch is still reclaimed.
    expect(teardowns).toEqual([])
    expect(calls.deleted).toHaveLength(1)
  })

  it('stop() cleans up a running test and marks it failed', async () => {
    const { repo, calls } = fakeRepo()
    const { service, teardowns } = makeService({
      repoContext: { repo, baseBranch: 'main' },
      dispatch: { kind: 'completed', handle: { id: 'env-2', url: null } as EnvironmentHandle },
    })
    const started = await service.startTest('ws', 'frame-1')
    const stopped = await service.stop('ws', started.id)
    expect(stopped.status).toBe('failed')
    expect(teardowns).toEqual(['env-2'])
    expect(calls.deleted).toHaveLength(1)
  })
})
