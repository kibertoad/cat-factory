import { describe, expect, it } from 'vitest'
import { createRecordingLogger } from '@cat-factory/kernel'
import type {
  Block,
  Clock,
  EnvironmentHandle,
  EnvironmentProbeReport,
  EnvironmentProbeSurface,
  EnvironmentTestRun,
  EnvironmentTestRunRecord,
  EnvironmentTestRunRecordPatch,
  EnvironmentTestRunRepository,
  ExecutionEventPublisher,
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
import type { EnvironmentProbeOutcome, EnvironmentProbeStage } from './environmentProbeStage.js'

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

/**
 * A bare `running` run row, for the cases that simulate a crash between the insert and whatever
 * comes next. Its own builder rather than a literal per case: the record has grown fields (the
 * mode, the dry run's claim and report) and a literal per case is a literal that stops compiling
 * every time it grows again.
 */
function strandedRecord(
  overrides: Partial<EnvironmentTestRunRecord> & Pick<EnvironmentTestRunRecord, 'id'>,
): EnvironmentTestRunRecord {
  return {
    workspaceId: 'ws',
    blockId: 'frame-1',
    mode: 'provision',
    status: 'running',
    stage: 'creating_branch',
    initiatedBy: null,
    provisioning: { type: 'kubernetes' },
    branch: null,
    environmentId: null,
    envUrl: null,
    error: null,
    failedStage: null,
    probeSurface: null,
    probeDispatchedAt: null,
    probeProgress: null,
    probe: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
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
  /**
   * Wires the AGENT DRY RUN's stage. Absent means this deployment cannot run one, which is what
   * `startTest` refuses the `agent-probe` mode on.
   */
  probeStage?: FakeProbeStage
  /** The workspace spend safeguard the agent dry run answers to. Absent ⇒ nothing is enforced. */
  isOverBudget?: (workspaceId: string) => Promise<boolean>
  /** Records the pushed run transitions, for the cases about what the SPA is told and when. */
  eventPublisher?: { envTestChanged: (ws: string, run: EnvironmentTestRun) => Promise<void> }
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
    ...(opts.probeStage ? { probeStage: opts.probeStage as unknown as EnvironmentProbeStage } : {}),
    ...(opts.isOverBudget ? { isOverBudget: opts.isOverBudget } : {}),
    ...(opts.eventPublisher
      ? { eventPublisher: opts.eventPublisher as unknown as ExecutionEventPublisher }
      : {}),
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

/**
 * The probe stage, faked at the COLLABORATOR boundary rather than at the kernel port: the service
 * only ever calls these three methods, and driving the real stage here would pull a repo
 * resolution and an environment read into a test about the state machine.
 */
class FakeProbeStage {
  dispatched: EnvironmentProbeSurface[] = []
  released: EnvironmentProbeSurface[] = []
  /** Frame reads, so a stage that read the block twice per tick fails a test. */
  targetReads = 0
  polls = 0
  constructor(
    private readonly script: {
      surface?: EnvironmentProbeSurface
      /** Successive poll outcomes (the last repeats). Default: reports on the first poll. */
      outcomes?: EnvironmentProbeOutcome[]
      dispatchThrows?: Error
      pollThrows?: Error
      /** Whether the deployment can run this surface's prober at all (admission). */
      supported?: boolean
      /** Runs INSIDE the dispatch, to simulate a stop landing while it is in flight. */
      onDispatch?: () => Promise<void>
    } = {},
  ) {}
  surfaceFor(): EnvironmentProbeSurface {
    return this.script.surface ?? 'api'
  }
  async supports(): Promise<boolean> {
    return this.script.supported ?? true
  }
  async resolveTarget(_record: EnvironmentTestRunRecord) {
    this.targetReads += 1
    return { frame: frameBlock(), surface: this.surfaceFor() }
  }
  async dispatch(_record: EnvironmentTestRunRecord, surface: EnvironmentProbeSurface) {
    if (this.script.dispatchThrows) throw this.script.dispatchThrows
    await this.script.onDispatch?.()
    this.dispatched.push(surface)
    return { workspaceId: 'ws', jobId: 'j', surface }
  }
  async poll(
    _record: EnvironmentTestRunRecord,
    _surface: EnvironmentProbeSurface,
  ): Promise<EnvironmentProbeOutcome> {
    this.polls += 1
    if (this.script.pollThrows) throw this.script.pollThrows
    const seq = this.script.outcomes
    const next = seq ? (seq[this.polls - 1] ?? seq[seq.length - 1]) : undefined
    return next ?? { state: 'reported', report: probeReport() }
  }
  async release(_record: EnvironmentTestRunRecord, surface: EnvironmentProbeSurface) {
    this.released.push(surface)
  }
}

/** A minimal already-graded report, as the stage hands one back. */
function probeReport(over: Partial<EnvironmentProbeReport> = {}): EnvironmentProbeReport {
  return {
    surface: 'api',
    verdict: 'operable',
    summary: 'Listed and created a record with the supplied token.',
    operations: [{ name: 'list projects', authenticated: true, outcome: 'succeeded' }],
    missingContext: [],
    blockers: [],
    attempted: 1,
    succeeded: 1,
    authenticatedSucceeded: 1,
    ...over,
  }
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
    await runRepo.insert(strandedRecord({ id: 'envtest-stranded' }))
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

describe('EnvironmentTestService: the agent dry run (`agent-probe` mode)', () => {
  it('refuses the mode outright when no prober is wired, before any side effect', async () => {
    // Admitting it would create a branch, stand an environment up and then park at a stage with
    // nothing to advance it, until the sweeper tore the lot down with a timeout for a reason that
    // was knowable before a single side effect.
    const { repo, calls } = fakeRepo()
    const { service, runRepo } = makeService({
      repoContext: { repo, baseBranch: 'main', repoId: 'repo_1' },
    })
    const err = await service
      .startTest('ws', 'frame-1', null, 'agent-probe')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect((err as ConflictError).details?.reason).toBe('env_test_probe_unavailable')
    expect(runRepo.rows.size).toBe(0)
    expect(calls.created).toEqual([])
  })

  it('leaves the provisioning self-test unaffected when no prober is wired', async () => {
    const { service } = makeService({})
    const run = await service.startTest('ws', 'frame-1')
    expect(run.mode).toBe('provision')
    expect(run.status).toBe('running')
  })

  it('runs the whole lifecycle through the probe: claim, dispatch, report, tear down', async () => {
    const { repo, calls } = fakeRepo()
    const probeStage = new FakeProbeStage({ surface: 'ui' })
    const { service, runRepo, teardowns, registry } = makeService({
      repoContext: { repo, baseBranch: 'main', repoId: 'repo_1' },
      probeStage,
    })
    const started = await service.startTest('ws', 'frame-1', 'usr-1', 'agent-probe')
    expect(started.mode).toBe('agent-probe')

    // The environment settles, so the run goes to `probing` rather than straight to teardown.
    expect((await service.pollEnvTest('ws', started.id)).state).toBe('running')
    expect(runRepo.rows.get(`ws:${started.id}`)?.stage).toBe('probing')

    // The first probing poll CLAIMS (persisting the surface), dispatches, then MARKS; it does not
    // poll. The mark is what a replay reads to tell a claim with no container behind it from a
    // job that is really running, and the frame is read ONCE for both the surface and the prompt.
    expect((await service.pollEnvTest('ws', started.id)).state).toBe('running')
    expect(probeStage.dispatched).toEqual(['ui'])
    expect(probeStage.polls).toBe(0)
    expect(probeStage.targetReads).toBe(1)
    expect(runRepo.rows.get(`ws:${started.id}`)?.probeSurface).toBe('ui')
    expect(runRepo.rows.get(`ws:${started.id}`)?.probeDispatchedAt).toBe(1_000)

    // The next poll reads the report, reclaims the prober's container, and moves to teardown.
    expect((await service.pollEnvTest('ws', started.id)).state).toBe('running')
    expect(probeStage.polls).toBe(1)
    expect(probeStage.released).toEqual(['ui'])
    expect(runRepo.rows.get(`ws:${started.id}`)?.probe?.verdict).toBe('operable')

    // Then the ordinary tail: tear down, delete the branch, done.
    expect((await service.pollEnvTest('ws', started.id)).state).toBe('running')
    expect((await service.pollEnvTest('ws', started.id)).state).toBe('done')
    const settled = await service.getRun('ws', started.id)
    expect(settled.status).toBe('succeeded')
    expect(settled.stage).toBe('done')
    expect(settled.probe?.verdict).toBe('operable')
    expect(teardowns).toEqual(['env-1'])
    expect(calls.deleted).toHaveLength(1)
    expect(registry.rows).toEqual([])
  })

  it('keeps a bad verdict a SUCCEEDED run, because the status is the lifecycle', async () => {
    // The one interesting outcome must not be indistinguishable from a broken diagnostic: an
    // `inoperable` verdict is the dry run working, and it still owes the developer its teardown.
    const { repo, calls } = fakeRepo()
    const probeStage = new FakeProbeStage({
      outcomes: [
        {
          state: 'reported',
          report: probeReport({
            verdict: 'inoperable',
            succeeded: 0,
            authenticatedSucceeded: 0,
            missingContext: ['no test credentials were supplied'],
          }),
        },
      ],
    })
    const { service, teardowns } = makeService({
      repoContext: { repo, baseBranch: 'main', repoId: 'repo_1' },
      probeStage,
    })
    const started = await service.startTest('ws', 'frame-1', null, 'agent-probe')
    for (let i = 0; i < 5; i++) await service.pollEnvTest('ws', started.id)
    const settled = await service.getRun('ws', started.id)
    expect(settled.status).toBe('succeeded')
    expect(settled.probe?.verdict).toBe('inoperable')
    expect(settled.probe?.missingContext).toEqual(['no test credentials were supplied'])
    expect(teardowns).toEqual(['env-1'])
    expect(calls.deleted).toHaveLength(1)
  })

  it('fails the run at the `probing` stage when the probe itself broke, and cleans up', async () => {
    // A container that never reported has established NOTHING about the environment, so it must
    // not be laundered into a verdict about the service.
    const { repo, calls } = fakeRepo()
    const probeStage = new FakeProbeStage({
      pollThrows: new Error('the dry-run container was evicted'),
    })
    const { service, teardowns, registry } = makeService({
      repoContext: { repo, baseBranch: 'main', repoId: 'repo_1' },
      probeStage,
    })
    const started = await service.startTest('ws', 'frame-1', null, 'agent-probe')
    await service.pollEnvTest('ws', started.id)
    await service.pollEnvTest('ws', started.id)
    const result = await service.pollEnvTest('ws', started.id)
    expect(result.state).toBe('failed')
    const settled = await service.getRun('ws', started.id)
    expect(settled.status).toBe('failed')
    expect(settled.failedStage).toBe('probing')
    expect(settled.error).toContain('evicted')
    expect(settled.probe).toBeNull()
    // Always cleans up: the environment, its registry row, the branch AND the prober's container.
    expect(teardowns).toEqual(['env-1'])
    expect(registry.rows).toEqual([])
    expect(calls.deleted).toHaveLength(1)
    expect(probeStage.released).toEqual(['api'])
  })

  it('a stop mid-probe reclaims the prober container it claimed', async () => {
    const { repo } = fakeRepo()
    const probeStage = new FakeProbeStage({ surface: 'ui', outcomes: [{ state: 'running' }] })
    const { service, teardowns } = makeService({
      repoContext: { repo, baseBranch: 'main', repoId: 'repo_1' },
      probeStage,
    })
    const started = await service.startTest('ws', 'frame-1', null, 'agent-probe')
    await service.pollEnvTest('ws', started.id)
    await service.pollEnvTest('ws', started.id)
    expect(probeStage.dispatched).toEqual(['ui'])

    const stopped = await service.stop('ws', started.id)
    expect(stopped.status).toBe('failed')
    // The claim is what makes the reclaim addressable, and it names the container that started.
    expect(probeStage.released).toEqual(['ui'])
    expect(teardowns).toEqual(['env-1'])
  })

  it('does not dispatch a second prober when a replay re-enters a claimed probing stage', async () => {
    // The claim is written BEFORE the dispatch precisely so a durable replay lands on the poll
    // path rather than starting another agent against the same environment.
    const { repo } = fakeRepo()
    const probeStage = new FakeProbeStage({
      outcomes: [{ state: 'running' }, { state: 'running' }],
    })
    const { service } = makeService({
      repoContext: { repo, baseBranch: 'main', repoId: 'repo_1' },
      probeStage,
    })
    const started = await service.startTest('ws', 'frame-1', null, 'agent-probe')
    await service.pollEnvTest('ws', started.id)
    await service.pollEnvTest('ws', started.id)
    await service.pollEnvTest('ws', started.id)
    await service.pollEnvTest('ws', started.id)
    expect(probeStage.dispatched).toHaveLength(1)
    expect(probeStage.polls).toBe(2)
  })

  it('re-dispatches after a replay landed between the CLAIM and the dispatch', async () => {
    // The window the mark exists for. Without it the poll path sees a claim, polls a job that was
    // never started, and the backend answers "no such job", which the dispatcher reports as an
    // EVICTION: a lost isolate told to the developer as a container failure.
    const { repo } = fakeRepo()
    const probeStage = new FakeProbeStage({ outcomes: [{ state: 'running' }] })
    const { service, runRepo } = makeService({
      repoContext: { repo, baseBranch: 'main', repoId: 'repo_1' },
      probeStage,
    })
    const started = await service.startTest('ws', 'frame-1', null, 'agent-probe')
    await service.pollEnvTest('ws', started.id)

    // Simulate the crash: the claim landed, the dispatch did not.
    const row = runRepo.rows.get(`ws:${started.id}`)!
    row.probeSurface = 'api'
    row.probeDispatchedAt = null
    row.stage = 'probing'

    await service.pollEnvTest('ws', started.id)
    expect(probeStage.dispatched).toEqual(['api'])
    expect(probeStage.polls).toBe(0)
    expect(runRepo.rows.get(`ws:${started.id}`)?.probeDispatchedAt).toBe(1_000)
  })

  it('reclaims the container when a stop lands WHILE the dispatch is in flight', async () => {
    // The stop's own cleanup ran against a container that did not exist yet, so the one now
    // starting has nobody left to reclaim it: unnoticed, it idles for its full lifetime beside a
    // torn-down environment. The post-dispatch mark is the guard that catches it.
    const { repo } = fakeRepo()
    let service!: EnvironmentTestService
    let runId = ''
    const probeStage = new FakeProbeStage({
      surface: 'ui',
      onDispatch: async () => {
        await service.stop('ws', runId)
      },
    })
    const made = makeService({
      repoContext: { repo, baseBranch: 'main', repoId: 'repo_1' },
      probeStage,
    })
    service = made.service
    const started = await service.startTest('ws', 'frame-1', null, 'agent-probe')
    runId = started.id
    await service.pollEnvTest('ws', started.id)
    const result = await service.pollEnvTest('ws', started.id)

    expect(result.state).toBe('failed')
    expect(probeStage.dispatched).toEqual(['ui'])
    // Twice: once by the stop (a no-op against a container that had not started) and once by the
    // fail() the rejected mark triggers, which is the one that actually collects it. The teardown
    // runs twice for the same reason, which is why every cleanup step on this path is idempotent.
    expect(probeStage.released).toEqual(['ui', 'ui'])
    expect(made.teardowns).toEqual(['env-1', 'env-1'])
  })

  it('persists and pushes the prober live progress, then clears it with the report', async () => {
    // `probing` is the only stage measured in minutes. With nothing written the run row never
    // changes, no event fires, and the card sits on "probing with an agent" for the whole
    // container run, which reads exactly like a wedge.
    const { repo } = fakeRepo()
    const probeStage = new FakeProbeStage({
      outcomes: [
        { state: 'running', subtasks: { completed: 1, inProgress: 1, total: 4 } },
        { state: 'running', subtasks: { completed: 1, inProgress: 1, total: 4 } },
        { state: 'running', subtasks: { completed: 3, inProgress: 0, total: 4 } },
        { state: 'reported', report: probeReport() },
      ],
    })
    const emitted: EnvironmentTestRun[] = []
    const { service, runRepo } = makeService({
      repoContext: { repo, baseBranch: 'main', repoId: 'repo_1' },
      probeStage,
      eventPublisher: { envTestChanged: async (_ws, run) => void emitted.push(run) },
    })
    const started = await service.startTest('ws', 'frame-1', null, 'agent-probe')
    await service.pollEnvTest('ws', started.id) // provisioning → probing
    await service.pollEnvTest('ws', started.id) // claim + dispatch
    emitted.length = 0

    await service.pollEnvTest('ws', started.id)
    expect(runRepo.rows.get(`ws:${started.id}`)?.probeProgress).toEqual({
      completed: 1,
      inProgress: 1,
      total: 4,
    })
    expect(emitted).toHaveLength(1)

    // The SAME counts again write nothing: a write per poll is what the comparison avoids.
    await service.pollEnvTest('ws', started.id)
    expect(emitted).toHaveLength(1)

    await service.pollEnvTest('ws', started.id)
    expect(runRepo.rows.get(`ws:${started.id}`)?.probeProgress?.completed).toBe(3)
    expect(emitted).toHaveLength(2)

    // The report is the finer answer to the same question, so the counts go with it: a stale
    // "3 of 4" beside a finished probe reads as one still working.
    await service.pollEnvTest('ws', started.id)
    const settled = runRepo.rows.get(`ws:${started.id}`)
    expect(settled?.probe?.verdict).toBe('operable')
    expect(settled?.probeProgress).toBeNull()
  })

  it('refuses the mode when the deployment cannot serve THIS surface image, before provisioning', async () => {
    // A wired prober is not a runnable one: the browser prober needs its own executor image, and a
    // deployment that binds the plain class and not that one would otherwise pay for a branch, a
    // full provision and a teardown to discover it inside the dispatch.
    const { repo, calls } = fakeRepo()
    const probeStage = new FakeProbeStage({ surface: 'ui', supported: false })
    const { service, runRepo } = makeService({
      repoContext: { repo, baseBranch: 'main', repoId: 'repo_1' },
      probeStage,
    })
    const err = await service
      .startTest('ws', 'frame-1', null, 'agent-probe')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect((err as ConflictError).details?.reason).toBe('env_test_probe_unavailable')
    expect((err as ConflictError).details?.surface).toBe('ui')
    expect(runRepo.rows.size).toBe(0)
    expect(calls.created).toEqual([])

    // The provisioning self-test is untouched by a prober gap.
    expect((await service.startTest('ws', 'frame-1')).status).toBe('running')
  })

  it('refuses a dry run past the workspace spend budget, before provisioning', async () => {
    // The first billable call no run start gates. Admitted, the proxy refuses the container's
    // first completion and the operator has paid for a provision and a teardown to be told about
    // a ceiling that was knowable up front.
    const { repo, calls } = fakeRepo()
    const { service, runRepo } = makeService({
      repoContext: { repo, baseBranch: 'main', repoId: 'repo_1' },
      probeStage: new FakeProbeStage(),
      isOverBudget: async () => true,
    })
    const err = await service
      .startTest('ws', 'frame-1', null, 'agent-probe')
      .catch((e: unknown) => e)
    expect((err as ConflictError).details?.reason).toBe('env_test_over_budget')
    expect(runRepo.rows.size).toBe(0)
    expect(calls.created).toEqual([])
    // The provisioning self-test spends nothing, so a budget never blocks it.
    expect((await service.startTest('ws', 'frame-1')).status).toBe('running')
  })

  it('fails CLOSED when the budget probe itself throws', async () => {
    const { repo } = fakeRepo()
    const { service, logs } = makeService({
      repoContext: { repo, baseBranch: 'main', repoId: 'repo_1' },
      probeStage: new FakeProbeStage(),
      isOverBudget: async () => {
        throw new Error('the spend ledger is unreachable')
      },
    })
    const err = await service
      .startTest('ws', 'frame-1', null, 'agent-probe')
      .catch((e: unknown) => e)
    expect((err as ConflictError).details?.reason).toBe('env_test_over_budget')
    expect(logs.some((l) => l.msg.includes('budget probe failed'))).toBe(true)
  })

  it('refuses a SECOND self-test for a frame that already has one running', async () => {
    // Each run provisions its own environment under a synthetic per-run key nothing supersedes,
    // so two in flight is two live environments for one service: billed twice, and racing each
    // other to create on any provider whose namespace is derived per service.
    const { repo, calls } = fakeRepo()
    const { service, runRepo } = makeService({
      repoContext: { repo, baseBranch: 'main', repoId: 'repo_1' },
      probeStage: new FakeProbeStage(),
    })
    const first = await service.startTest('ws', 'frame-1')
    const branchesAfterFirst = calls.created.length

    const err = await service
      .startTest('ws', 'frame-1', null, 'agent-probe')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect((err as ConflictError).details?.reason).toBe('env_test_already_running')
    expect((err as ConflictError).details?.runId).toBe(first.id)
    expect(runRepo.rows.size).toBe(1)
    expect(calls.created).toHaveLength(branchesAfterFirst)

    // Once the first settles, the second is admitted.
    await service.stop('ws', first.id)
    expect((await service.startTest('ws', 'frame-1', null, 'agent-probe')).mode).toBe('agent-probe')
  })

  it('fails the run when the dispatch throws, with the environment reclaimed', async () => {
    const { repo, calls } = fakeRepo()
    const probeStage = new FakeProbeStage({
      dispatchThrows: new Error('The environment provider exposed no URL for this environment.'),
    })
    const { service, teardowns } = makeService({
      repoContext: { repo, baseBranch: 'main', repoId: 'repo_1' },
      probeStage,
    })
    const started = await service.startTest('ws', 'frame-1', null, 'agent-probe')
    await service.pollEnvTest('ws', started.id)
    const result = await service.pollEnvTest('ws', started.id)
    expect(result.state).toBe('failed')
    const settled = await service.getRun('ws', started.id)
    expect(settled.failedStage).toBe('probing')
    expect(settled.error).toContain('no URL')
    expect(teardowns).toEqual(['env-1'])
    expect(calls.deleted).toHaveLength(1)
  })
})
