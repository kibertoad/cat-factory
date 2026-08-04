import { describe, expect, it } from 'vitest'
import { PipelineRegistry, REVIEW_PIPELINE_ID, seedPipelines } from '@cat-factory/kernel'
import type { Pipeline, PipelineRepository } from '@cat-factory/kernel'
import { adoptedCatalogRow, createPipelineAdoption } from './pipelineAdoption.js'

const WS = 'ws_1'

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
    delete: async (_ws, id) => void store.delete(id),
  }
  return { repository, store, inserts }
}

function orgRegistry(pipeline: Partial<Pipeline> & { id: string }): PipelineRegistry {
  const registry = new PipelineRegistry()
  registry.register({ name: 'Org flow', agentKinds: ['coder'], ...pipeline })
  return registry
}

describe('pipelineAdoption', () => {
  it('returns the stored row untouched when the workspace already holds one', async () => {
    // The hot path, and the precedence that matters: a workspace's own copy is authoritative, so
    // adoption must never overwrite a row with the code definition (labels and archive state are
    // the workspace's, and a reseed is the only thing allowed to move a stored copy forward).
    const { repository, inserts } = repo(
      new Map([
        [
          REVIEW_PIPELINE_ID,
          {
            id: REVIEW_PIPELINE_ID,
            name: 'Mine',
            agentKinds: ['coder'],
            builtin: true,
            version: 1,
            labels: ['team'],
          },
        ],
      ]),
    )
    const adoption = createPipelineAdoption({ pipelineRepository: repository })
    const resolved = await adoption.adoptForRun(WS, REVIEW_PIPELINE_ID)
    expect(resolved?.name).toBe('Mine')
    expect(resolved?.labels).toEqual(['team'])
    expect(inserts).toEqual([])
  })

  it('adopts a BUILT-IN catalog pipeline the workspace was never seeded with', async () => {
    const { repository, store } = repo()
    const adoption = createPipelineAdoption({ pipelineRepository: repository })
    const resolved = await adoption.adoptForRun(WS, REVIEW_PIPELINE_ID)
    const seed = seedPipelines().find((p) => p.id === REVIEW_PIPELINE_ID)!
    expect(resolved?.agentKinds).toEqual(seed.agentKinds)
    expect(resolved?.version).toBe(seed.version)
    // The write is what makes the run honest: the board's library now lists what ran.
    expect(store.get(REVIEW_PIPELINE_ID)?.builtin).toBe(true)
  })

  it('adopts a DEPLOYMENT-registered built-in, which is the reusable-operation case', async () => {
    const { repository, store } = repo()
    const adoption = createPipelineAdoption({
      pipelineRepository: repository,
      pipelineRegistry: orgRegistry({ id: 'pl_org_op', builtin: true, version: 2 }),
    })
    expect((await adoption.adoptForRun(WS, 'pl_org_op'))?.version).toBe(2)
    expect(store.has('pl_org_op')).toBe(true)
  })

  it('refuses to adopt a VERSIONLESS registered pipeline, which a workspace may have deleted', async () => {
    // The safety argument for the `builtin` restriction: a versionless registered pipeline is
    // editable AND deletable by the workspace, so "no row" is ambiguous between never-adopted and
    // deliberately-removed. Adopting one would resurrect the deletion, and with the code definition
    // rather than whatever the workspace had edited it into.
    const { repository, store } = repo()
    const adoption = createPipelineAdoption({
      pipelineRepository: repository,
      pipelineRegistry: orgRegistry({ id: 'pl_org_editable' }),
    })
    expect(await adoption.adoptForRun(WS, 'pl_org_editable')).toBeNull()
    expect(await adoption.resolveDefinition(WS, 'pl_org_editable')).toBeNull()
    expect(store.size).toBe(0)
  })

  it('resolves nothing for an id no catalog defines, and writes nothing', async () => {
    const { repository, inserts } = repo()
    const adoption = createPipelineAdoption({ pipelineRepository: repository })
    expect(await adoption.adoptForRun(WS, 'pl_17')).toBeNull()
    expect(await adoption.resolveDefinition(WS, 'pl_17')).toBeNull()
    expect(inserts).toEqual([])
  })

  it('resolveDefinition answers the catalog entry WITHOUT adopting it', async () => {
    // The read-only twin, for a question about a prospective run (the personal-credential gate).
    // It must agree with `adoptForRun` about WHAT would run, and differ only in writing.
    const { repository, store } = repo()
    const adoption = createPipelineAdoption({ pipelineRepository: repository })
    const peeked = await adoption.resolveDefinition(WS, REVIEW_PIPELINE_ID)
    expect(peeked?.id).toBe(REVIEW_PIPELINE_ID)
    expect(peeked?.agentKinds.length).toBeGreaterThan(0)
    expect(store.size).toBe(0)
  })

  it('is idempotent under concurrent adoption, leaving one row', async () => {
    // Two tasks of one operation started at once: both see no row and both insert. First write
    // wins, and because both write the same catalog definition the loser has nothing to report.
    const { repository, store, inserts } = repo()
    const adoption = createPipelineAdoption({ pipelineRepository: repository })
    const [a, b] = await Promise.all([
      adoption.adoptForRun(WS, REVIEW_PIPELINE_ID),
      adoption.adoptForRun(WS, REVIEW_PIPELINE_ID),
    ])
    expect(a).toEqual(b)
    expect(inserts).toHaveLength(2)
    expect(store.size).toBe(1)
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
})
