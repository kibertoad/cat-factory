import { describe, expect, it } from 'vitest'
import type {
  Clock,
  EnvConfigRepairer,
  EnvConfigRepairHandle,
  EnvConfigRepairJobRecord,
  EnvConfigRepairJobRecordPatch,
  EnvConfigRepairJobRepository,
  EnvConfigRepairRequest,
  EnvConfigRepairUpdate,
  IdGenerator,
  RepoValidationResult,
  Workspace,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { ConflictError, DispatchError } from '@cat-factory/kernel'
import { EnvConfigRepairService } from './EnvConfigRepairService.js'

// EnvConfigRepairService retry/inputs unit. A repair run's bootstrap `inputs` shape the
// agent prompt and are persisted on the (internal) record, so a retry — which STARTS a
// fresh run from the failed job's coords — must re-dispatch with the SAME inputs. These
// pin that round-trip (start persists → retry recovers) and the not-failed guard.

class InMemoryRepairJobRepo implements EnvConfigRepairJobRepository {
  readonly rows = new Map<string, EnvConfigRepairJobRecord>()
  private key(workspaceId: string, id: string) {
    return `${workspaceId}:${id}`
  }
  async insert(record: EnvConfigRepairJobRecord): Promise<void> {
    this.rows.set(this.key(record.workspaceId, record.id), { ...record })
  }
  async update(
    workspaceId: string,
    id: string,
    patch: EnvConfigRepairJobRecordPatch,
  ): Promise<void> {
    const k = this.key(workspaceId, id)
    const cur = this.rows.get(k)
    if (cur) this.rows.set(k, { ...cur, ...patch })
  }
  async get(workspaceId: string, id: string): Promise<EnvConfigRepairJobRecord | null> {
    return this.rows.get(this.key(workspaceId, id)) ?? null
  }
  async listByWorkspace(workspaceId: string): Promise<EnvConfigRepairJobRecord[]> {
    return [...this.rows.values()].filter((r) => r.workspaceId === workspaceId)
  }
}

class RecordingRepairer implements EnvConfigRepairer {
  readonly calls: EnvConfigRepairRequest[] = []
  /** When true, the FIRST `startRepair` throws (so `start` yields a failed run to retry). */
  failFirst = false
  /** When set, the FIRST `startRepair` throws THIS instead of the default preflight `Error`. */
  failWith?: unknown
  private started = 0
  async startRepair(request: EnvConfigRepairRequest): Promise<EnvConfigRepairHandle> {
    this.calls.push(request)
    this.started += 1
    if (this.failFirst && this.started === 1) {
      throw this.failWith ?? new Error('preflight: GitHub not connected')
    }
    return { workspaceId: request.workspaceId, jobId: request.jobId }
  }
  async pollRepair(): Promise<EnvConfigRepairUpdate> {
    return { state: 'done' }
  }
  async stopRepair(): Promise<void> {}
}

function makeService(repairer: EnvConfigRepairer, repo: InMemoryRepairJobRepo) {
  let n = 0
  const idGenerator: IdGenerator = { next: (prefix?: string) => `${prefix ?? 'id'}_${++n}` }
  const clock: Clock = { now: () => 1000 }
  const workspaceRepository = {
    get: async (id: string) => ({ id }) as unknown as Workspace,
  } as unknown as WorkspaceRepository
  const revalidate = async (): Promise<RepoValidationResult> => ({ ok: true, issues: [] })
  return new EnvConfigRepairService({
    envConfigRepairJobRepository: repo,
    workspaceRepository,
    idGenerator,
    clock,
    repairer,
    revalidate,
  })
}

const INPUTS = { region: 'us-east-1', target: 'staging' }

describe('EnvConfigRepairService', () => {
  it('persists the dispatch inputs on the run record', async () => {
    const repo = new InMemoryRepairJobRepo()
    const service = makeService(new RecordingRepairer(), repo)

    const job = await service.start('ws1', {
      owner: 'o',
      repo: 'r',
      gitRef: 'main',
      issues: [],
      inputs: INPUTS,
    })

    const record = await repo.get('ws1', job.id)
    expect(record?.inputs).toEqual(INPUTS)
  })

  it('retry re-dispatches a failed run with the recovered inputs under a fresh id', async () => {
    const repo = new InMemoryRepairJobRepo()
    const repairer = new RecordingRepairer()
    repairer.failFirst = true
    const service = makeService(repairer, repo)

    const failed = await service.start('ws1', {
      owner: 'o',
      repo: 'r',
      gitRef: 'feature/x',
      issues: [{ severity: 'error', message: 'bad' }],
      inputs: INPUTS,
    })
    expect(failed.status).toBe('failed')

    const retried = await service.retry('ws1', failed.id)
    expect(retried.status).toBe('running')
    expect(retried.id).not.toBe(failed.id)
    // The old failed row survives as the audit trail.
    expect((await repo.get('ws1', failed.id))?.status).toBe('failed')

    // The fresh dispatch carries the SAME inputs (and coords) the original was started with.
    const lastDispatch = repairer.calls.at(-1)
    expect(lastDispatch?.inputs).toEqual(INPUTS)
    expect(lastDispatch?.owner).toBe('o')
    expect(lastDispatch?.gitRef).toBe('feature/x')
  })

  // The point of the D1/I2 slice: a `start` catch classifies a transport dispatch rejection as
  // `dispatch` (via the structured DispatchError), while a pre-flight rejection stays `preflight`.
  it('classifies a transport DispatchError as a `dispatch` failure', async () => {
    const repo = new InMemoryRepairJobRepo()
    const repairer = new RecordingRepairer()
    repairer.failFirst = true
    repairer.failWith = new DispatchError('Container dispatch failed (HTTP 502): down', 502)
    const service = makeService(repairer, repo)

    const failed = await service.start('ws1', { owner: 'o', repo: 'r', gitRef: 'main', issues: [] })
    expect(failed.status).toBe('failed')
    expect(failed.failure?.kind).toBe('dispatch')
  })

  it('classifies a pre-flight rejection (plain Error) as a `preflight` failure', async () => {
    const repo = new InMemoryRepairJobRepo()
    const repairer = new RecordingRepairer()
    repairer.failFirst = true // default plain preflight Error — no `dispatch failed` phrase
    const service = makeService(repairer, repo)

    const failed = await service.start('ws1', { owner: 'o', repo: 'r', gitRef: 'main', issues: [] })
    expect(failed.status).toBe('failed')
    expect(failed.failure?.kind).toBe('preflight')
  })

  it('retry rejects a run that is not terminally failed', async () => {
    const repo = new InMemoryRepairJobRepo()
    const service = makeService(new RecordingRepairer(), repo)

    const running = await service.start('ws1', {
      owner: 'o',
      repo: 'r',
      gitRef: 'main',
      issues: [],
    })
    expect(running.status).toBe('running')

    await expect(service.retry('ws1', running.id)).rejects.toBeInstanceOf(ConflictError)
  })
})
