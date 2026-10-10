import { describe, expect, it } from 'vitest'
import {
  createOperationalMetricsCollector,
  PipelineRegistry,
  REVIEW_PIPELINE_ID,
  seedPipelines,
} from '@cat-factory/kernel'
import type { Pipeline, PipelineRepository } from '@cat-factory/kernel'
import {
  adoptedCatalogRow,
  createPipelineAdoption,
  insertedCatalogRow,
} from './pipelineAdoption.js'

const WS = 'ws_1'
const UNATTENDED_ID = 'pl_unattended'

/** A store whose `insertIfAbsent` is first-write-wins, matching both real repositories. */
function repo(store = new Map<string, Pipeline>()) {
  const inserts: string[] = []
  const repository: PipelineRepository = {
    listByWorkspace: async () => [...store.values()],
    get: async (_ws, id) => store.get(id) ?? null,
    insert: async (_ws, p) => void store.set(p.id, p),
    insertIfAbsent: async (_ws, p) => {
      inserts.push(p.id)
      if (!store.has(p.id)) store.set(p.id, p)
    },
    update: async (_ws, p) => void store.set(p.id, p),
    setDefault: async (_ws, id, scope, claimed) => {
      const field = scope === 'unattended' ? 'isUnattendedDefault' : 'isDefault'
      const target = store.get(id)
      if (!target) return
      // A RELEASE clears the named row only; a PROMOTE demotes every incumbent first (see the port).
      if (!claimed) return void store.set(id, { ...target, [field]: undefined })
      for (const [key, row] of store) store.set(key, { ...row, [field]: undefined })
      store.set(id, { ...target, [field]: true })
    },
    delete: async (_ws, id) => void store.delete(id),
  }
  return { repository, store, inserts }
}

/**
 * The collaborator over a fake store, with a REAL metrics collector so every case can assert what
 * the deployment would export rather than only what the workspace holds.
 */
function subject(options: { store?: Map<string, Pipeline>; registry?: PipelineRegistry } = {}) {
  const { repository, store, inserts } = repo(options.store)
  const metrics = createOperationalMetricsCollector()
  const adoption = createPipelineAdoption({
    pipelineRepository: repository,
    pipelineRegistry: options.registry,
    operationalMetrics: metrics,
  })
  /** How many `pipeline.adopted` events a flush would carry (absent ⇒ nothing was reported). */
  const adopted = () =>
    metrics
      .drain()
      .filter((s) => s.counter === 'pipeline.adopted')
      .reduce((total, s) => total + s.value, 0)
  return { adoption, store, inserts, adopted }
}

function orgRegistry(pipeline: Partial<Pipeline> & { id: string }): PipelineRegistry {
  const registry = new PipelineRegistry()
  registry.register({ name: 'Org flow', purpose: 'build', agentKinds: ['coder'], ...pipeline })
  return registry
}

