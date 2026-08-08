import { describe, expect, it } from 'vitest'
import {
  ConflictError,
  PipelineRegistry,
  REVIEW_PIPELINE_ID,
  seedPipelines,
  ValidationError,
} from '@cat-factory/kernel'
import type {
  ObservabilityConnectionRecord,
  ObservabilityConnectionRepository,
  IdGenerator,
  Pipeline,
  PipelineRepository,
  PipelineScheduleRepository,
  Workspace,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import type { PipelineServiceDependencies } from './PipelineService.js'
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
    // First write wins, matching the conflict-targeted `ON CONFLICT DO NOTHING` both stores use.
    insertIfAbsent: async (_ws, p) => void (store.has(p.id) || store.set(p.id, p)),
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
      svc.create(WS, {
        name: 'Ship + watch',
        purpose: 'build',
        agentKinds: ['coder', 'post-release-health'],
      }),
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
      svc.create(WS, {
        name: 'Ship + watch',
        purpose: 'build',
        agentKinds: ['coder', 'post-release-health'],
      }),
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
      purpose: 'build',
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
      purpose: 'build',
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
    const created = await svc.create(WS, { name: 'Plain', purpose: 'build', agentKinds: ['coder'] })
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
      svc().create(WS, { name: 'Lone reviewer', purpose: 'build', agentKinds: ['reviewer'] }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('accepts a companion placed immediately after its producer', async () => {
    const p = await svc().create(WS, {
      name: 'Build + adjacent companion',
      purpose: 'build',
      agentKinds: ['coder', 'reviewer'],
    })
    expect(p.agentKinds).toEqual(['coder', 'reviewer'])
  })

  it('rejects a companion separated from its producer by another step', async () => {
    await expect(
      svc().create(WS, {
        name: 'Build + gap companion',
        purpose: 'build',
        agentKinds: ['coder', 'tester-api', 'reviewer'],
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects gating a step with no task-estimator before it', async () => {
    await expect(
      svc().create(WS, {
        name: 'Gated, no estimator',
        purpose: 'build',
        agentKinds: ['coder', 'reviewer'],
        gating: [null, { enabled: true, minRisk: 0.6, onMissingEstimate: 'run' }],
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('accepts gating when a task-estimator runs earlier, persisting it', async () => {
    const p = await svc().create(WS, {
      name: 'Gated reviewer',
      purpose: 'build',
      agentKinds: ['task-estimator', 'coder', 'reviewer'],
      gating: [null, null, { enabled: true, minRisk: 0.6, onMissingEstimate: 'run' }],
    })
    expect(p.gating?.[2]).toEqual({ enabled: true, minRisk: 0.6, onMissingEstimate: 'run' })
    // Only the gated index is persisted; the rest are aligned-null.
    expect(p.gating?.[0]).toBeNull()
  })

  it('persists a Tester step opting OUT of the test quality companion', async () => {
    const service = svc()
    const p = await service.create(WS, {
      name: 'Build + test, no QC',
      purpose: 'build',
      agentKinds: ['coder', 'tester-api'],
      testerQuality: [null, { enabled: false }],
    })
    expect(p.testerQuality?.[1]).toEqual({ enabled: false })
    // Aligned-null on the non-Tester index.
    expect(p.testerQuality?.[0]).toBeNull()
    // A round-trip through update preserves the opt-out.
    const updated = await service.update(WS, p.id, { name: 'renamed' })
    expect(updated.testerQuality?.[1]).toEqual({ enabled: false })
  })

  it('does not persist a testerQuality array when every Tester step keeps the default', async () => {
    const p = await svc().create(WS, {
      name: 'Build + test, default QC',
      purpose: 'build',
      agentKinds: ['coder', 'tester-api'],
      // Explicit "enabled, ungated" is the default — not worth an array.
      testerQuality: [null, { enabled: true }],
    })
    expect(p.testerQuality).toBeUndefined()
  })

  it('persists a Coder step opting OUT of the follow-up companion', async () => {
    const p = await svc().create(WS, {
      name: 'Build, no follow-ups',
      purpose: 'build',
      agentKinds: ['coder', 'reviewer'],
      followUps: [false, null],
    })
    expect(p.followUps?.[0]).toBe(false)
    expect(p.followUps?.[1]).toBeNull()
  })

  it('rejects a QC-gated Tester step with no task-estimator before it', async () => {
    await expect(
      svc().create(WS, {
        name: 'QC-gated, no estimator',
        purpose: 'build',
        agentKinds: ['coder', 'tester-api'],
        testerQuality: [
          null,
          { enabled: true, gating: { enabled: true, minRisk: 0.6, onMissingEstimate: 'run' } },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects a QC-gated Tester step that sets no threshold', async () => {
    await expect(
      svc().create(WS, {
        name: 'QC-gated, no threshold',
        purpose: 'build',
        agentKinds: ['task-estimator', 'coder', 'tester-api'],
        testerQuality: [
          null,
          null,
          { enabled: true, gating: { enabled: true, onMissingEstimate: 'run' } },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('accepts a QC-gated Tester step when a task-estimator runs earlier, persisting it', async () => {
    const p = await svc().create(WS, {
      name: 'QC-gated',
      purpose: 'build',
      agentKinds: ['task-estimator', 'coder', 'tester-api'],
      testerQuality: [
        null,
        null,
        { enabled: true, gating: { enabled: true, minImpact: 0.7, onMissingEstimate: 'run' } },
      ],
    })
    expect(p.testerQuality?.[2]).toEqual({
      enabled: true,
      gating: { enabled: true, minImpact: 0.7, onMissingEstimate: 'run' },
    })
  })

  it('organizes a built-in (archive + labels) — the only mutation a built-in accepts', async () => {
    const store = new Map<string, Pipeline>()
    store.set('pl_builtin', {
      id: 'pl_builtin',
      name: 'Curated',
      purpose: 'build',
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
      purpose: 'build',
      agentKinds: ['coder'],
      labels: ['a'],
    })
    const cleared = await service.organize(WS, created.id, { labels: [], archived: false })
    expect(cleared.labels).toBeUndefined()
    expect(cleared.archived).toBeUndefined()
  })
})

describe('PipelineService — reseed', () => {
  function svc(store = new Map<string, Pipeline>()) {
    return new PipelineService({
      workspaceRepository: workspaceRepo(),
      pipelineRepository: pipelineRepo(store),
      idGenerator,
    })
  }

  it('materialises a brand-new built-in the workspace does not have yet (insert, not update)', async () => {
    // A board seeded before a built-in shipped has an empty store here; reseeding the
    // catalog id must CREATE it (the "I don't see the review pipeline" fix) rather than 404.
    const store = new Map<string, Pipeline>()
    const seeded = seedPipelines().find((p) => p.id === REVIEW_PIPELINE_ID)!
    const reseeded = await svc(store).reseed(WS, REVIEW_PIPELINE_ID)
    expect(reseeded.id).toBe(REVIEW_PIPELINE_ID)
    expect(reseeded.builtin).toBe(true)
    expect(reseeded.purpose).toBe('review')
    expect(reseeded.agentKinds).toEqual(seeded.agentKinds)
    expect(reseeded.version).toBe(seeded.version)
    // It is now persisted, so a subsequent list surfaces it.
    expect(store.get(REVIEW_PIPELINE_ID)?.id).toBe(REVIEW_PIPELINE_ID)
  })

  it('reseeds an existing built-in in place, preserving its labels + archive state', async () => {
    const store = new Map<string, Pipeline>()
    const service = svc(store)
    // Seed the built-in, then organize it (user-owned metadata reseed must keep).
    await service.reseed(WS, REVIEW_PIPELINE_ID)
    await service.organize(WS, REVIEW_PIPELINE_ID, { labels: ['mine'], archived: true })
    const reseeded = await service.reseed(WS, REVIEW_PIPELINE_ID)
    expect(reseeded.labels).toEqual(['mine'])
    expect(reseeded.archived).toBe(true)
    expect(reseeded.builtin).toBe(true)
  })

  it('rejects reseeding an id absent from the catalog', async () => {
    await expect(svc().reseed(WS, 'pl_does_not_exist')).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects reseeding a stored custom pipeline (delete it instead)', async () => {
    const store = new Map<string, Pipeline>()
    // A custom pipeline that happens to collide with a catalog id (impossible via `create`,
    // which mints `pl_<n>` ids, but pinned here to lock the "only built-ins reseed" guard).
    store.set(REVIEW_PIPELINE_ID, {
      id: REVIEW_PIPELINE_ID,
      name: 'Custom clash',
      agentKinds: ['coder'],
    } as Pipeline)
    await expect(svc(store).reseed(WS, REVIEW_PIPELINE_ID)).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('PipelineService — retirement (removing a built-in that is no longer relevant)', () => {
  const RETIRED = 'pl_org_legacy'

  /** A registry whose `RETIRED` pipeline has been withdrawn in favour of a live built-in. */
  function retiringRegistry(): PipelineRegistry {
    const registry = new PipelineRegistry()
    registry.retire(RETIRED, { replacedBy: REVIEW_PIPELINE_ID })
    return registry
  }

  function svc(store: Map<string, Pipeline>, opts: Partial<PipelineServiceDependencies> = {}) {
    return new PipelineService({
      workspaceRepository: workspaceRepo(),
      pipelineRepository: pipelineRepo(store),
      idGenerator,
      ...opts,
    })
  }

  /** A workspace seeded with the pipeline BEFORE it was retired — the only state this feature acts on. */
  function storeWithRetiredCopy(): Map<string, Pipeline> {
    return new Map<string, Pipeline>([
      [
        RETIRED,
        {
          id: RETIRED,
          name: 'Legacy org flow',
          purpose: 'build',
          agentKinds: ['coder'],
          builtin: true,
        },
      ],
    ])
  }

  function scheduleRepo(pipelineIds: string[]): PipelineScheduleRepository {
    return {
      list: async () => pipelineIds.map((pipelineId, i) => ({ id: `sch_${i}`, pipelineId })),
    } as unknown as PipelineScheduleRepository
  }

  it('deletes a retired built-in from a workspace that was seeded with it', async () => {
    const store = storeWithRetiredCopy()
    await svc(store, { pipelineRegistry: retiringRegistry() }).remove(WS, RETIRED)
    expect(store.has(RETIRED)).toBe(false)
  })

  it('still refuses to delete a LIVE built-in', async () => {
    // Retirement is the deletion's authorization, so the read-only guarantee is untouched for
    // every pipeline the catalog still ships — otherwise this feature would be a way to empty
    // the curated palette.
    const store = new Map<string, Pipeline>([
      [REVIEW_PIPELINE_ID, seedPipelines().find((p) => p.id === REVIEW_PIPELINE_ID)!],
    ])
    await expect(
      svc(store, { pipelineRegistry: retiringRegistry() }).remove(WS, REVIEW_PIPELINE_ID),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(store.has(REVIEW_PIPELINE_ID)).toBe(true)
  })

  it('refuses to delete a built-in whose retirement this deployment does not declare', async () => {
    // The stored row is identical either way; without the tombstone there is nothing saying the
    // pipeline is obsolete, so an unwired registry must not read as "everything is retired".
    const store = storeWithRetiredCopy()
    await expect(svc(store).remove(WS, RETIRED)).rejects.toBeInstanceOf(ValidationError)
    expect(store.has(RETIRED)).toBe(true)
  })

  it('refuses to delete a pipeline a recurring schedule still points at', async () => {
    // Every future fire resolves the pipeline by id, so deleting it would break the schedule
    // silently — the failure only shows up as work that quietly stopped happening. The refusal
    // carries `details.reason`, not just prose: the SPA maps that to translated remedy copy, and
    // the raw message is English-only.
    const store = storeWithRetiredCopy()
    await expect(
      svc(store, {
        pipelineRegistry: retiringRegistry(),
        pipelineScheduleRepository: scheduleRepo([RETIRED]),
      }).remove(WS, RETIRED),
    ).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'pipeline_schedule_attached' },
    })
    expect(store.has(RETIRED)).toBe(true)
  })

  it('blocks the delete on a DISABLED schedule too', async () => {
    // `enabled` is a pause button, not a detach: filtering on it would let the delete strand a
    // schedule whose owner re-enables it later, and the breakage would then look like the
    // re-enable's fault rather than this deletion's.
    const store = storeWithRetiredCopy()
    const paused = {
      list: async () => [{ id: 'sch_0', pipelineId: RETIRED, enabled: false }],
    } as unknown as PipelineScheduleRepository
    await expect(
      svc(store, {
        pipelineRegistry: retiringRegistry(),
        pipelineScheduleRepository: paused,
      }).remove(WS, RETIRED),
    ).rejects.toBeInstanceOf(ConflictError)
    expect(store.has(RETIRED)).toBe(true)
  })

  it('guards a CUSTOM pipeline against the same stranded schedule', async () => {
    const store = new Map<string, Pipeline>([
      ['pl_1', { id: 'pl_1', name: 'Mine', purpose: 'build', agentKinds: ['coder'] }],
    ])
    await expect(
      svc(store, { pipelineScheduleRepository: scheduleRepo(['pl_1']) }).remove(WS, 'pl_1'),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  it('deletes when the workspace schedules point at OTHER pipelines', async () => {
    const store = storeWithRetiredCopy()
    await svc(store, {
      pipelineRegistry: retiringRegistry(),
      pipelineScheduleRepository: scheduleRepo(['pl_bug_triage']),
    }).remove(WS, RETIRED)
    expect(store.has(RETIRED)).toBe(false)
  })

  it('refuses to reseed a retired built-in, pointing at removal instead', async () => {
    // Reseed and remove are the two halves of one lifecycle and must never both claim an id: the
    // catalog has nothing left to restore this from, so the error has to name the other action.
    const store = storeWithRetiredCopy()
    await expect(
      svc(store, { pipelineRegistry: retiringRegistry() }).reseed(WS, RETIRED),
    ).rejects.toThrow(/retired/i)
  })
})
