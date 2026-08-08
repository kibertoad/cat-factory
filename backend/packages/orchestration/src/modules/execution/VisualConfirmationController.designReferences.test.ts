import { describe, expect, it, vi } from 'vitest'
import type {
  BinaryArtifactRecord,
  Block,
  DocumentRecord,
  ExecutionInstance,
  PipelineStep,
} from '@cat-factory/kernel'
import {
  VisualConfirmationController,
  type VisualConfirmationControllerDeps,
} from './VisualConfirmationController.js'

// The gate's DESIGN-reference half: the frames an import retained for the designs a task links
// reach the gallery beside the images a person uploaded by hand. Only the two reads are faked;
// the fold itself is unit-tested next door (visual-confirm-design-references.test.ts).

const BLOCK = {
  id: 'blk_1',
  executionId: 'exec_1',
  title: 'Checkout',
  type: 'task',
  description: '',
  pullRequest: { url: 'https://h/pr/1', number: 1, branch: 'feat/checkout' },
} as unknown as Block

function gateStep(): PipelineStep {
  return {
    agentKind: 'visual-confirmation',
    state: 'running',
    progress: 0,
  } as unknown as PipelineStep
}

function uiTesterStep(views: string[]): PipelineStep {
  return {
    agentKind: 'tester-ui',
    state: 'done',
    progress: 1,
    test: {
      lastReport: {
        greenlight: true,
        summary: 'ok',
        screenshots: views.map((view, i) => ({ view, artifactId: `shot_${i}` })),
      },
    },
  } as unknown as PipelineStep
}

function instance(steps: PipelineStep[], currentStep = steps.length - 1): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: 'blk_1',
    status: 'running',
    currentStep,
    steps,
  } as unknown as ExecutionInstance
}

let seq = 0
function artifact(over: Partial<BinaryArtifactRecord>): BinaryArtifactRecord {
  seq += 1
  return {
    id: `art_${seq}`,
    workspaceId: 'ws',
    executionId: null,
    blockId: null,
    kind: 'reference',
    view: null,
    contentType: 'image/png',
    byteSize: 1,
    hash: 'h',
    storage: 'memory',
    storageKey: `ws/art_${seq}`,
    document: null,
    createdAt: seq,
    ...over,
  }
}

function designDocument(over: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    workspaceId: 'ws',
    source: 'figma',
    externalId: 'fileA',
    title: 'Checkout flow',
    url: 'https://figma.com/file/fileA',
    excerpt: '',
    body: 'frames',
    contentHash: 'c',
    sourceVersion: 'v1',
    linkedBlockId: 'blk_1',
    role: null,
    docKind: null,
    renderStatus: 'stored',
    syncedAt: 1,
    deletedAt: null,
    ...over,
  } as DocumentRecord
}

/** The per-account artifact store, faked over three fixed reads. */
function fakeStore(opts: {
  executionArtifacts?: BinaryArtifactRecord[]
  blockArtifacts?: BinaryArtifactRecord[]
  documentArtifacts?: BinaryArtifactRecord[]
}) {
  return {
    listByExecution: vi.fn(async () => opts.executionArtifacts ?? []),
    listByBlock: vi.fn(async () => opts.blockArtifacts ?? []),
    listByDocuments: vi.fn(async () => opts.documentArtifacts ?? []),
  }
}

function fakeDeps(over: Partial<VisualConfirmationControllerDeps> = {}) {
  const deps: VisualConfirmationControllerDeps = {
    blockRepository: { get: vi.fn(async () => BLOCK) } as never,
    executionRepository: { get: vi.fn(async () => null), upsert: vi.fn(async () => {}) } as never,
    workRunner: { signalDecision: vi.fn(async () => {}) } as never,
    agentExecutor: { runsAsync: () => true, startJob: vi.fn() } as never,
    contextBuilder: { buildContext: vi.fn() } as never,
    resolveRiskPolicy: vi.fn(async () => ({ ciMaxAttempts: 3 })),
    stateMachine: {
      parkStepOnDecision: vi.fn(async (_ws, _i, s: PipelineStep) => {
        s.approval = { id: 'appr_1', status: 'pending', proposal: '' }
        s.state = 'waiting_decision'
        return { kind: 'awaiting_decision', decisionId: 'appr_1' } as const
      }),
      casPersist: vi.fn(async () => {}),
      emitInstance: vi.fn(async () => {}),
      updateBlockProgress: vi.fn(async () => {}),
      finalizeBlock: vi.fn(async () => {}),
      stopRunContainer: vi.fn(async () => {}),
    } as never,
    stepGraph: {
      startStep: vi.fn((s: PipelineStep) => {
        s.state = 'working'
      }),
      finishStep: vi.fn((s: PipelineStep) => {
        s.state = 'done'
      }),
    } as never,
    clockNow: () => 1000,
    ...over,
  }
  return deps
}

