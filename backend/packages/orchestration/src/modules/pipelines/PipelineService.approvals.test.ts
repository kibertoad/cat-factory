import { describe, expect, it } from 'vitest'
import { createRecordingLogger, seedPipelines, ValidationError } from '@cat-factory/kernel'
import type {
  IdGenerator,
  Pipeline,
  PipelineRepository,
  Workspace,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { PipelineService } from './PipelineService.js'
import { validatePipelineShape } from './pipelineShape.js'

// A pipeline's human approval checkpoints are the one thing a BUILT-IN lets a workspace change.
// These pin the write (what it accepts, what it refuses) and the reseed that has to keep it.

const WS = 'ws_1'

function seed(id: string): Pipeline {
  const found = seedPipelines().find((p) => p.id === id)
  if (!found) throw new Error(`no catalog pipeline ${id}`)
  return found
}

function service(rows: Pipeline[], logger = createRecordingLogger()) {
  const store = new Map(rows.map((row) => [row.id, structuredClone(row)]))
  const workspaceRepository = {
    get: async (id: string) => (id === WS ? ({ id: WS } as Workspace) : null),
  } as WorkspaceRepository
  const pipelineRepository = {
    listByWorkspace: async () => [...store.values()],
    get: async (_ws: string, id: string) => store.get(id) ?? null,
    update: async (_ws: string, p: Pipeline) => void store.set(p.id, p),
  } as unknown as PipelineRepository
  const idGenerator: IdGenerator = { next: (prefix = 'id') => `${prefix}_1` }
  const svc = new PipelineService({ workspaceRepository, pipelineRepository, idGenerator, logger })
  return { svc, store, logger }
}

/** The gate flags `pipeline` carries, as the kinds of the steps that carry one. */
function gatedKinds(pipeline: Pipeline): string[] {
  return pipeline.agentKinds.filter((_, i) => pipeline.gates?.[i] === true)
}

/** A request turning on exactly the checkpoints after `kinds`, leaving every other step off. */
function gatesAfter(pipeline: Pipeline, ...kinds: string[]): boolean[] {
  return pipeline.agentKinds.map((kind) => kinds.includes(kind))
}

describe('PipelineService.setApprovals', () => {
  it('adds a checkpoint to a built-in and leaves its chain alone', async () => {
    const complex = seed('pl_complex')
    const { svc, store } = service([complex])
    const saved = await svc.setApprovals(WS, complex.id, {
      agentKinds: complex.agentKinds,
      gates: gatesAfter(complex, 'architect-companion'),
    })
    expect(gatedKinds(saved)).toEqual(['architect-companion'])
    expect(saved.builtin).toBe(true)
    expect(saved.agentKinds).toEqual(complex.agentKinds)
    expect(saved.version).toBe(complex.version)
    expect(store.get(complex.id)).toEqual(saved)
  })

  it('stores an approver policy on a checkpoint, and drops it when the checkpoint goes', async () => {
    const complex = seed('pl_complex')
    const { svc } = service([complex])
    const architect = complex.agentKinds.indexOf('architect')
    const policies = complex.agentKinds.map((_, i) =>
      i === architect ? { approvers: { roles: ['admin' as const] }, minApprovals: 1 } : null,
    )
    const gated = await svc.setApprovals(WS, complex.id, {
      agentKinds: complex.agentKinds,
      gates: gatesAfter(complex, 'architect'),
      policies,
    })
    // A quorum of one is the default, so it persists nothing.
    expect(gated.stepOptions?.[architect]).toEqual({
      gateConfig: { approvers: { roles: ['admin'] } },
    })
    const cleared = await svc.setApprovals(WS, complex.id, {
      agentKinds: complex.agentKinds,
      gates: gatesAfter(complex),
    })
    expect(cleared.gates).toBeUndefined()
    // The other steps' options (the tester pair's run conditions) are untouched.
    expect(cleared.stepOptions?.[architect]).toBeNull()
    expect(cleared.stepOptions?.filter(Boolean)).toEqual(complex.stepOptions?.filter(Boolean))
  })

  it('refuses to remove a checkpoint the built-in ships', async () => {
    const bugfix = seed('pl_bugfix')
    expect(gatedKinds(bugfix)).toContain('clarity-review')
    const { svc } = service([bugfix])
    await expect(
      svc.setApprovals(WS, bugfix.id, { agentKinds: bugfix.agentKinds, gates: gatesAfter(bugfix) }),
    ).rejects.toThrow(/part of the built-in pipeline/)
  })

  it('lets a copy older than the catalog leave off a shipped checkpoint it never carried', async () => {
    const bugfix = seed('pl_bugfix')
    const stale: Pipeline = { ...bugfix, gates: undefined }
    const { svc } = service([stale])
    const saved = await svc.setApprovals(WS, bugfix.id, {
      agentKinds: bugfix.agentKinds,
      gates: gatesAfter(bugfix, 'coder'),
    })
    expect(gatedKinds(saved)).toEqual(['coder'])
  })

  it('takes a checkpoint on a row that breaks a structural rule of its own', async () => {
    // A companion with no producer before it is a structural refusal unrelated to checkpoints.
    const complex = seed('pl_complex')
    const agentKinds = ['reviewer', ...complex.agentKinds]
    const broken: Pipeline = { ...complex, agentKinds, gates: undefined, stepOptions: undefined }
    expect(() => validatePipelineShape(broken)).toThrow(ValidationError)
    const { svc } = service([broken])
    const saved = await svc.setApprovals(WS, broken.id, {
      agentKinds: broken.agentKinds,
      gates: gatesAfter(broken, 'architect'),
    })
    expect(gatedKinds(saved)).toEqual(['architect'])
  })

  it('removes any checkpoint from a custom pipeline', async () => {
    const custom: Pipeline = { ...seed('pl_bugfix'), id: 'pl_7', builtin: undefined }
    const { svc } = service([custom])
    const saved = await svc.setApprovals(WS, custom.id, {
      agentKinds: custom.agentKinds,
      gates: gatesAfter(custom),
    })
    expect(saved.gates).toBeUndefined()
  })

  it('refuses arrays that do not match the chain', async () => {
    const complex = seed('pl_complex')
    const { svc } = service([complex])
    await expect(
      svc.setApprovals(WS, complex.id, { agentKinds: complex.agentKinds, gates: [true] }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('refuses a request composed against a different chain of the same length', async () => {
    const complex = seed('pl_complex')
    const { svc } = service([complex])
    const reordered = [...complex.agentKinds].reverse()
    await expect(
      svc.setApprovals(WS, complex.id, {
        agentKinds: reordered,
        gates: gatesAfter(complex, 'architect'),
      }),
    ).rejects.toThrow(/different version/)
  })

  it('takes a checkpoint on a row whose estimate gate breaks a rule of its own', async () => {
    // An estimate gate with no threshold is a refusal of the skip, not of any checkpoint.
    const full = seed('pl_full')
    const architect = full.agentKinds.indexOf('architect')
    const gating = full.agentKinds.map((_, i) =>
      i === architect ? { enabled: true, onMissingEstimate: 'run' as const } : null,
    )
    const broken: Pipeline = { ...full, gating }
    expect(() => validatePipelineShape(broken)).toThrow(/sets no threshold/)
    const { svc } = service([broken])
    const saved = await svc.setApprovals(WS, broken.id, {
      agentKinds: broken.agentKinds,
      gates: gatesAfter(broken, 'coder'),
    })
    expect(gatedKinds(saved)).toEqual(['coder'])
  })

  it('refuses a checkpoint after a companion whose producer the estimate may skip', async () => {
    // Adaptive build estimate-gates its Architect, and the Architect Reviewer cascades with it, so
    // a checkpoint there is one the estimate would cancel.
    const full = seed('pl_full')
    const { svc } = service([full])
    await expect(
      svc.setApprovals(WS, full.id, {
        agentKinds: full.agentKinds,
        gates: gatesAfter(full, 'architect-companion'),
      }),
    ).rejects.toThrow(/may skip/)
  })
})

describe('PipelineService.reseed carries the workspace checkpoints', () => {
  it('matches each checkpoint to the same step when the catalog moved the chain', async () => {
    const complex = seed('pl_complex')
    // An older copy without the researcher: every step after it sits one index earlier, so a
    // positional carry would land this checkpoint on the Coder.
    const agentKinds = complex.agentKinds.filter((kind) => kind !== 'researcher')
    const companion = agentKinds.indexOf('architect-companion')
    const stale: Pipeline = {
      ...complex,
      version: (complex.version ?? 1) - 1,
      agentKinds,
      gates: agentKinds.map((_, i) => i === companion),
      stepOptions: agentKinds.map((_, i) =>
        i === companion
          ? { gateConfig: { minApprovals: 2, approvers: { roles: ['admin'] } } }
          : null,
      ),
    }
    const { svc, logger } = service([stale])
    const reseeded = await svc.reseed(WS, complex.id)
    expect(reseeded.agentKinds).toEqual(complex.agentKinds)
    expect(gatedKinds(reseeded)).toEqual(['architect-companion'])
    expect(reseeded.stepOptions?.[complex.agentKinds.indexOf('architect-companion')]).toEqual({
      gateConfig: { minApprovals: 2, approvers: { roles: ['admin'] } },
    })
    expect(logger.lines.filter((line) => line.level === 'warn')).toEqual([])
  })

  it('keeps the catalog checkpoints alongside the workspace ones', async () => {
    const bugfix = seed('pl_bugfix')
    const { svc } = service([bugfix])
    await svc.setApprovals(WS, bugfix.id, {
      agentKinds: bugfix.agentKinds,
      gates: bugfix.agentKinds.map((kind, i) => bugfix.gates?.[i] === true || kind === 'coder'),
    })
    const reseeded = await svc.reseed(WS, bugfix.id)
    expect(gatedKinds(reseeded)).toEqual([...gatedKinds(bugfix), 'coder'].sort(byChainOf(bugfix)))
  })

  it('drops and logs a checkpoint the new definition refuses, or whose step left the chain', async () => {
    const full = seed('pl_full')
    // An older copy whose Architect was unconditional and checkpointed, plus a step the catalog
    // no longer carries. The current definition estimate-gates the Architect, which no checkpoint
    // may sit on.
    const agentKinds = [...full.agentKinds, 'documenter']
    const stale: Pipeline = {
      ...full,
      version: (full.version ?? 1) - 1,
      agentKinds,
      gating: undefined,
      gates: agentKinds.map((kind) => kind === 'architect' || kind === 'documenter'),
    }
    const { svc, logger } = service([stale])
    const reseeded = await svc.reseed(WS, full.id)
    expect(gatedKinds(reseeded)).toEqual(gatedKinds(full))
    const warnings = logger.lines.filter((line) => line.level === 'warn')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.fields).toMatchObject({ dropped: ['architect', 'documenter'] })
  })
})

describe('PipelineService.reseed approver policies', () => {
  it('keeps the checkpoint and drops only an approver policy the definition refuses', async () => {
    const complex = seed('pl_complex')
    const companion = complex.agentKinds.indexOf('architect-companion')
    // Two approvals from one named approver can never be met.
    const stale: Pipeline = {
      ...complex,
      gates: complex.agentKinds.map((_, i) => i === companion),
      stepOptions: complex.agentKinds.map((_, i) =>
        i === companion
          ? { gateConfig: { minApprovals: 2, approvers: { userIds: ['u_1'] } } }
          : (complex.stepOptions?.[i] ?? null),
      ),
    }
    const { svc, logger } = service([stale])
    const reseeded = await svc.reseed(WS, complex.id)
    expect(gatedKinds(reseeded)).toEqual(['architect-companion'])
    expect(reseeded.stepOptions?.[companion] ?? null).toBeNull()
    const warnings = logger.lines.filter((line) => line.level === 'warn')
    expect(warnings[0]?.fields).toMatchObject({
      dropped: [],
      droppedPolicies: ['architect-companion'],
    })
  })
})

function byChainOf(pipeline: Pipeline) {
  return (a: string, b: string) => pipeline.agentKinds.indexOf(a) - pipeline.agentKinds.indexOf(b)
}
