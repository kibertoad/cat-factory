import { describe, expect, it } from 'vitest'
import { createRecordingLogger } from '@cat-factory/kernel'
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
import { ConflictError, NotFoundError } from '@cat-factory/kernel'
import type { ProvisionArgs, ProvisionDispatch } from '@cat-factory/integrations'
import {
  EnvironmentTestService,
  type EnvironmentTestProvisioning,
  type EnvironmentTestRegistry,
  type EnvironmentTestTeardown,
} from './EnvironmentTestService.js'

// EnvironmentTestService state-machine unit. Drives the create-branch → provision →
// tear-down → delete-branch lifecycle over in-memory fakes (no DB / GitHub), covering both
// provision paths (synchronous `completed` + dispatched deploy job), the always-cleanup
// failure paths (pre-dispatch throw, failed deploy view, stop mid-provision), the
// stop ⇄ driver race guard, the registry reclaim, and the up-front gates. The repository
// round-trip parity is covered separately by the cross-runtime conformance suite.

class InMemoryRunRepo implements EnvironmentTestRunRepository {
  readonly rows = new Map<string, EnvironmentTestRunRecord>()
  private key(ws: string, id: string) {
    return `${ws}:${id}`
  }
  async insert(record: EnvironmentTestRunRecord): Promise<void> {
    this.rows.set(this.key(record.workspaceId, record.id), { ...record })
  }
  async updateIfRunning(
    ws: string,
    id: string,
    patch: EnvironmentTestRunRecordPatch,
  ): Promise<boolean> {
    const cur = this.rows.get(this.key(ws, id))
    if (!cur || cur.status !== 'running') return false
    this.rows.set(this.key(ws, id), { ...cur, ...patch })
    return true
  }
  async get(ws: string, id: string): Promise<EnvironmentTestRunRecord | null> {
    return this.rows.get(this.key(ws, id)) ?? null
  }
  async listRunningByWorkspace(ws: string): Promise<EnvironmentTestRunRecord[]> {
    return [...this.rows.values()].filter((r) => r.workspaceId === ws && r.status === 'running')
  }
  async listStale(cutoffMs: number): Promise<EnvironmentTestRunRecord[]> {
    return [...this.rows.values()].filter((r) => r.status === 'running' && r.updatedAt < cutoffMs)
  }
}

