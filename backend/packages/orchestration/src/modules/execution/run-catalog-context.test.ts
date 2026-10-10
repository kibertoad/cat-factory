import { AgentKindRegistry, BINARY_OUTPUT_TRAIT } from '@cat-factory/agents'
import type { ExecutionInstance, PipelineStep } from '@cat-factory/contracts'
import { BINARY_OUTPUT_BRIEF_FILE, defaultBinaryGeneratorRegistry } from '@cat-factory/kernel'
import type { BinaryGeneratorSource } from '@cat-factory/kernel'
import { describe, expect, it, vi } from 'vitest'
import { CatalogRunContext } from './run-catalog-context.js'
import type { FoundationalServiceResolver } from './run-foundational-services.js'

/**
 * `CatalogRunContext.sliceFor` — the ONE entry the dispatch read wave takes for everything
 * catalog-backed.
 *
 * What is worth pinning here is not the fan-out (three awaited reads) but the two properties the
 * fan-out exists to guarantee: the deployment's integrations are read ONCE for the dispatch, and
 * an unreachable source degrades both halves quietly instead of failing the dispatch or leaving
 * a rejected promise behind. Both only misbehave on a mothership-mode deployment, which no
 * unit test is — so they have to be asserted directly.
 */

const registry = new AgentKindRegistry()
registry.register({
  kind: 'image-generator',
  systemPrompt: 'You generate images.',
  traits: [BINARY_OUTPUT_TRAIT],
})

const step = (overrides: Partial<PipelineStep> = {}): PipelineStep =>
  ({
    agentKind: 'image-generator',
    state: 'running',
    stepOptions: {
      binaryOutput: { storageServiceId: 'asset-store', generatorIds: ['retro-diffusion'] },
    },
    ...overrides,
  }) as PipelineStep

const instance = { steps: [], currentStep: 0 } as unknown as ExecutionInstance

function resolver(): FoundationalServiceResolver {
  return {
    catalogFor: vi.fn(async () => []),
    catalogIdsFor: vi.fn(async () => ['asset-store']),
    contextFilesFor: vi.fn(async () => []),
    binaryOutputContextFilesFor: vi.fn(async (_ws, _config, source?: BinaryGeneratorSource) => {
      // The real resolver reads the source to describe the generative half of the brief; the
      // fake does the same so the shared-read assertion covers a realistic call pattern.
      await source?.views()
      return [{ path: BINARY_OUTPUT_BRIEF_FILE, content: 'brief' }]
    }),
  } as unknown as FoundationalServiceResolver
}

/** A source counting `views()` calls, which is the thing the memo is supposed to collapse. */
function countingSource(views: () => Promise<ReturnType<typeof registeredViews>>) {
  let reads = 0
  return {
    reads: () => reads,
    source: {
      views: () => {
        reads += 1
        return views()
      },
      documentsFor: async () => new Map(),
    } satisfies BinaryGeneratorSource,
  }
}

/**
 * The Node `process` event emitter when the tests are running on Node, else undefined. Typed
 * locally to the two methods used, so this package keeps compiling for a runtime that has no
 * such object.
 */
function nodeProcess():
  | {
      on(e: 'unhandledRejection', l: (reason: unknown) => void): void
      off(e: 'unhandledRejection', l: (reason: unknown) => void): void
    }
  | undefined {
  return (globalThis as { process?: ReturnType<typeof nodeProcess> }).process
}

/**
 * Yield past the microtask queue, which is when a host decides a rejection went unhandled.
 * Reached the same guarded way as {@link nodeProcess}, and for the same reason.
 */
function macrotask(): Promise<void> {
  const timer = (globalThis as { setTimeout?: (fn: () => void, ms: number) => unknown }).setTimeout
  return new Promise((resolve) => {
    if (timer) timer(() => resolve(), 0)
    else resolve()
  })
}

function registeredViews() {
  const generators = defaultBinaryGeneratorRegistry()
  generators.register({
    id: 'retro-diffusion',
    name: 'Retro Diffusion',
    summary: 'Pixel-art image generation.',
    description: '',
    modalities: ['image'],
    credentials: [{ key: 'RD_TOKEN' }],
  })
  return generators.views()
}

