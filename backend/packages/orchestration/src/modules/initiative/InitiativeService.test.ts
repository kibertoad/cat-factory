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

const FULL_PRESET_ID = 'preset_test_migration'
/** A FULL-interview preset with a form — its filled fields seed the qa for the interviewer (T3). */
function registerFullPreset() {
  registerInitiativePreset({
    descriptor: {
      id: FULL_PRESET_ID,
      presentation: {
        label: 'Technological migration',
        icon: 'i-lucide-database',
        color: '#000',
        description: 'Swap a load-bearing technology behind a safety net.',
      },
      fields: [
        { key: 'fromTech', label: 'From', type: 'text', required: true },
        { key: 'toTech', label: 'To', type: 'text', required: true },
      ],
      planningPipelineId: 'pl_initiative',
      interview: 'full',
      humanReviewDefault: true,
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

  it('seeds the qa digest from the form for a FULL-interview preset (interviewer builds on it)', async () => {
    registerFullPreset()
    const { service } = makeService()
    const { initiative } = await service.create('ws-1', {
      frameId: frame.id,
      title: 'Migrate DB',
      description: '',
      presetId: FULL_PRESET_ID,
      presetInputs: { fromTech: 'MSSQL', toTech: 'PostgreSQL 16' },
    })
    // The full-interview form is folded into the qa (T3), so the interviewer starts from it rather
    // than re-asking the enumerable facts the form already captured.
    expect(initiative.qa).toEqual([
      { id: expect.stringMatching(/^iqa-/), question: 'From', answer: 'MSSQL' },
      { id: expect.stringMatching(/^iqa-/), question: 'To', answer: 'PostgreSQL 16' },
    ])
    // A full-interview preset does NOT template the goal from its description (the interviewer
    // synthesizes it), so with no human description the goal stays blank until the interview converges.
    expect(initiative.goal).toBe('')
  })

  it('a full-interview preset with no fields (preset_generic) seeds no qa and is unchanged', async () => {
    // preset_generic is interview:'full' with an EMPTY form, so the T3 seeding is a no-op — its
    // behaviour is byte-for-byte today's (empty qa, goal = the human description, no frozen inputs).
    const { service } = makeService()
    const { initiative } = await service.create('ws-1', {
      frameId: frame.id,
      title: 'Open-ended work',
      description: 'the goal',
      presetId: 'preset_generic',
    })
    expect(initiative.presetId).toBe('preset_generic')
    expect(initiative.presetInputs).toBeUndefined()
    expect(initiative.qa).toEqual([])
    expect(initiative.goal).toBe('the goal')
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

// The phase-template SHAPE step and the `seedPlan` DECORATION hook compose in `seedPlanDraft`:
// normalize runs FIRST (so the hook sees template-ordered phases) and AGAIN over the hook's output
// (so a hook can't bypass plan shape). Pins that ordering contract — it is invisible to the pure
// normalizer's own unit tests and to the conformance suite (whose template preset has no seedPlan).
describe('InitiativeService.ingestPlan — phase-template shaping ⨯ seedPlan (T2)', () => {
  beforeEach(() => {
    idSeq = 0
    clockNow = 1_000
    clearRegisteredInitiativePresets()
  })
  afterEach(() => clearRegisteredInitiativePresets())

  const PRESET_ID = 'preset_template_seedplan'

  /** Register a skip-interview preset with an exhaustive 3-phase template + an optional seedPlan. */
  function registerTemplatePreset(seedPlan?: InitiativePresetRegistration['seedPlan']) {
    registerInitiativePreset({
      descriptor: {
        id: PRESET_ID,
        presentation: { label: 'Templated', icon: 'i', color: '#000', description: 'x' },
        fields: [],
        planningPipelineId: 'pl_initiative',
        interview: 'skip',
        humanReviewDefault: false,
        defaultFragmentIds: [],
        phaseTemplate: {
          phases: [
            { id: 'a', title: 'A', goal: '', required: true },
            { id: 'b', title: 'B', goal: '', required: true },
            { id: 'c', title: 'C', goal: '', required: true },
          ],
          allowAdditionalPhases: false,
        },
      },
      seedPlan,
    })
  }

  /** A planner draft carrying the given phase ids (each with one item), in the given order. */
  const draftWith = (phaseIds: string[]) => ({
    goal: 'g',
    phases: phaseIds.map((id) => ({ id, title: `${id} title` })),
    items: phaseIds.map((id) => ({ id: `i-${id}`, phaseId: id, title: id, description: '' })),
    policy: { maxConcurrent: 2, defaultPipelineId: 'pl_full' },
  })

  async function seedInitiative(service: InitiativeService): Promise<string> {
    const { block } = await service.create('ws-1', {
      frameId: frame.id,
      title: 'Seed',
      description: '',
      presetId: PRESET_ID,
      presetInputs: {} as never,
    })
    return block.id
  }

  it('normalizes BEFORE running seedPlan (the hook sees template-ordered phases)', async () => {
    let seenByHook: string[] = []
    registerTemplatePreset((d) => {
      seenByHook = d.phases.map((p) => p.id ?? '')
      return d
    })
    const { service } = makeService()
    const blockId = await seedInitiative(service)

    const ingested = await service.ingestPlan('ws-1', blockId, draftWith(['c', 'a', 'b']))

    // The hook observed the ALREADY-reordered phases (normalize ran first), and the persisted plan
    // is in template order.
    expect(seenByHook).toEqual(['a', 'b', 'c'])
    expect(ingested!.phases!.map((p) => p.id)).toEqual(['a', 'b', 'c'])
  })

  it('re-normalizes seedPlan output so a hook that reorders phases cannot bypass the template', async () => {
    // A misbehaving DECORATION hook shuffles phases out of template order; the re-normalization
    // after seedPlan puts them back — the hook cannot defeat plan SHAPE enforcement.
    registerTemplatePreset((d) => ({ ...d, phases: [...d.phases].reverse() }))
    const { service } = makeService()
    const blockId = await seedInitiative(service)

    const ingested = await service.ingestPlan('ws-1', blockId, draftWith(['a', 'b', 'c']))

    expect(ingested!.phases!.map((p) => p.id)).toEqual(['a', 'b', 'c'])
  })

  it('rejects a seedPlan that introduces a phase disallowed by an exhaustive template', async () => {
    registerTemplatePreset((d) => ({
      ...d,
      phases: [...d.phases, { id: 'rogue', title: 'Rogue', goal: '' }],
      items: [
        ...d.items,
        { id: 'i-rogue', phaseId: 'rogue', title: 'rogue', description: '', dependsOn: [] },
      ],
    }))
    const { service } = makeService()
    const blockId = await seedInitiative(service)

    await expect(service.ingestPlan('ws-1', blockId, draftWith(['a', 'b', 'c']))).rejects.toThrow(
      /not allowed by the preset's phase template/,
    )
  })
})