describe('VisualConfirmationController design references', () => {
  it('pairs a captured screenshot with the design frame of the same view', async () => {
    const frame = artifact({
      view: 'Checkout',
      document: { source: 'figma', externalId: 'fileA' },
    })
    const deps = fakeDeps({
      resolveBinaryArtifactStore: (() =>
        Promise.resolve(
          fakeStore({
            executionArtifacts: [artifact({ id: 'shot_0', kind: 'screenshot', view: 'Checkout' })],
            documentArtifacts: [frame],
          }),
        )) as never,
      documentRepository: { listByBlock: vi.fn(async () => [designDocument()]) } as never,
    })
    const step = gateStep()

    await new VisualConfirmationController(deps).evaluate(
      'ws',
      instance([uiTesterStep(['Checkout']), step]),
      step,
      BLOCK,
      true,
    )

    // Zero manual uploads: the design's own frame is the reference the reviewer compares against,
    // and the surface says so rather than presenting it as somebody's attachment.
    expect(step.visualConfirm?.pairs).toEqual([
      {
        view: 'Checkout',
        actualArtifactId: 'shot_0',
        referenceArtifactId: frame.id,
        referenceOrigin: 'design',
      },
    ])
    expect(step.visualConfirm?.designReferences).toEqual({ documents: 1, images: 1 })
  })

  it('lets a hand-uploaded reference OUTRANK the design frame for the same view', async () => {
    const frame = artifact({
      view: 'Checkout',
      document: { source: 'figma', externalId: 'fileA' },
    })
    const uploaded = artifact({ view: 'Checkout', blockId: 'blk_1' })
    const deps = fakeDeps({
      resolveBinaryArtifactStore: (() =>
        Promise.resolve(
          fakeStore({ blockArtifacts: [uploaded], documentArtifacts: [frame] }),
        )) as never,
      documentRepository: { listByBlock: vi.fn(async () => [designDocument()]) } as never,
    })
    const step = gateStep()

    await new VisualConfirmationController(deps).evaluate('ws', instance([step]), step, BLOCK, true)

    // An upload is a deliberate act against THIS task and survives every re-import; a design
    // render is a projection the next import replaces. So the person's choice wins.
    expect(step.visualConfirm?.pairs).toEqual([
      {
        view: 'Checkout',
        actualArtifactId: null,
        referenceArtifactId: uploaded.id,
        referenceOrigin: 'upload',
      },
    ])
  })

  it('states a linked design that retained nothing rather than showing a short gallery', async () => {
    const deps = fakeDeps({
      resolveBinaryArtifactStore: (() => Promise.resolve(fakeStore({}))) as never,
      documentRepository: {
        listByBlock: vi.fn(async () => [designDocument({ renderStatus: 'failed' })]),
      } as never,
    })
    const step = gateStep()

    await new VisualConfirmationController(deps).evaluate('ws', instance([step]), step, BLOCK, true)

    expect(step.visualConfirm?.designReferences).toEqual({
      documents: 1,
      images: 0,
      gaps: [{ title: 'Checkout flow', reason: 'failed' }],
    })
  })

  it('says nothing about designs when the task links none', async () => {
    const deps = fakeDeps({
      resolveBinaryArtifactStore: (() => Promise.resolve(fakeStore({}))) as never,
      documentRepository: { listByBlock: vi.fn(async () => []) } as never,
    })
    const step = gateStep()

    await new VisualConfirmationController(deps).evaluate('ws', instance([step]), step, BLOCK, true)

    // ABSENT means "this task links no design", which is a different fact from "links one and it
    // gave nothing" — the case above.
    expect(step.visualConfirm?.designReferences ?? null).toBeNull()
  })

  it('behaves exactly as before when the document corpus is unwired', async () => {
    const store = fakeStore({ blockArtifacts: [artifact({ view: 'Checkout', blockId: 'blk_1' })] })
    const deps = fakeDeps({
      resolveBinaryArtifactStore: (() => Promise.resolve(store)) as never,
    })
    const step = gateStep()

    await new VisualConfirmationController(deps).evaluate('ws', instance([step]), step, BLOCK, true)

    expect(store.listByDocuments).not.toHaveBeenCalled()
    expect(step.visualConfirm?.pairs).toHaveLength(1)
    expect(step.visualConfirm?.designReferences ?? null).toBeNull()
  })

  it('re-reads the designs on RECAPTURE, so one linked mid-review appears', async () => {
    const frame = artifact({
      view: 'Checkout',
      document: { source: 'figma', externalId: 'fileA' },
    })
    let linked: DocumentRecord[] = []
    const deps = fakeDeps({
      resolveBinaryArtifactStore: (() =>
        Promise.resolve(fakeStore({ documentArtifacts: [frame] }))) as never,
      documentRepository: { listByBlock: vi.fn(async () => linked) } as never,
    })
    const controller = new VisualConfirmationController(deps)
    const step = gateStep()
    const inst = instance([step])

    await controller.evaluate('ws', inst, step, BLOCK, true)
    expect(step.visualConfirm?.designReferences ?? null).toBeNull()

    // The reviewer attaches the design while the gate is parked and hits Recapture — the same
    // act the hand-upload path already relies on this action for.
    linked = [designDocument()]
    step.visualConfirm!.pendingAction = { type: 'recapture' }
    await controller.evaluate('ws', inst, step, BLOCK, true)

    expect(step.visualConfirm?.pairs).toEqual([
      {
        view: 'Checkout',
        actualArtifactId: null,
        referenceArtifactId: frame.id,
        referenceOrigin: 'design',
      },
    ])
    expect(step.visualConfirm?.designReferences).toEqual({ documents: 1, images: 1 })
  })
})
