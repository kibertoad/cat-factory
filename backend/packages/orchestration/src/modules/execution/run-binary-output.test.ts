import { AgentKindRegistry, BINARY_OUTPUT_TRAIT } from '@cat-factory/agents'
import type { PipelineStep } from '@cat-factory/contracts'
import {
  BINARY_OUTPUT_BRIEF_FILE,
  BINARY_OUTPUT_DECLARATION_TAG,
  defaultBinaryGeneratorRegistry,
  registryBinaryGeneratorSource,
} from '@cat-factory/kernel'
import { describe, expect, it, vi } from 'vitest'
import type { FoundationalServiceResolver } from './run-foundational-services.js'
import {
  createBinaryOutputDeclarationRecorder,
  dispatchBinaryGeneratorsFor,
  dispatchBinaryStorageFor,
  resolveBinaryOutputContext,
} from './run-binary-output.js'

function generatorRegistry() {
  const generators = defaultBinaryGeneratorRegistry()
  generators.register({
    id: 'retro-diffusion',
    name: 'Retro Diffusion',
    summary: 'Pixel-art image generation.',
    description: '',
    modalities: ['image'],
    credentials: [{ key: 'RD_TOKEN' }],
  })
  return generators
}

const registry = new AgentKindRegistry()
registry.register({
  kind: 'image-generator',
  systemPrompt: 'You generate images.',
  traits: [BINARY_OUTPUT_TRAIT],
})

const step = (overrides: Partial<PipelineStep> = {}): PipelineStep =>
  ({ agentKind: 'image-generator', state: 'done', ...overrides }) as PipelineStep

function resolver(overrides: Partial<FoundationalServiceResolver> = {}) {
  return {
    catalogFor: vi.fn(async () => []),
    catalogIdsFor: vi.fn(async () => ['asset-store']),
    contextFilesFor: vi.fn(async () => []),
    binaryOutputContextFilesFor: vi.fn(async () => [
      { path: BINARY_OUTPUT_BRIEF_FILE, content: 'brief' },
    ]),
    credentialsFor: vi.fn(async () => []),
    ...overrides,
  } satisfies FoundationalServiceResolver & Record<string, unknown>
}

describe('resolveBinaryOutputContext', () => {
  it('gives a trait-carrying kind its brief, off the STEP OWN selection', async () => {
    const deps = resolver()
    const files = await resolveBinaryOutputContext({
      workspaceId: 'ws',
      agentKind: 'image-generator',
      agentKindRegistry: registry,
      step: step({
        stepOptions: { binaryOutput: { storageServiceId: 'asset-store' } },
      }),
      foundationalServiceResolver: deps,
    })
    expect(files.map((f) => f.path)).toEqual([BINARY_OUTPUT_BRIEF_FILE])
    // The fourth argument is the step's CANDIDATE state, which tells a comparison step's two
    // passes apart. A step that does not compare carries none, and the brief renderer treats that
    // as "no comparison" rather than as a first pass.
    expect(deps.binaryOutputContextFilesFor).toHaveBeenCalledWith(
      'ws',
      { storageServiceId: 'asset-store' },
      undefined,
      undefined,
    )
  })

  it('injects nothing for a kind without the trait, and reads nothing', async () => {
    const deps = resolver()
    const files = await resolveBinaryOutputContext({
      workspaceId: 'ws',
      agentKind: 'coder',
      agentKindRegistry: registry,
      step: step({ agentKind: 'coder' }),
      foundationalServiceResolver: deps,
    })
    expect(files).toEqual([])
    expect(deps.binaryOutputContextFilesFor).not.toHaveBeenCalled()
  })

  it('injects nothing when no resolver is wired', async () => {
    expect(
      await resolveBinaryOutputContext({
        workspaceId: 'ws',
        agentKind: 'image-generator',
        agentKindRegistry: registry,
        step: step(),
      }),
    ).toEqual([])
  })

  it('degrades an unreachable catalog to NO files (the guidance names the absent brief)', async () => {
    const files = await resolveBinaryOutputContext({
      workspaceId: 'ws',
      agentKind: 'image-generator',
      agentKindRegistry: registry,
      step: step(),
      foundationalServiceResolver: resolver({
        binaryOutputContextFilesFor: vi.fn(async () => {
          throw new Error('store unreachable')
        }),
      }),
    })
    expect(files).toEqual([])
  })
})