describe('pipelineAdoption', () => {
  it('returns the stored row untouched when the workspace already holds one', async () => {
    // The hot path, and the precedence that matters: a workspace's own copy is authoritative, so
    // adoption must never overwrite a row with the code definition (labels and archive state are
    // the workspace's, and a reseed is the only thing allowed to move a stored copy forward).
    const { adoption, inserts, adopted } = subject({
      store: new Map([
        [
          REVIEW_PIPELINE_ID,
          {
            id: REVIEW_PIPELINE_ID,
            name: 'Mine',
            purpose: 'review' as const,
            agentKinds: ['coder'],
            builtin: true,
            version: 1,
            labels: ['team'],
          },
        ],
      ]),
    })
    const resolved = await adoption.adoptForRun(WS, REVIEW_PIPELINE_ID)
    expect(resolved?.name).toBe('Mine')
    expect(resolved?.labels).toEqual(['team'])
    expect(inserts).toEqual([])
    // A board that was already current is not an adoption. Counting the resolve instead would turn
    // the metric into a run counter and bury the signal it exists for.
    expect(adopted()).toBe(0)
  })

  it('adopts a BUILT-IN catalog pipeline the workspace was never seeded with', async () => {
    const { adoption, store, adopted } = subject()
    const resolved = await adoption.adoptForRun(WS, REVIEW_PIPELINE_ID)
    const seed = seedPipelines().find((p) => p.id === REVIEW_PIPELINE_ID)!
    expect(resolved?.agentKinds).toEqual(seed.agentKinds)
    expect(resolved?.version).toBe(seed.version)
    // The write is what makes the run honest: the board's library now lists what ran.
    expect(store.get(REVIEW_PIPELINE_ID)?.builtin).toBe(true)
    expect(adopted()).toBe(1)
  })

  it('adopts a DEPLOYMENT-registered built-in, which is the reusable-operation case', async () => {
    const { adoption, store } = subject({
      registry: orgRegistry({ id: 'pl_org_op', builtin: true, version: 2 }),
    })
    expect((await adoption.adoptForRun(WS, 'pl_org_op'))?.version).toBe(2)
    expect(store.has('pl_org_op')).toBe(true)
  })

  it('refuses to adopt a VERSIONLESS registered pipeline, which a workspace may have deleted', async () => {
    // The safety argument for the `builtin` restriction: a versionless registered pipeline is
    // editable AND deletable by the workspace, so "no row" is ambiguous between never-adopted and
    // deliberately-removed. Adopting one would resurrect the deletion, and with the code definition
    // rather than whatever the workspace had edited it into.
    const { adoption, store } = subject({ registry: orgRegistry({ id: 'pl_org_editable' }) })
    expect(await adoption.adoptForRun(WS, 'pl_org_editable')).toBeNull()
    expect(await adoption.resolveDefinition(WS, 'pl_org_editable')).toBeNull()
    expect(adoption.adoptableCatalog().has('pl_org_editable')).toBe(false)
    expect(store.size).toBe(0)
  })

  it('resolves nothing for an id no catalog defines, and writes nothing', async () => {
    const { adoption, inserts, adopted } = subject()
    expect(await adoption.adoptForRun(WS, 'pl_17')).toBeNull()
    expect(await adoption.resolveDefinition(WS, 'pl_17')).toBeNull()
    expect(inserts).toEqual([])
    expect(adopted()).toBe(0)
  })

  it('resolveDefinition answers the catalog entry WITHOUT adopting it', async () => {
    // The read-only twin, for a question about a prospective run (the personal-credential gate,
    // and the public API's admission checks). It must agree with `adoptForRun` about WHAT would
    // run, and differ only in writing.
    const { adoption, store, adopted } = subject()
    const peeked = await adoption.resolveDefinition(WS, REVIEW_PIPELINE_ID)
    expect(peeked?.id).toBe(REVIEW_PIPELINE_ID)
    expect(peeked?.agentKinds.length).toBeGreaterThan(0)
    expect(store.size).toBe(0)
    expect(adopted()).toBe(0)
  })

  it('is idempotent under concurrent adoption, leaving one row', async () => {
    // Two tasks of one operation started at once: both see no row and both insert. First write
    // wins, and because both write the same catalog definition the loser has nothing to report.
    const { adoption, store, inserts } = subject()
    const [a, b] = await Promise.all([
      adoption.adoptForRun(WS, REVIEW_PIPELINE_ID),
      adoption.adoptForRun(WS, REVIEW_PIPELINE_ID),
    ])
    expect(a).toEqual(b)
    expect(inserts).toHaveLength(2)
    expect(store.size).toBe(1)
  })

  it('lists every adoptable catalog entry, and only the adoptable ones, without reading rows', async () => {
    // The bulk read a caller uses when it ALREADY holds the workspace's whole pipeline list (the
    // post-merge auto-start's dependent loop), where a point read per miss would be a banned N+1.
    // It must agree with `resolveDefinition` on membership, or auto-start and a manual start would
    // disagree about which pins are launchable.
    const registry = orgRegistry({ id: 'pl_org_op', builtin: true, version: 2 })
    registry.register({
      id: 'pl_org_editable',
      name: 'Editable',
      purpose: 'build',
      agentKinds: ['coder'],
    })
    const { adoption, store } = subject({ registry })
    const catalog = adoption.adoptableCatalog()
    expect(catalog.get('pl_org_op')?.version).toBe(2)
    expect(catalog.get(REVIEW_PIPELINE_ID)?.builtin).toBe(true)
    // Derived from the same source the code reads rather than pinned to a total: the property is
    // that every built-in the catalog yields is adoptable and nothing else is, so shipping one more
    // built-in must not fail this test.
    expect([...catalog.keys()].sort()).toEqual(
      seedPipelines(registry)
        .filter((p) => p.builtin)
        .map((p) => p.id)
        .sort(),
    )
    expect(store.size).toBe(0)
  })

  it('carries a workspace’s own organizational metadata across a catalog row rebuild', async () => {
    // `adoptedCatalogRow` is shared with `PipelineService.reseed`, so the two cannot produce
    // different rows for one catalog entry. Labels and archive state are the workspace's.
    const seed = seedPipelines().find((p) => p.id === REVIEW_PIPELINE_ID)!
    const fresh = adoptedCatalogRow(seed)
    expect(fresh.labels).toBeUndefined()
    expect(fresh.archived).toBeUndefined()
    const kept = adoptedCatalogRow(seed, { ...seed, labels: ['mine'], archived: true })
    expect(kept.labels).toEqual(['mine'])
    expect(kept.archived).toBe(true)
    expect(kept.agentKinds).toEqual(seed.agentKinds)
  })

  // The two default claims are `setDefault`'s to write, so a rebuilt row states what the STORE
  // holds. Carrying the catalog's own claim across an UPDATE would re-announce a rung the operator
  // had released, on a write path (`update`) that does not touch those columns at all.
  it('states the stored default claims on a rebuilt row, never the catalog’s', () => {
    const seed = seedPipelines().find((p) => p.id === UNATTENDED_ID)!
    expect(seed.isUnattendedDefault).toBe(true)
    expect(adoptedCatalogRow(seed).isUnattendedDefault).toBeUndefined()
    expect(
      adoptedCatalogRow(seed, { ...seed, isUnattendedDefault: undefined }).isUnattendedDefault,
    ).toBeUndefined()
    expect(
      adoptedCatalogRow(seed, { ...seed, isUnattendedDefault: true }).isUnattendedDefault,
    ).toBe(true)
  })

  // A FIRST copy is the one insert that may carry the claim, and only where the workspace has not
  // answered the scope. `defaultPipelineIdForScope` stops consulting the catalog once a row exists,
  // so dropping it unconditionally would make the first headless start work and the second refuse.
  it('carries the catalog claim into a workspace that declared no holder', () => {
    const seed = seedPipelines().find((p) => p.id === UNATTENDED_ID)!
    expect(insertedCatalogRow(seed, []).isUnattendedDefault).toBe(true)
  })

  // And drops it where the workspace HAS one: the partial unique index keeps a single holder per
  // scope, and `insertIfAbsent` conflicts only on `(workspace_id, id)`, so the claim would surface
  // as a raw constraint error on a plain reseed or on a run that merely PINS this rung.
  it('drops the catalog claim where the workspace already declared a holder', () => {
    const seed = seedPipelines().find((p) => p.id === UNATTENDED_ID)!
    const mine = { ...seed, id: 'pl_mine', isUnattendedDefault: true }
    expect(insertedCatalogRow(seed, [mine]).isUnattendedDefault).toBeUndefined()
  })

  it('adopts a pinned rung without disturbing the workspace’s own default', async () => {
    const mine: Pipeline = {
      id: 'pl_mine',
      name: 'Mine',
      purpose: 'build',
      agentKinds: ['coder'],
      isUnattendedDefault: true,
    } as Pipeline
    const store = new Map<string, Pipeline>([['pl_mine', mine]])
    const { repository, inserts } = repo(store)
    const adoption = createPipelineAdoption({
      pipelineRepository: repository,
      operationalMetrics: createOperationalMetricsCollector(),
    })
    const adopted = await adoption.adoptForRun(WS, UNATTENDED_ID)
    expect(adopted?.id).toBe(UNATTENDED_ID)
    expect(inserts).toEqual([UNATTENDED_ID])
    expect([...store.values()].filter((p) => p.isUnattendedDefault).map((p) => p.id)).toEqual([
      'pl_mine',
    ])
  })
})