describe('CatalogRunContext.sliceFor', () => {
  it('reads the deployment’s integrations ONCE for a dispatch that needs them twice', async () => {
    // The brief tells the agent which integrations it has; the projection puts a credential
    // behind each. Two answers about the same set — and on a mothership-mode node, two network
    // round trips before this shared read, with a window in which they could disagree.
    const { source, reads } = countingSource(async () => registeredViews())
    const slice = await new CatalogRunContext({
      agentKindRegistry: registry,
      foundationalServiceResolver: resolver(),
      binaryGeneratorSource: source,
    }).sliceFor('ws', 'image-generator', step(), instance)

    expect(reads()).toBe(1)
    expect(slice.binaryOutputContextFiles.map((f) => f.path)).toEqual([BINARY_OUTPUT_BRIEF_FILE])
    expect(slice.binaryGenerators.map((g) => g.id)).toEqual(['retro-diffusion'])
  })

  it('does not share that read ACROSS dispatches — the memo dies with the slice', async () => {
    // The line between a per-call memo and the homebrew cache the `AppCaches` seam exists to
    // keep out. A second dispatch must see a redeployed mothership's set, not the first one's.
    const { source, reads } = countingSource(async () => registeredViews())
    const context = new CatalogRunContext({
      agentKindRegistry: registry,
      foundationalServiceResolver: resolver(),
      binaryGeneratorSource: source,
    })
    await context.sliceFor('ws', 'image-generator', step(), instance)
    await context.sliceFor('ws', 'image-generator', step(), instance)
    expect(reads()).toBe(2)
  })

  it('degrades BOTH halves and fails nothing when the set cannot be read', async () => {
    // The coherent pair: an agent told nothing and handed nothing. The dispatch itself must
    // proceed — the source being remote is a property of the deployment's topology, not of this
    // run — and admission has already refused the case where that matters.
    const { source } = countingSource(async () => {
      throw new Error('mothership unreachable')
    })
    const slice = await new CatalogRunContext({
      agentKindRegistry: registry,
      foundationalServiceResolver: resolver(),
      binaryGeneratorSource: source,
    }).sliceFor('ws', 'image-generator', step(), instance)

    expect(slice.binaryOutputContextFiles).toEqual([])
    expect(slice.binaryGenerators).toEqual([])
  })

  it('leaves no unhandled rejection when a failed read has only ONE consumer', async () => {
    // The hazard the memo's settled-result storage exists to close, asserted on the runtime that
    // actually raises it. A kind WITHOUT the trait short-circuits both binary-output reads, so a
    // naive shared promise would be created, rejected, and awaited by nobody.
    //
    // Reached through `globalThis` because this package is runtime-neutral and carries no Node
    // types — the hook is a Node fact, and the test says so rather than dragging `@types/node`
    // into a package that compiles for workerd.
    const rejections: unknown[] = []
    const onUnhandled = (reason: unknown) => rejections.push(reason)
    nodeProcess()?.on('unhandledRejection', onUnhandled)
    try {
      const { source } = countingSource(async () => {
        throw new Error('mothership unreachable')
      })
      const slice = await new CatalogRunContext({
        agentKindRegistry: registry,
        foundationalServiceResolver: resolver(),
        binaryGeneratorSource: source,
      }).sliceFor('ws', 'coder', step({ agentKind: 'coder' }), instance)

      expect(slice.binaryGenerators).toEqual([])
      await macrotask()
      expect(rejections).toEqual([])
    } finally {
      nodeProcess()?.off('unhandledRejection', onUnhandled)
    }
  })

  it('needs no source at all — an unwired deployment resolves the rest unchanged', async () => {
    const slice = await new CatalogRunContext({
      agentKindRegistry: registry,
      foundationalServiceResolver: resolver(),
    }).sliceFor('ws', 'image-generator', step(), instance)
    expect(slice.binaryGenerators).toEqual([])
    expect(slice.binaryOutputContextFiles.map((f) => f.path)).toEqual([BINARY_OUTPUT_BRIEF_FILE])
  })
})