describe('createBinaryOutputDeclarationRecorder', () => {
  const declaration = `done\n\`\`\`${BINARY_OUTPUT_DECLARATION_TAG}\n[{"service": "asset-store", "location": "a.png"}]\n\`\`\``

  it('records what a trait-carrying step declared, checked against the catalog ids', async () => {
    const target = step()
    await createBinaryOutputDeclarationRecorder({
      agentKindRegistry: registry,
      foundationalServiceResolver: resolver(),
    })('ws', target, declaration)
    expect(target.binaryOutputs).toEqual({
      stored: [{ service: 'asset-store', location: 'a.png' }],
      unknownServices: [],
      unknownGenerators: [],
      invalidEntries: 0,
      omitted: 0,
    })
  })

  it('records `undeclared` when the reply carried no block — distinct from declaring none', async () => {
    const target = step()
    await createBinaryOutputDeclarationRecorder({
      agentKindRegistry: registry,
      foundationalServiceResolver: resolver(),
    })('ws', target, 'all done')
    expect(target.binaryOutputs?.undeclared).toBe(true)
  })

  it('leaves a step that was never briefed unannotated', async () => {
    // Neither its kind nor a selection: no brief was ever built for it, so a block in its reply
    // is a coincidence, not a declaration.
    const target = step({ agentKind: 'coder' })
    await createBinaryOutputDeclarationRecorder({
      agentKindRegistry: registry,
      foundationalServiceResolver: resolver(),
    })('ws', target, declaration)
    expect(target.binaryOutputs).toBeUndefined()
  })

  it('records a step that carries a SELECTION even when its own kind lacks the trait', async () => {
    // The read-back runs on the durable completion path, which rebuilds everything from the step
    // and cannot see that a gate helper (or a PR-review override kind) is what actually ran.
    // Keying on `step.agentKind` alone would silently drop the declaration of every trait-carrying
    // kind dispatched under an overriding kind — the artifacts exist and the record says nothing.
    // A selection is the only thing a brief is ever built from, so its presence is the honest
    // step-local signal that some dispatch here was briefed.
    const target = step({
      agentKind: 'ci',
      stepOptions: { binaryOutput: { storageServiceId: 'asset-store' } },
    })
    await createBinaryOutputDeclarationRecorder({
      agentKindRegistry: registry,
      foundationalServiceResolver: resolver(),
    })('ws', target, declaration)
    expect(target.binaryOutputs?.stored).toEqual([{ service: 'asset-store', location: 'a.png' }])
  })

  it('still records with NO resolver wired — every claimed id is then honestly unknown', async () => {
    const target = step()
    await createBinaryOutputDeclarationRecorder({ agentKindRegistry: registry })(
      'ws',
      target,
      declaration,
    )
    expect(target.binaryOutputs?.stored).toHaveLength(1)
    expect(target.binaryOutputs?.unknownServices).toEqual(['asset-store'])
  })

  it('leaves the step unannotated on a failed catalog read rather than failing the completion', async () => {
    const target = step()
    await createBinaryOutputDeclarationRecorder({
      agentKindRegistry: registry,
      foundationalServiceResolver: resolver({
        catalogIdsFor: vi.fn(async () => {
          throw new Error('store unreachable')
        }),
      }),
    })('ws', target, declaration)
    expect(target.binaryOutputs).toBeUndefined()
  })

  it('still records the artifacts when the GENERATIVE set could not be read, marking it unverified', async () => {
    // The asymmetry with the catalog case above is the point. A failed catalog read leaves
    // nothing to judge an artifact's `service` against, so there is no report to write; a failed
    // GENERATIVE read leaves the artifacts and the whole storage-side verdict intact and
    // withholds exactly one judgement. Dropping the record here would lose a completed
    // generation's evidence over a question nobody asked about it — on a mothership-mode node,
    // for the duration of an outage.
    const target = step()
    await createBinaryOutputDeclarationRecorder({
      agentKindRegistry: registry,
      foundationalServiceResolver: resolver(),
      binaryGeneratorSource: {
        views: async () => {
          throw new Error('mothership unreachable')
        },
        documentsFor: async () => new Map(),
      },
    })('ws', target, declaration)
    expect(target.binaryOutputs?.stored).toEqual([{ service: 'asset-store', location: 'a.png' }])
    expect(target.binaryOutputs?.generatorsUnverified).toBe(true)
    // The claim that must NOT be made: with nothing to compare against, an id cannot be called
    // invented. An empty list here would otherwise read as "every id checked out".
    expect(target.binaryOutputs?.unknownGenerators).toEqual([])
  })

  it('reports an unregistered id as unknown when the set WAS read — the opposite fact', async () => {
    // Same empty-looking outcome, opposite meaning, which is why the flag exists at all.
    const target = step()
    await createBinaryOutputDeclarationRecorder({
      agentKindRegistry: registry,
      foundationalServiceResolver: resolver(),
      binaryGeneratorSource: registryBinaryGeneratorSource(defaultBinaryGeneratorRegistry()),
    })(
      'ws',
      target,
      '```binary-outputs\n[{"service":"asset-store","location":"a.png","generator":"ghost"}]\n```',
    )
    expect(target.binaryOutputs?.unknownGenerators).toEqual(['ghost'])
    expect(target.binaryOutputs?.generatorsUnverified).toBeUndefined()
  })
})

