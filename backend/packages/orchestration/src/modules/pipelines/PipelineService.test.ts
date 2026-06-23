import { describe, expect, it } from 'vitest'
import { ValidationError } from '@cat-factory/kernel'
import type {
  DatadogConnectionRecord,
  DatadogConnectionRepository,
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
function datadogRepo(connected: boolean): DatadogConnectionRepository {
  return {
    get: async (workspaceId) =>
      connected
        ? ({
            workspaceId,
            site: 'datadoghq.com',
            apiKey: 'a',
            appKey: 'b',
            createdAt: 0,
            updatedAt: 0,
          } as DatadogConnectionRecord)
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
      // datadogConnectionRepository intentionally absent → no integration possible.
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
      datadogConnectionRepository: datadogRepo(false),
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
      datadogConnectionRepository: datadogRepo(true),
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
      datadogConnectionRepository: datadogRepo(false),
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
      datadogConnectionRepository: datadogRepo(false),
    })
    const created = await svc.create(WS, { name: 'Plain', agentKinds: ['coder'] })
    await expect(
      svc.update(WS, created.id, { agentKinds: ['coder', 'post-release-health'] }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})
