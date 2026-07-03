import { describe, expect, it } from 'vitest'
import type {
  EnvironmentRecord,
  EnvironmentRecordPatch,
  EnvironmentRegistryRepository,
  PreviewRef,
  PreviewTransport,
  PreviewView,
} from '@cat-factory/kernel'
import { PreviewService, type BuildPreviewJob } from './PreviewService.js'

/** An in-memory environment registry (only the methods PreviewService uses). */
class MemoryEnvRepo implements EnvironmentRegistryRepository {
  readonly rows = new Map<string, EnvironmentRecord>()
  async insert(record: EnvironmentRecord): Promise<void> {
    this.rows.set(record.id, { ...record })
  }
  async update(_ws: string, id: string, patch: EnvironmentRecordPatch): Promise<void> {
    const row = this.rows.get(id)
    if (row) this.rows.set(id, { ...row, ...patch })
  }
  async get(_ws: string, id: string): Promise<EnvironmentRecord | null> {
    return this.rows.get(id) ?? null
  }
  async getByBlock(ws: string, blockId: string): Promise<EnvironmentRecord | null> {
    const live = [...this.rows.values()]
      .filter((r) => r.workspaceId === ws && r.blockId === blockId && r.deletedAt === null)
      .sort((a, b) => b.createdAt - a.createdAt)
    return live[0] ?? null
  }
  async getByBlockAndFrame(
    ws: string,
    blockId: string,
    frameId: string,
  ): Promise<EnvironmentRecord | null> {
    const live = [...this.rows.values()]
      .filter(
        (r) =>
          r.workspaceId === ws &&
          r.blockId === blockId &&
          r.frameId === frameId &&
          r.deletedAt === null,
      )
      .sort((a, b) => b.createdAt - a.createdAt)
    return live[0] ?? null
  }
  async listByWorkspace(ws: string): Promise<EnvironmentRecord[]> {
    return [...this.rows.values()].filter((r) => r.workspaceId === ws && r.deletedAt === null)
  }
  async listExpired(): Promise<EnvironmentRecord[]> {
    return []
  }
  async softDelete(_ws: string, id: string, at: number): Promise<void> {
    const row = this.rows.get(id)
    if (row) this.rows.set(id, { ...row, deletedAt: at })
  }
}

class FakeTransport implements PreviewTransport {
  started: PreviewRef[] = []
  stopped: PreviewRef[] = []
  constructor(
    public view: PreviewView = { state: 'running', url: 'http://p:4173' },
    private readonly startError?: Error,
  ) {}
  async start(ref: PreviewRef): Promise<void> {
    if (this.startError) throw this.startError
    this.started.push(ref)
  }
  async poll(): Promise<PreviewView> {
    return this.view
  }
  async stop(ref: PreviewRef): Promise<void> {
    this.stopped.push(ref)
  }
}

const buildJob: BuildPreviewJob = async () => ({
  jobId: 'preview',
  spec: { mode: 'preview' },
  servePort: 4173,
})

function makeService(transport: PreviewTransport, repo = new MemoryEnvRepo()) {
  let n = 0
  return {
    repo,
    service: new PreviewService({
      previewTransport: transport,
      buildPreviewJob: buildJob,
      environmentRegistryRepository: repo,
      idGenerator: { next: (p: string) => `${p}_${++n}` },
      clock: { now: () => 1_000 + n },
    }),
  }
}

describe('PreviewService', () => {
  it('persists a preview-typed env row keyed by the frame on start', async () => {
    const transport = new FakeTransport()
    const { service, repo } = makeService(transport)
    const state = await service.start('ws', 'blk_fe')
    expect(state).toMatchObject({ frameId: 'blk_fe', status: 'starting' })
    expect(transport.started).toHaveLength(1)
    const rows = await repo.listByWorkspace('ws')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      blockId: 'blk_fe',
      frameId: 'blk_fe',
      provisionType: 'preview',
      status: 'provisioning',
      expiresAt: null,
    })
  })

  it('drives a provisioning preview to ready + persists the served URL on get', async () => {
    const { service, repo } = makeService(new FakeTransport())
    await service.start('ws', 'blk_fe')
    const state = await service.get('ws', 'blk_fe')
    expect(state).toMatchObject({ status: 'ready', url: 'http://p:4173' })
    const row = await repo.getByBlock('ws', 'blk_fe')
    expect(row).toMatchObject({ status: 'ready', url: 'http://p:4173' })
  })

  it('demotes a ready preview to failed once its container has vanished', async () => {
    const transport = new FakeTransport()
    const { service, repo } = makeService(transport)
    await service.start('ws', 'blk_fe')
    // First get drives it to ready.
    expect(await service.get('ws', 'blk_fe')).toMatchObject({ status: 'ready' })
    // The container is later evicted — a subsequent get re-polls the ready row and reflects it.
    transport.view = { state: 'failed', error: 'The preview container has gone away' }
    const state = await service.get('ws', 'blk_fe')
    expect(state).toMatchObject({ status: 'failed', error: 'The preview container has gone away' })
    expect(await repo.getByBlock('ws', 'blk_fe')).toMatchObject({ status: 'failed' })
  })

  it('keeps a ready preview and its URL when the transport cannot reconfirm the URL', async () => {
    const transport = new FakeTransport()
    const { service } = makeService(transport)
    await service.start('ws', 'blk_fe')
    expect(await service.get('ws', 'blk_fe')).toMatchObject({
      status: 'ready',
      url: 'http://p:4173',
    })
    // Container alive but the served-app URL can't be re-derived (e.g. after a process restart):
    // the healthy preview is NOT demoted — its authoritative persisted URL stands.
    transport.view = { state: 'starting' }
    expect(await service.get('ws', 'blk_fe')).toMatchObject({
      status: 'ready',
      url: 'http://p:4173',
    })
  })

  it('records a start-time transport failure as a failed state', async () => {
    const transport = new FakeTransport(undefined, new Error('docker down'))
    const { service, repo } = makeService(transport)
    const state = await service.start('ws', 'blk_fe')
    expect(state).toMatchObject({ status: 'failed', error: 'docker down' })
    const row = await repo.getByBlock('ws', 'blk_fe')
    expect(row).toMatchObject({ status: 'failed', lastError: 'docker down' })
  })

  it('supersedes a prior preview on restart (only the newest row is live)', async () => {
    const { service, repo } = makeService(new FakeTransport())
    await service.start('ws', 'blk_fe')
    await service.start('ws', 'blk_fe')
    const live = await repo.listByWorkspace('ws')
    expect(live).toHaveLength(1)
    // Two rows total, but only one is not tombstoned.
    expect(repo.rows.size).toBe(2)
  })

  it('stops by tombstoning the row + reclaiming the container', async () => {
    const transport = new FakeTransport()
    const { service, repo } = makeService(transport)
    await service.start('ws', 'blk_fe')
    const state = await service.stop('ws', 'blk_fe')
    expect(state).toMatchObject({ status: 'stopped' })
    expect(transport.stopped).toHaveLength(1)
    expect(await repo.listByWorkspace('ws')).toHaveLength(0)
  })

  it('reports stopped for a frame with no preview', async () => {
    const { service } = makeService(new FakeTransport())
    expect(await service.get('ws', 'blk_none')).toMatchObject({ status: 'stopped' })
    expect(await service.stop('ws', 'blk_none')).toMatchObject({ status: 'stopped' })
  })
})
