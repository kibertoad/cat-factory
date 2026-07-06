import type {
  Block,
  BlockRepository,
  Initiative,
  InitiativePresetRegistration,
  InitiativeRepository,
  Workspace,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import {
  NoopEventPublisher,
  ValidationError,
  clearRegisteredInitiativePresets,
  registerInitiativePreset,
} from '@cat-factory/kernel'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InitiativeService } from './InitiativeService.js'

// The create flow's preset resolution + validation + skip-interview seeding, over in-memory
// fakes. Persistence parity (the entity's `presetId`/`presetInputs`/`qa` round-tripping on both
// stores) is covered by the conformance suite; here we pin the pure create behaviour: absent
// preset ⇒ today's behaviour, an unknown / invalid preset ⇒ ValidationError, and a valid
// skip-interview preset ⇒ frozen inputs + a qa digest seeded from the form.

let clockNow = 1_000
const clock = { now: () => clockNow }
let idSeq = 0
const idGenerator = { next: (prefix: string) => `${prefix}-${++idSeq}` }

const frame: Block = {
  id: 'frame-1',
  title: 'Service',
  type: 'service',
  description: '',
  position: { x: 0, y: 0 },
  status: 'ready',
  progress: 0,
  dependsOn: [],
  executionId: null,
  level: 'frame',
  parentId: null,
}

function makeService() {
  const initiatives = new Map<string, Initiative>()
  const blocks = new Map<string, Block>([[frame.id, frame]])
  const workspaceRepository = {
    get: async (id: string) => ({ id, name: 'WS' }) as unknown as Workspace,
  } as unknown as WorkspaceRepository
  const blockRepository = {
    get: async (_ws: string, id: string) => blocks.get(id) ?? null,
    listByWorkspace: async () => [...blocks.values()],
    insert: async (_ws: string, block: Block) => {
      blocks.set(block.id, block)
    },
  } as unknown as BlockRepository
  const initiativeRepository = {
    list: async () => [...initiatives.values()],
    insert: async (_ws: string, entity: Initiative) => {
      initiatives.set(entity.id, entity)
    },
    get: async (_ws: string, id: string) => initiatives.get(id) ?? null,
    getByBlock: async (_ws: string, blockId: string) =>
      [...initiatives.values()].find((i) => i.blockId === blockId) ?? null,
    compareAndSwap: async (_ws: string, next: Initiative, expectedRev: number) => {
      const cur = initiatives.get(next.id)
      if (!cur || cur.rev !== expectedRev) return false
      initiatives.set(next.id, next)
      return true
    },
  } as unknown as InitiativeRepository
  const service = new InitiativeService({
    workspaceRepository,
    blockRepository,
    initiativeRepository,
    events: new NoopEventPublisher(),
    clock,
    idGenerator,
  })
  return { service, initiatives }
}

const DOCS_PRESET_ID = 'preset_test_docs'
function registerDocsPreset() {
  registerInitiativePreset({
    descriptor: {
      id: DOCS_PRESET_ID,
      presentation: {
        label: 'Documentation refresh',
        icon: 'i-lucide-book',
        color: '#000',
        description: 'Audit and refresh the service documentation.',
      },
      fields: [
        {
          key: 'docTypes',
          label: 'Documentation types',
          type: 'checkbox-group',
          required: true,
          options: [
            { value: 'readme', label: 'READMEs' },
            { value: 'diagrams', label: 'Mermaid diagrams' },
          ],
        },
        { key: 'docsRoot', label: 'Docs root', type: 'path' },
        // Hidden unless `diagrams` is selected — its stale value must never freeze unvalidated.
        {
          key: 'diagramsDir',
          label: 'Diagrams dir',
          type: 'path',
          showWhen: { key: 'docTypes', includes: 'diagrams' },
        },
      ],
      planningPipelineId: 'pl_initiative_docs',
      interview: 'skip',
      humanReviewDefault: false,
      defaultFragmentIds: [],
    },
  })
}

