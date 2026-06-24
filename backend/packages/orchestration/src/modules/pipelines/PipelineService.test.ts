import { describe, expect, it } from 'vitest'
import { ValidationError } from '@cat-factory/kernel'
import type {
  ObservabilityConnectionRecord,
  ObservabilityConnectionRepository,
  IdGenerator,
  Pipeline,
  PipelineRepository,
  Workspace,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { PipelineService } from './PipelineService.js'

// The post-release-health gate is observability-gated: it is not in any default pipeline
// and a user may only add it once an observability integration (a Datadog connection) is
// connected. These tests pin that guard on both the create and update paths.

const WS = 'ws_1'

function workspaceRepo(): WorkspaceRepository {
  const ws = { id: WS } as Workspace
  return { get: async (id) => (id === WS ? ws : null) } as WorkspaceRepository
}

function pipelineRepo(store = new Map<string, Pipeline>()): PipelineRepository {
  return {
    listByWorkspace: async () => [...store.values()],
    get: async (_ws, id) => store.get(id) ?? null,
    insert: async (_ws, p) => void store.set(p.id, p),
    update: async (_ws, p) => void store.set(p.id, p),
    delete: async (_ws, id) => void store.delete(id),
  }
}

let counter = 0
const idGenerator: IdGenerator = { next: (prefix = 'id') => `${prefix}_${++counter}` }

/** A connection repo that reports either a wired or an unwired workspace. */
function observabilityRepo(connected: boolean): ObservabilityConnectionRepository {
  return {
    get: async (workspaceId) =>
      connected
        ? ({
            workspaceId,
            provider: 'datadog',
            credentials: 'sealed',
            summary: JSON.stringify({ site: 'datadoghq.com' }),
            createdAt: 0,
            updatedAt: 0,
          } as ObservabilityConnectionRecord)
        : null,
    upsert: async () => {},
    delete: async () => {},
  }
}

describe('PipelineService — post-release-health observability gate', () => {
  it('rejects creating a pipeline with post-release-health when no observability integration is wired', async () => {
    const svc = new PipelineService({
      workspaceRepository: workspaceRepo(),
      pipelineRepository: pipelineRepo(),
      idGenerator,
      // observabilityConnectionRepository intentionally absent → no integration possible.
    })
    await expect(
      svc.create(WS, { name: 'Ship + watch', agentKinds: ['coder', 'post-release-health'] }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects when a connection repo is wired but the workspace has no connection', async () => {
    const svc = new PipelineService({
      workspaceRepository: workspaceRepo(),
      pipelineRepository: pipelineRepo(),
      idGenerator,
      observabilityConnectionRepository: observabilityRepo(false),
    })
    await expect(
      svc.create(WS, { name: 'Ship + watch', agentKinds: ['coder', 'post-release-health'] }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('allows post-release-health once the workspace has an observability connection', async () => {
    const svc = new PipelineService({
      workspaceRepository: workspaceRepo(),
      pipelineRepository: pipelineRepo(),
      idGenerator,
      observabilityConnectionRepository: observabilityRepo(true),
    })
    const p = await svc.create(WS, {
      name: 'Ship + watch',
      agentKinds: ['coder', 'post-release-health'],
    })
    expect(p.agentKinds).toEqual(['coder', 'post-release-health'])
  })

  it('does not gate when the post-release-health step is present but disabled', async () => {
    const svc = new PipelineService({
      workspaceRepository: workspaceRepo(),
      pipelineRepository: pipelineRepo(),
      idGenerator,
      observabilityConnectionRepository: observabilityRepo(false),
    })
    const p = await svc.create(WS, {
      name: 'Ship, watch later',
      agentKinds: ['coder', 'post-release-health'],
      enabled: [true, false],
    })
    expect(p.agentKinds).toEqual(['coder', 'post-release-health'])
  })

  it('gates an update that adds post-release-health to a custom pipeline', async () => {
    const store = new Map<string, Pipeline>()
    const svc = new PipelineService({
      workspaceRepository: workspaceRepo(),
      pipelineRepository: pipelineRepo(store),
      idGenerator,
      observabilityConnectionRepository: observabilityRepo(false),
    })
    const created = await svc.create(WS, { name: 'Plain', agentKinds: ['coder'] })
    await expect(
      svc.update(WS, created.id, { agentKinds: ['coder', 'post-release-health'] }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('PipelineService — estimate gating, companion placement, labels & archive', () => {
  function svc(store = new Map<string, Pipeline>()) {
    return new PipelineService({
      workspaceRepository: workspaceRepo(),
      pipelineRepository: pipelineRepo(store),
      idGenerator,
    })
  }

  it('rejects a companion with no producer it can review', async () => {
    await expect(
      svc().create(WS, { name: 'Lone reviewer', agentKinds: ['reviewer'] }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('accepts a companion placed immediately after its producer', async () => {
    const p = await svc().create(WS, {
      name: 'Build + adjacent companion',
      agentKinds: ['coder', 'reviewer'],
    })
    expect(p.agentKinds).toEqual(['coder', 'reviewer'])
  })

  it('rejects a companion separated from its producer by another step', async () => {
    await expect(
      svc().create(WS, {
        name: 'Build + gap companion',
        agentKinds: ['coder', 'tester', 'reviewer'],
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects gating a step with no task-estimator before it', async () => {
    await expect(
      svc().create(WS, {
        name: 'Gated, no estimator',
        agentKinds: ['coder', 'reviewer'],
        gating: [null, { enabled: true, minRisk: 0.6 }],
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('accepts gating when a task-estimator runs earlier, persisting it', async () => {
    const p = await svc().create(WS, {
      name: 'Gated reviewer',
      agentKinds: ['task-estimator', 'coder', 'reviewer'],
      gating: [null, null, { enabled: true, minRisk: 0.6 }],
    })
    expect(p.gating?.[2]).toEqual({ enabled: true, minRisk: 0.6 })
    // Only the gated index is persisted; the rest are aligned-null.
    expect(p.gating?.[0]).toBeNull()
  })

  it('organizes a built-in (archive + labels) — the only mutation a built-in accepts', async () => {
    const store = new Map<string, Pipeline>()
    store.set('pl_builtin', {
      id: 'pl_builtin',
      name: 'Curated',
      agentKinds: ['coder'],
      builtin: true,
    })
    const service = svc(store)
    // update is rejected on a built-in...
    await expect(service.update(WS, 'pl_builtin', { name: 'x' })).rejects.toBeInstanceOf(
      ValidationError,
    )
    // ...but organize (labels/archive) is allowed and preserves builtin.
    const organized = await service.organize(WS, 'pl_builtin', {
      archived: true,
      labels: ['  hot ', 'hot', ''],
    })
    expect(organized.builtin).toBe(true)
    expect(organized.archived).toBe(true)
    expect(organized.labels).toEqual(['hot']) // trimmed + de-duped + blanks dropped
  })

  it('clears labels and unarchives via organize', async () => {
    const store = new Map<string, Pipeline>()
    const service = svc(store)
    const created = await service.create(WS, {
      name: 'Tagged',
      agentKinds: ['coder'],
      labels: ['a'],
    })
    const cleared = await service.organize(WS, created.id, { labels: [], archived: false })
    expect(cleared.labels).toBeUndefined()
    expect(cleared.archived).toBeUndefined()
  })
})