/** The env registry rows the provisioning fakes write, so reclaim behaviour is observable. */
class FakeRegistry implements EnvironmentTestRegistry {
  rows: { id: string; blockId: string; frameId: string; externalId: string | null }[] = []
  softDeleted: string[] = []
  async getByBlockAndFrame(_ws: string, blockId: string, frameId: string) {
    return this.rows.find((r) => r.blockId === blockId && r.frameId === frameId) ?? null
  }
  async softDelete(_ws: string, id: string): Promise<void> {
    this.rows = this.rows.filter((r) => r.id !== id)
    this.softDeleted.push(id)
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
  registry?: FakeRegistry
  dispatch?: ProvisionDispatch
  /** Makes `startProvision` throw AFTER persisting a failed registry row (the real shape). */
  dispatchThrows?: Error
  pollViews?: RunnerJobView[]
  /** Successive `refreshStatus` results for the synchronous readiness poll (last repeats). Default: ready. */
  statusPolls?: Partial<EnvironmentHandle>[]
  finalize?: EnvironmentHandle
  finalizeThrows?: Error
  block?: Block | null
  /** A mutable block holder, read at every block-repo call (for mid-run edit tests). */
  blockRef?: { current: Block | null }
  onStartProvision?: (args: ProvisionArgs) => void
  teardowns?: string[]
  released?: RunnerJobRef[]
  repoContext?: RunRepoContext | null
  canProvision?: { ok: boolean; reason?: string }
  /** The provider connection pre-flight result (`null` ⇒ nothing to probe). Default: ok. */
  probe?: { ok: boolean; message?: string } | null
  /** Full replacement teardown port (e.g. one that throws NotFound on replay). */
  teardownImpl?: EnvironmentTestTeardown
}) {
  const runRepo = opts.runRepo ?? new InMemoryRunRepo()
  const registry = opts.registry ?? new FakeRegistry()
  const teardowns = opts.teardowns ?? []
  const released = opts.released ?? []
  let pollIdx = 0
  let statusIdx = 0
  const provisioning: EnvironmentTestProvisioning = {
    canProvision: async () => opts.canProvision ?? { ok: true },
    testProvisioning: async () => (opts.probe === undefined ? { ok: true } : opts.probe),
    startProvision: async (args) => {
      opts.onStartProvision?.(args)
      if (opts.dispatchThrows) {
        // Mirror the real service: a dispatch failure persists a failed env row under
        // the synthetic (blockId, frameId) key before propagating.
        registry.rows.push({
          id: 'reg-failed',
          blockId: args.blockId!,
          frameId: args.frameId!,
          externalId: null,
        })
        throw opts.dispatchThrows
      }
      const dispatch = opts.dispatch ?? {
        kind: 'completed' as const,
        handle: { id: 'env-1', url: 'https://x' } as EnvironmentHandle,
        reason: null,
      }
      // Mirror the real service's registry writes: a dispatched job leaves a
      // `provisioning` placeholder; a synchronous provision records the real env.
      registry.rows.push(
        dispatch.kind === 'dispatched'
          ? {
              id: 'reg-placeholder',
              blockId: args.blockId!,
              frameId: args.frameId!,
              externalId: null,
            }
          : {
              id: dispatch.handle.id,
              blockId: args.blockId!,
              frameId: args.frameId!,
              externalId: 'ext-1',
            },
      )
      return dispatch
    },
    pollProvisionJob: async () => opts.pollViews?.[pollIdx++] ?? { state: 'done' },
    finalizeProvision: async (args) => {
      if (opts.finalizeThrows) throw opts.finalizeThrows
      const handle =
        opts.finalize ?? ({ id: 'env-1', status: 'ready', url: 'https://x' } as EnvironmentHandle)
      // Finalize supersedes the placeholder with the settled record.
      registry.rows = registry.rows.filter((r) => r.blockId !== args.blockId)
      registry.rows.push({
        id: handle.id,
        blockId: args.blockId!,
        frameId: args.frameId!,
        externalId: 'ext-1',
      })
      return { handle, reason: null }
    },
    releaseProvisionJob: async (_ws, ref) => {
      released.push(ref)
    },
    refreshStatus: async (_ws, id) => {
      const seq = opts.statusPolls
      const next = seq ? (seq[statusIdx++] ?? seq[seq.length - 1]) : { status: 'ready' as const }
      return { id, url: 'https://live', status: 'ready', ...next } as EnvironmentHandle
    },
  }
  const teardown: EnvironmentTestTeardown = opts.teardownImpl ?? {
    teardown: async (_ws, id) => {
      teardowns.push(id)
      // A real teardown tombstones the registry record.
      registry.rows = registry.rows.filter((r) => r.id !== id)
    },
  }
  const repoCtx =
    opts.repoContext === undefined
      ? { repo: fakeRepo().repo, baseBranch: 'main', repoId: 'repo_1' }
      : opts.repoContext
  const logger = createRecordingLogger()
  const logs = logger.lines
  const service = new EnvironmentTestService({
    environmentTestRunRepository: runRepo,
    workspaceRepository,
    blockRepository: {
      get: async () =>
        opts.blockRef
          ? opts.blockRef.current
          : opts.block === undefined
            ? frameBlock()
            : opts.block,
    } as never,
    provisioning,
    teardown,
    environmentRegistry: registry,
    resolveRunRepoContext: async () => repoCtx,
    idGenerator,
    clock,
    logger,
  })
  return { service, runRepo, registry, teardowns, released, logs }
}