describe('dispatchBinaryGeneratorsFor', () => {
  it('projects the step’s selected integrations for a trait-carrying dispatch', async () => {
    await expect(
      dispatchBinaryGeneratorsFor({
        agentKind: 'image-generator',
        agentKindRegistry: registry,
        step: step({
          stepOptions: {
            binaryOutput: { storageServiceId: 'asset-store', generatorIds: ['retro-diffusion'] },
          },
        }),
        binaryGeneratorSource: registryBinaryGeneratorSource(generatorRegistry()),
      }),
    ).resolves.toEqual([
      {
        id: 'retro-diffusion',
        label: 'Retro Diffusion',
        modalities: ['image'],
        credentials: [{ key: 'RD_TOKEN' }],
      },
    ])
  })

  it('projects nothing for a kind without the trait — the SAME gate the brief uses', async () => {
    // The two are halves of one hand-off: the brief tells the agent to read `$RD_TOKEN`, and this
    // is what puts a value there. A kind that got one without the other is either an agent told
    // to use a credential nobody delivered, or a credential delivered in silence.
    await expect(
      dispatchBinaryGeneratorsFor({
        agentKind: 'coder',
        agentKindRegistry: registry,
        step: step({
          agentKind: 'coder',
          stepOptions: {
            binaryOutput: { storageServiceId: 'asset-store', generatorIds: ['retro-diffusion'] },
          },
        }),
        binaryGeneratorSource: registryBinaryGeneratorSource(generatorRegistry()),
      }),
    ).resolves.toEqual([])
  })

  it('projects nothing — never throws — when the set cannot be READ', async () => {
    // The credential half's own disposition, and the reason it is safe for the brief to keep a
    // separate one. An agent that gets no credentials and no brief was told nothing and handed
    // nothing; what must never happen is a dispatch FAILING here, because the source being
    // remote is a property of the deployment's topology and not of this run.
    await expect(
      dispatchBinaryGeneratorsFor({
        agentKind: 'image-generator',
        agentKindRegistry: registry,
        step: step({
          stepOptions: {
            binaryOutput: { storageServiceId: 'asset-store', generatorIds: ['retro-diffusion'] },
          },
        }),
        binaryGeneratorSource: {
          views: async () => {
            throw new Error('mothership unreachable')
          },
          documentsFor: async () => new Map(),
        },
      }),
    ).resolves.toEqual([])
  })

  it('projects nothing when the deployment registers no integrations', async () => {
    await expect(
      dispatchBinaryGeneratorsFor({
        agentKind: 'image-generator',
        agentKindRegistry: registry,
        step: step({
          stepOptions: {
            binaryOutput: { storageServiceId: 'asset-store', generatorIds: ['retro-diffusion'] },
          },
        }),
      }),
    ).resolves.toEqual([])
  })
})

describe('dispatchBinaryStorageFor', () => {
  it('answers the storage service a briefed step selected', () => {
    // The container executor's ONE input for deciding whether this job gets an upload seam into
    // the platform's own asset storage. It cannot read that off the brief (prose) or off the kind
    // (a deployment's generator stores wherever its step points it).
    expect(
      dispatchBinaryStorageFor({
        agentKind: 'image-generator',
        agentKindRegistry: registry,
        step: step({ stepOptions: { binaryOutput: { storageServiceId: 'asset-store' } } }),
      }),
    ).toBe('asset-store')
  })

  it('answers nothing for a kind that was never briefed, selection or not', () => {
    // Gated on the EFFECTIVE kind's trait, exactly as the brief and the credentials are: a step
    // handed an upload endpoint with no brief has a capability nothing told it about.
    expect(
      dispatchBinaryStorageFor({
        agentKind: 'coder',
        agentKindRegistry: registry,
        step: step({
          agentKind: 'coder',
          stepOptions: { binaryOutput: { storageServiceId: 'asset-store' } },
        }),
      }),
    ).toBeUndefined()
  })

  it('answers nothing for a briefed step that selected no storage', () => {
    expect(
      dispatchBinaryStorageFor({
        agentKind: 'image-generator',
        agentKindRegistry: registry,
        step: step(),
      }),
    ).toBeUndefined()
  })
})