describe('InitiativeService.create — presets', () => {
  beforeEach(() => {
    idSeq = 0
    clockNow = 1_000
    clearRegisteredInitiativePresets()
  })
  afterEach(() => clearRegisteredInitiativePresets())

  it('absent presetId keeps today behaviour byte-for-byte (no preset fields, empty qa)', async () => {
    const { service } = makeService()
    const { initiative } = await service.create('ws-1', {
      frameId: frame.id,
      title: 'Migrate auth',
      description: 'the goal',
    })
    expect(initiative.presetId).toBeUndefined()
    expect(initiative.presetInputs).toBeUndefined()
    expect(initiative.qa).toEqual([])
    expect(initiative.goal).toBe('the goal')
  })

  it('rejects an unknown preset id at create (nothing is written)', async () => {
    const { service } = makeService()
    await expect(
      service.create('ws-1', {
        frameId: frame.id,
        title: 'X',
        description: '',
        presetId: 'preset_nope',
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects a form that fails the descriptor validation', async () => {
    registerDocsPreset()
    const { service } = makeService()
    // `docTypes` is required, and an empty multi-select counts as unset.
    await expect(
      service.create('ws-1', {
        frameId: frame.id,
        title: 'Docs',
        description: '',
        presetId: DOCS_PRESET_ID,
        presetInputs: { docTypes: [] },
      }),
    ).rejects.toBeInstanceOf(ValidationError)
    // A path escaping the repo is also rejected.
    await expect(
      service.create('ws-1', {
        frameId: frame.id,
        title: 'Docs',
        description: '',
        presetId: DOCS_PRESET_ID,
        presetInputs: { docTypes: ['readme'], docsRoot: '../etc' },
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('persists the frozen inputs and seeds the qa digest for a skip-interview preset', async () => {
    registerDocsPreset()
    const { service } = makeService()
    const presetInputs = { docTypes: ['readme', 'diagrams'], docsRoot: 'docs/' }
    const { initiative } = await service.create('ws-1', {
      frameId: frame.id,
      title: 'Docs refresh',
      description: '',
      presetId: DOCS_PRESET_ID,
      presetInputs,
    })
    expect(initiative.presetId).toBe(DOCS_PRESET_ID)
    expect(initiative.presetInputs).toEqual(presetInputs)
    // The form becomes the interview digest (label → rendered value), each with a stable id.
    expect(initiative.qa).toEqual([
      {
        id: expect.stringMatching(/^iqa-/),
        question: 'Documentation types',
        answer: 'READMEs, Mermaid diagrams',
      },
      { id: expect.stringMatching(/^iqa-/), question: 'Docs root', answer: 'docs/' },
    ])
    // No human description ⇒ the goal is templated from the preset's stated purpose.
    expect(initiative.goal).toBe('Audit and refresh the service documentation.')
  })

  it("a human description wins over the preset's templated goal", async () => {
    registerDocsPreset()
    const { service } = makeService()
    const { initiative } = await service.create('ws-1', {
      frameId: frame.id,
      title: 'Docs refresh',
      description: 'Only the payments service docs',
      presetId: DOCS_PRESET_ID,
      presetInputs: { docTypes: ['readme'] },
    })
    expect(initiative.goal).toBe('Only the payments service docs')
  })

  it('does NOT persist presetInputs when no presetId is given (orphan form data is dropped)', async () => {
    const { service } = makeService()
    const { initiative } = await service.create('ws-1', {
      frameId: frame.id,
      title: 'Migrate auth',
      description: 'the goal',
      // A form posted with no preset is meaningless — and never validated — so it must not freeze.
      presetInputs: { docsRoot: '../../secret' },
    })
    expect(initiative.presetId).toBeUndefined()
    expect(initiative.presetInputs).toBeUndefined()
  })

  it('drops a hidden field from the frozen inputs so its unvalidated value never lands', async () => {
    registerDocsPreset()
    const { service } = makeService()
    // `diagramsDir` is hidden (no `diagrams` selected), so its unsafe traversal value is NOT
    // validated — and must therefore be sanitized out of the persisted inputs rather than frozen.
    const { initiative } = await service.create('ws-1', {
      frameId: frame.id,
      title: 'Docs refresh',
      description: '',
      presetId: DOCS_PRESET_ID,
      presetInputs: { docTypes: ['readme'], docsRoot: 'docs/', diagramsDir: '../../etc' },
    })
    expect(initiative.presetInputs).toEqual({ docTypes: ['readme'], docsRoot: 'docs/' })
    // ...and the escaping path is nowhere on the entity.
    expect(JSON.stringify(initiative.presetInputs)).not.toContain('..')
  })
})

describe('InitiativeService.ingestPlan — seedPlan (slice 5)', () => {
  beforeEach(() => {
    idSeq = 0
    clockNow = 1_000
    clearRegisteredInitiativePresets()
  })
  afterEach(() => clearRegisteredInitiativePresets())

  const PRESET_ID = 'preset_seedplan_test'

  /** Register a skip-interview preset whose optional `seedPlan` post-processes the draft. */
  function registerSeedingPreset(seedPlan?: InitiativePresetRegistration['seedPlan']) {
    registerInitiativePreset({
      descriptor: {
        id: PRESET_ID,
        presentation: { label: 'Seeding preset', icon: 'i', color: '#000', description: 'x' },
        fields: [{ key: 'docsRoot', label: 'Docs root', type: 'path' }],
        planningPipelineId: 'pl_initiative',
        interview: 'skip',
        humanReviewDefault: false,
        defaultFragmentIds: [],
      },
      seedPlan,
    })
  }

  /** A minimal well-formed planner draft (no pipeline repo wired ⇒ pipeline ids aren't checked). */
  const draft = {
    goal: 'g',
    phases: [{ id: 'p1', title: 'Phase' }],
    items: [{ id: 'i1', phaseId: 'p1', title: 'Item 1', description: 'd' }],
    policy: { maxConcurrent: 2, defaultPipelineId: 'pl_full' },
  }

  async function seedInitiative(
    service: InitiativeService,
    presetInputs: Record<string, unknown>,
  ): Promise<string> {
    const { block } = await service.create('ws-1', {
      frameId: frame.id,
      title: 'Seed',
      description: '',
      presetId: PRESET_ID,
      presetInputs: presetInputs as never,
    })
    return block.id
  }

  it("runs the preset's seedPlan over the draft, stamping item spawn decoration from the frozen inputs", async () => {
    // The essence of the docs-refresh pilot: seedPlan derives each item's typed-task decoration
    // from the frozen form (here the `docsRoot`) — exercised generically over an arbitrary preset.
    registerSeedingPreset((d, inputs) => ({
      ...d,
      items: d.items.map((it) => ({
        ...it,
        spawn: {
          taskType: 'document' as const,
          taskTypeFields: { docKind: 'reference' as const, targetPath: `${inputs.docsRoot}api.md` },
          fragmentIds: ['style.anti-llmisms'],
        },
      })),
    }))
    const { service } = makeService()
    const blockId = await seedInitiative(service, { docsRoot: 'docs/' })

    const ingested = await service.ingestPlan('ws-1', blockId, draft)

    expect(ingested!.items![0]!.spawn).toEqual({
      taskType: 'document',
      taskTypeFields: { docKind: 'reference', targetPath: 'docs/api.md' },
      fragmentIds: ['style.anti-llmisms'],
    })
  })

  it('rejects a seedPlan that emits an unsafe spawn targetPath (path-safety re-validation)', async () => {
    // seedPlan is trusted code, but its output is RE-PARSED through the strict schema, so a hook
    // bug can't persist a spawn `targetPath` escaping the repo — `isSafeDocPath` fails the ingest.
    registerSeedingPreset((d) => ({
      ...d,
      items: d.items.map((it) => ({
        ...it,
        spawn: { taskTypeFields: { targetPath: '../../etc/passwd.md' } },
      })),
    }))
    const { service } = makeService()
    const blockId = await seedInitiative(service, { docsRoot: 'docs/' })

    await expect(service.ingestPlan('ws-1', blockId, draft)).rejects.toThrow()
  })

  it('applies the draft unchanged when the preset has no seedPlan hook', async () => {
    registerSeedingPreset() // no hook
    const { service } = makeService()
    const blockId = await seedInitiative(service, { docsRoot: 'docs/' })

    const ingested = await service.ingestPlan('ws-1', blockId, draft)

    expect(ingested!.items![0]!.spawn).toBeUndefined()
    expect(ingested!.items![0]!.title).toBe('Item 1')
  })

  it('rejects a planner draft whose spawn targetPath escapes the repo (initial trust boundary)', async () => {
    // No seedPlan needed — the FIRST parse of the raw planner draft rejects the unsafe path.
    registerSeedingPreset()
    const { service } = makeService()
    const blockId = await seedInitiative(service, { docsRoot: 'docs/' })
    const badDraft = {
      ...draft,
      items: [{ ...draft.items[0], spawn: { taskTypeFields: { targetPath: '/etc/passwd.md' } } }],
    }

    await expect(service.ingestPlan('ws-1', blockId, badDraft)).rejects.toThrow()
  })
})