describe('EnvironmentTestService — start guards and the happy paths', () => {
  it('rejects an infraless service (nothing to test)', async () => {
    const { service } = makeService({ block: frameBlock({ provisioning: { type: 'infraless' } }) })
    await expect(service.startTest('ws', 'frame-1')).rejects.toBeInstanceOf(ConflictError)
  })

  it('rejects a non-frame block', async () => {
    const { service } = makeService({ block: frameBlock({ level: 'task' }) })
    await expect(service.startTest('ws', 'frame-1')).rejects.toBeInstanceOf(ConflictError)
  })

  it('rejects an un-provisionable service, keeping the conflict CODE and the handler sub-reason distinct', async () => {
    // Regression: the sub-reason used to be passed as `{ reason }`, which `ConflictError` merges as
    // `{ reason: code, ...details }` — so it CLOBBERED the `env_test_not_provisionable` code the SPA
    // keys its localized copy + jump off, leaving only the raw message. The code must survive on
    // `details.reason`; the handler sub-reason rides alongside on `details.handlerIssue`.
    const { service, runRepo } = makeService({ canProvision: { ok: false, reason: 'no-handler' } })
    const err = await service.startTest('ws', 'frame-1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConflictError)
    const conflict = err as ConflictError
    expect(conflict.details?.reason).toBe('env_test_not_provisionable')
    expect(conflict.details?.handlerIssue).toBe('no-handler')
    // A pre-dispatch gate 409: it throws before any run record is inserted.
    expect(runRepo.rows.size).toBe(0)
  })

  it('carries the type-mismatch handler sub-reason on the un-provisionable conflict', async () => {
    const { service } = makeService({ canProvision: { ok: false, reason: 'type-mismatch' } })
    const err = await service.startTest('ws', 'frame-1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConflictError)
    const conflict = err as ConflictError
    expect(conflict.details?.reason).toBe('env_test_not_provisionable')
    expect(conflict.details?.handlerIssue).toBe('type-mismatch')
  })

  it('rejects a workspace with no git provider as a 409 (no run record is created)', async () => {
    const { service, runRepo } = makeService({ repoContext: null })
    await expect(service.startTest('ws', 'frame-1')).rejects.toBeInstanceOf(ConflictError)
    expect(runRepo.rows.size).toBe(0)
  })

  it('pre-flights the provider connection and rejects a bad one BEFORE any branch/record', async () => {
    const { repo, calls } = fakeRepo()
    const { service, runRepo } = makeService({
      repoContext: { repo, baseBranch: 'main', repoId: 'repo_1' },
      probe: { ok: false, message: "project 'demo' was not found." },
    })
    const err = await service.startTest('ws', 'frame-1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConflictError)
    const conflict = err as ConflictError
    expect(conflict.details?.reason).toBe('env_test_connection_failed')
    expect(conflict.message).toContain("project 'demo' was not found")
    // A pre-dispatch gate: no run record, and no throwaway branch was created.
    expect(runRepo.rows.size).toBe(0)
    expect(calls.created).toEqual([])
  })

  it('provisions normally when the connection pre-flight passes (probe ok)', async () => {
    const { service, runRepo } = makeService({ probe: { ok: true } })
    const run = await service.startTest('ws', 'frame-1')
    expect(run.status).toBe('running')
    expect(runRepo.rows.size).toBe(1)
  })

  it('runs the full happy path on the synchronous (completed) provision path', async () => {
    const { repo, calls } = fakeRepo()
    const { service, teardowns, registry } = makeService({
      repoContext: { repo, baseBranch: 'main', repoId: 'repo_1' },
      dispatch: {
        kind: 'completed',
        handle: { id: 'env-9', url: 'https://live' } as EnvironmentHandle,
        reason: null,
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
    // Nothing accretes in the registry: teardown tombstoned the synthetic-block record.
    expect(registry.rows).toEqual([])
  })

  it('waits for a synchronously-recorded env to reach ready BEFORE tearing it down', async () => {
    const { repo } = fakeRepo()
    const { service, teardowns } = makeService({
      repoContext: { repo, baseBranch: 'main', repoId: 'repo_1' },
      // A REST provider records the env at dispatch but it's still coming up.
      dispatch: {
        kind: 'completed',
        handle: { id: 'env-9', url: null } as EnvironmentHandle,
        reason: null,
      },
      statusPolls: [{ status: 'provisioning' }, { status: 'provisioning' }, { status: 'ready' }],
    })
    const started = await service.startTest('ws', 'frame-1')

    // First two polls: env still provisioning — stays in `provisioning`, nothing torn down yet.
    expect((await service.pollEnvTest('ws', started.id)).state).toBe('running')
    expect((await service.pollEnvTest('ws', started.id)).state).toBe('running')
    expect((await service.getRun('ws', started.id)).stage).toBe('provisioning')
    expect(teardowns).toEqual([]) // NOT torn down while still coming up

    // Third poll: env is ready → advance to teardown; then teardown + delete-branch → done.
    expect((await service.pollEnvTest('ws', started.id)).state).toBe('running')
    expect((await service.getRun('ws', started.id)).stage).toBe('tearing_down')
    expect((await service.pollEnvTest('ws', started.id)).state).toBe('running')
    expect((await service.pollEnvTest('ws', started.id)).state).toBe('done')

    expect((await service.getRun('ws', started.id)).status).toBe('succeeded')
    expect(teardowns).toEqual(['env-9'])
  })

  it('fails the run (with cleanup) when a synchronously-recorded env never becomes ready', async () => {
    const { repo, calls } = fakeRepo()
    const { service, teardowns } = makeService({
      repoContext: { repo, baseBranch: 'main', repoId: 'repo_1' },
      dispatch: {
        kind: 'completed',
        handle: { id: 'env-9', url: null } as EnvironmentHandle,
        reason: null,
      },
      statusPolls: [{ status: 'failed', lastError: 'VM failed to boot' }],
    })
    const started = await service.startTest('ws', 'frame-1')
    const result = await service.pollEnvTest('ws', started.id)
    expect(result.state).toBe('failed')

    const final = await service.getRun('ws', started.id)
    expect(final.status).toBe('failed')
    expect(final.failedStage).toBe('provisioning')
    expect(final.error).toContain('VM failed to boot')
    // Cleanup still runs: the recorded env is torn down and the throwaway branch deleted.
    expect(teardowns).toEqual(['env-9'])
    expect(calls.deleted).toEqual(calls.created)
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
    const { service, teardowns, released, registry } = makeService({
      repoContext: { repo, baseBranch: 'main', repoId: 'repo_1' },
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
    expect(registry.rows).toEqual([])
  })

  it('pins the provisioning config at dispatch: a mid-flight frame edit cannot break finalize', async () => {
    const { repo } = fakeRepo()
    const blockRef = { current: frameBlock() as Block | null }
    const { service, teardowns } = makeService({
      repoContext: { repo, baseBranch: 'main', repoId: 'repo_1' },
      blockRef,
      dispatch: { kind: 'dispatched', ref: { runId: 'r', jobId: 'r' } },
      pollViews: [{ state: 'done' }],
      finalize: { id: 'env-pin', status: 'ready', url: null } as EnvironmentHandle,
    })
    const started = await service.startTest('ws', 'frame-1')
    // The frame is deleted (or flipped to infraless) mid-run — the record carries the
    // pinned config, so the finalize + teardown still resolve.
    blockRef.current = null
    expect((await service.pollEnvTest('ws', started.id)).state).toBe('running')
    await service.pollEnvTest('ws', started.id) // tearing_down
    expect((await service.pollEnvTest('ws', started.id)).state).toBe('done')
    expect((await service.getRun('ws', started.id)).status).toBe('succeeded')
    expect(teardowns).toEqual(['env-pin'])
  })
})

describe('EnvironmentTestService — failure, teardown and terminal guards', () => {
  it('fails at dispatch, attributing it to `provisioning` (not the mislabeled `creating_branch`), and cleans up', async () => {
    const { repo, calls } = fakeRepo()
    const { service, registry, released, logs } = makeService({
      repoContext: { repo, baseBranch: 'main', repoId: 'repo_1' },
      dispatchThrows: new Error('no deploy runner wired'),
    })
    const run = await service.startTest('ws', 'frame-1')
    expect(run.status).toBe('failed')
    // The branch already exists when startProvision throws, so the failure is a PROVISIONING
    // failure — the stage is advanced before dispatch precisely so it isn't mislabeled here.
    expect(run.failedStage).toBe('provisioning')
    expect(run.error).toContain('no deploy runner wired')
    // The branch was created before the dispatch threw — it must be reclaimed.
    expect(calls.created).toHaveLength(1)
    expect(calls.deleted).toEqual(calls.created)
    // The failed registry row under the synthetic key is tombstoned, and the (possibly
    // accepted) deploy job released.
    expect(registry.rows).toEqual([])
    expect(registry.softDeleted).toEqual(['reg-failed'])
    expect(released).toHaveLength(1)
    // The failure is logged server-side (the only server-side trace besides the run record),
    // carrying the corrected stage, the message, and the cause's stack.
    expect(logs).toHaveLength(1)
    expect(logs[0]!.msg).toBe('environment self-test failed')
    expect(logs[0]!.fields).toMatchObject({ runId: run.id, failedStage: 'provisioning' })
    expect(logs[0]!.fields.err).toContain('no deploy runner wired')
    expect(typeof logs[0]!.fields.stack).toBe('string')
  })

  it('fails at provisioning: releases the runner, finalizes the failed view, tears down + deletes', async () => {
    const { repo, calls } = fakeRepo()
    const { service, teardowns, released, registry } = makeService({
      repoContext: { repo, baseBranch: 'main', repoId: 'repo_1' },
      dispatch: { kind: 'dispatched', ref: { runId: 'r', jobId: 'r' } },
      pollViews: [{ state: 'failed', error: 'deploy blew up' }],
      finalize: {
        id: 'env-failed',
        status: 'failed',
        lastError: 'apply failed',
      } as EnvironmentHandle,
    })
    const started = await service.startTest('ws', 'frame-1')
    const result = await service.pollEnvTest('ws', started.id)
    expect(result.state).toBe('failed')

    const final = await service.getRun('ws', started.id)
    expect(final.status).toBe('failed')
    expect(final.failedStage).toBe('provisioning')
    expect(final.error).toContain('deploy blew up')
    // The deploy runner was reclaimed and the finalized (failed) env torn down — partial
    // infra from the failed apply is removed through the provider.
    expect(released).toHaveLength(1)
    expect(teardowns).toEqual(['env-failed'])
    expect(calls.deleted).toHaveLength(1)
    expect(registry.rows).toEqual([])
  })

  it('reclaims the provisioning placeholder row even when the failed view cannot be finalized', async () => {
    const { repo, calls } = fakeRepo()
    const { service, registry } = makeService({
      repoContext: { repo, baseBranch: 'main', repoId: 'repo_1' },
      dispatch: { kind: 'dispatched', ref: { runId: 'r', jobId: 'r' } },
      pollViews: [{ state: 'failed', error: 'deploy blew up' }],
      finalizeThrows: new Error('provider gone'),
    })
    const started = await service.startTest('ws', 'frame-1')
    await service.pollEnvTest('ws', started.id)
    // The placeholder had no infra (externalId null) → straight tombstone.
    expect(registry.rows).toEqual([])
    expect(registry.softDeleted).toEqual(['reg-placeholder'])
    expect(calls.deleted).toHaveLength(1)
  })

  it('tolerates a not-found teardown on a driver replay (idempotent tear-down stage)', async () => {
    // Simulate the crash-in-window replay: the env was already torn down (tombstoned) on a prior
    // pass whose stage-advance write was lost, so re-entering `tearing_down` teardown 404s. The
    // run must still advance to done, NOT flip to failed.
    const { repo, calls } = fakeRepo()
    const { service } = makeService({
      repoContext: { repo, baseBranch: 'main', repoId: 'repo_1' },
      dispatch: {
        kind: 'completed',
        handle: { id: 'env-gone', url: 'https://live' } as EnvironmentHandle,
        reason: null,
      },
      teardownImpl: {
        teardown: async () => {
          throw new NotFoundError('Environment', 'env-gone')
        },
      },
    })
    const started = await service.startTest('ws', 'frame-1')
    // provisioning → tearing_down
    await service.pollEnvTest('ws', started.id)
    // tearing_down → deleting_branch (teardown 404s but is tolerated)
    expect((await service.pollEnvTest('ws', started.id)).state).toBe('running')
    // deleting_branch → done
    expect((await service.pollEnvTest('ws', started.id)).state).toBe('done')
    const final = await service.getRun('ws', started.id)
    expect(final.status).toBe('succeeded')
    expect(calls.deleted).toHaveLength(1)
  })

  it('still fails when the teardown provider genuinely errors (not a not-found)', async () => {
    const { repo } = fakeRepo()
    const { service } = makeService({
      repoContext: { repo, baseBranch: 'main', repoId: 'repo_1' },
      dispatch: {
        kind: 'completed',
        handle: { id: 'env-stuck', url: 'https://live' } as EnvironmentHandle,
        reason: null,
      },
      teardownImpl: {
        teardown: async () => {
          throw new Error('cluster unreachable')
        },
      },
    })
    const started = await service.startTest('ws', 'frame-1')
    await service.pollEnvTest('ws', started.id) // → tearing_down
    const result = await service.pollEnvTest('ws', started.id)
    expect(result.state).toBe('failed')
    const final = await service.getRun('ws', started.id)
    expect(final.status).toBe('failed')
    expect(final.failedStage).toBe('tearing_down')
    expect(final.error).toContain('cluster unreachable')
  })

  it('expire() cleans up and fails a run stuck past its poll budget', async () => {
    const { repo, calls } = fakeRepo()
    const { service, teardowns } = makeService({
      repoContext: { repo, baseBranch: 'main', repoId: 'repo_1' },
      dispatch: {
        kind: 'completed',
        handle: { id: 'env-budget', url: null } as EnvironmentHandle,
        reason: null,
      },
    })
    const started = await service.startTest('ws', 'frame-1')
    // still `provisioning` (never polled to completion) — the driver's budget ran out.
    const finalized = await service.expire(
      'ws',
      started.id,
      'The environment test did not finish within its polling budget.',
    )
    expect(finalized.status).toBe('failed')
    expect(finalized.failedStage).toBe('provisioning')
    expect(finalized.error).toMatch(/polling budget/)
    // Cleanup ran: the env was torn down and the branch deleted (never orphaned).
    expect(teardowns).toEqual(['env-budget'])
    expect(calls.deleted).toHaveLength(1)
  })

  it('stop() cleans up a running test and marks it failed', async () => {
    const { repo, calls } = fakeRepo()
    const { service, teardowns, registry } = makeService({
      repoContext: { repo, baseBranch: 'main', repoId: 'repo_1' },
      dispatch: {
        kind: 'completed',
        handle: { id: 'env-2', url: null } as EnvironmentHandle,
        reason: null,
      },
    })
    const started = await service.startTest('ws', 'frame-1')
    const stopped = await service.stop('ws', started.id)
    expect(stopped.status).toBe('failed')
    expect(teardowns).toEqual(['env-2'])
    expect(calls.deleted).toHaveLength(1)
    expect(registry.rows).toEqual([])
  })

  it('stop() mid-async-provision releases the deploy job and reclaims the placeholder', async () => {
    const { repo, calls } = fakeRepo()
    const { service, released, registry, teardowns } = makeService({
      repoContext: { repo, baseBranch: 'main', repoId: 'repo_1' },
      dispatch: { kind: 'dispatched', ref: { runId: 'r', jobId: 'r' } },
      pollViews: [{ state: 'running' }],
    })
    const started = await service.startTest('ws', 'frame-1')
    // Deploy job still in flight (no env finalized yet).
    expect((await service.pollEnvTest('ws', started.id)).state).toBe('running')
    const stopped = await service.stop('ws', started.id)
    expect(stopped.status).toBe('failed')
    // The in-flight deploy job is released (aborting the container), the placeholder row
    // tombstoned, the branch deleted — nothing owned by the test survives it.
    expect(released).toHaveLength(1)
    expect(registry.softDeleted).toEqual(['reg-placeholder'])
    expect(teardowns).toEqual([])
    expect(calls.deleted).toHaveLength(1)
  })

  it('a driver poll after a stop cannot resurrect the run (guarded terminal write)', async () => {
    const { repo } = fakeRepo()
    const { service, runRepo } = makeService({
      repoContext: { repo, baseBranch: 'main', repoId: 'repo_1' },
      dispatch: { kind: 'dispatched', ref: { runId: 'r', jobId: 'r' } },
      pollViews: [{ state: 'done' }],
    })
    const started = await service.startTest('ws', 'frame-1')
    const stopped = await service.stop('ws', started.id)
    expect(stopped.status).toBe('failed')
    // A late driver poll short-circuits on the terminal status; the record is unchanged.
    const result = await service.pollEnvTest('ws', started.id)
    expect(result.state).toBe('failed')
    const record = runRepo.rows.get(`ws:${started.id}`)!
    expect(record.status).toBe('failed')
    expect(record.error).toBe('Stopped by the user.')
  })

  it('fails a run stranded at creating_branch (the start request died mid-flight)', async () => {
    const { service, runRepo } = makeService({})
    // Simulate a crash between insert and dispatch: a bare `creating_branch` record.
    await runRepo.insert({
      id: 'envtest-stranded',
      workspaceId: 'ws',
      blockId: 'frame-1',
      status: 'running',
      stage: 'creating_branch',
      initiatedBy: null,
      provisioning: { type: 'kubernetes' },
      branch: null,
      environmentId: null,
      envUrl: null,
      error: null,
      failedStage: null,
      createdAt: 1,
      updatedAt: 1,
    })
    const result = await service.pollEnvTest('ws', 'envtest-stranded')
    expect(result.state).toBe('failed')
    expect((await service.getRun('ws', 'envtest-stranded')).status).toBe('failed')
  })

  it('expire() finalizes a wedged run with cleanup and is idempotent on terminal runs', async () => {
    const { repo, calls } = fakeRepo()
    const { service, released, registry } = makeService({
      repoContext: { repo, baseBranch: 'main', repoId: 'repo_1' },
      dispatch: { kind: 'dispatched', ref: { runId: 'r', jobId: 'r' } },
      pollViews: [{ state: 'running' }],
    })
    const started = await service.startTest('ws', 'frame-1')
    const expired = await service.expire('ws', started.id, 'driver lost')
    expect(expired.status).toBe('failed')
    expect(expired.error).toBe('driver lost')
    expect(released).toHaveLength(1)
    expect(registry.rows).toEqual([])
    expect(calls.deleted).toHaveLength(1)
    // Idempotent: a second expire returns the terminal run unchanged.
    const again = await service.expire('ws', started.id, 'other reason')
    expect(again.error).toBe('driver lost')
  })
})
