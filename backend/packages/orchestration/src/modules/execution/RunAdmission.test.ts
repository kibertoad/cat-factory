import { AgentKindRegistry } from '@cat-factory/agents'
import type { Block } from '@cat-factory/kernel'
import {
  ASSET_STORAGE_CAPABILITY,
  ConflictError,
  UnavailableError,
  ValidationError,
  defaultBinaryGeneratorRegistry,
  registryBinaryGeneratorSource,
} from '@cat-factory/kernel'
import { describe, expect, it, vi } from 'vitest'
import type { FoundationalServiceResolver } from './run-foundational-services.js'
import { RunAdmission, type RunAdmissionDeps } from './RunAdmission.js'

// Focused coverage of the BINARY-OUTPUT admission guard (the rest of the `assert*` family is
// exercised through the engine's integration suites). The stubs satisfy exactly the reads a
// non-visual, non-tester, non-deployer chain takes through `assertRunnable`.

const registry = new AgentKindRegistry()
registry.register({
  kind: 'image-generator',
  systemPrompt: 'You generate images.',
  traits: ['binary-output'],
})

const block = { id: 'b1', level: 'task', dependsOn: [], title: 'T' } as unknown as Block

function catalogResolver(
  services: { id: string; capabilities: string[] }[],
): FoundationalServiceResolver {
  return {
    catalogFor: vi.fn(async () =>
      services.map((s) => ({
        ...s,
        name: s.id,
        summary: '',
        description: '',
        contracts: [],
      })),
    ),
    catalogIdsFor: vi.fn(async () => services.map((s) => s.id)),
    contextFilesFor: vi.fn(async () => []),
    binaryOutputContextFilesFor: vi.fn(async () => []),
  }
}

/** A deployment registering one image integration and one music integration. */
function generatorRegistry() {
  const generators = defaultBinaryGeneratorRegistry()
  generators.registerAll([
    {
      id: 'retro-diffusion',
      name: 'Retro Diffusion',
      summary: 'Pixel-art image generation.',
      description: '',
      modalities: ['image'],
    },
    {
      id: 'studio-music',
      name: 'Studio Music',
      summary: 'Instrumental music generation.',
      description: '',
      modalities: ['audio'],
    },
    // The one that pins its formats down. `3d` is the modality where the container IS the
    // requirement: a Godot importer takes GLB and not USDZ, and neither opens in an art pipeline.
    {
      id: 'meshy',
      name: 'Meshy',
      summary: 'Text- and image-to-3D.',
      description: '',
      modalities: ['3d-model'],
      mediaTypes: ['model/gltf-binary', 'model/obj'],
    },
  ])
  return generators
}

function admission(
  resolver?: FoundationalServiceResolver,
  generatorSource = registryBinaryGeneratorSource(generatorRegistry()),
): RunAdmission {
  const deps = {
    workspaceRepository: { accountOf: vi.fn(async () => 'acc') },
    blockRepository: { listByWorkspace: vi.fn(async () => []) },
    executionRepository: { listLive: vi.fn(async () => []) },
    contextBuilder: {
      resolveServiceFrame: vi.fn(async () => null),
      resolveServiceConfig: vi.fn(async () => null),
      resolveFrontendConfig: vi.fn(async () => null),
    },
    agentKindRegistry: registry,
    spend: { isOverBudget: vi.fn(async () => false) },
    ...(resolver ? { foundationalServiceResolver: resolver } : {}),
    binaryGeneratorSource: generatorSource,
  } as unknown as RunAdmissionDeps
  return new RunAdmission(deps)
}

async function refusal(run: Promise<void>): Promise<ConflictError> {
  try {
    await run
  } catch (error) {
    expect(error).toBeInstanceOf(ConflictError)
    return error as ConflictError
  }
  throw new Error('expected the admission to refuse')
}

describe('RunAdmission — binary-output selection', () => {
  const storage = { id: 'asset-store', capabilities: [ASSET_STORAGE_CAPABILITY] }
  const inventory = { id: 'entity-inventory', capabilities: ['generation-context'] }

  it('refuses a generator step with NO selection as a structural fault (the shape check)', async () => {
    await expect(
      admission(catalogResolver([storage])).assertRunnable(
        'ws',
        block,
        { agentKinds: ['image-generator'], stepOptions: [null] },
        null,
      ),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('refuses a storage id the catalog does not contain', async () => {
    const error = await refusal(
      admission(catalogResolver([storage])).assertRunnable(
        'ws',
        block,
        {
          agentKinds: ['image-generator'],
          stepOptions: [{ binaryOutput: { storageServiceId: 'gone' } }],
        },
        null,
      ),
    )
    expect(error.details).toMatchObject({
      reason: 'binary_output_service_invalid',
      serviceId: 'gone',
      problem: 'unknown_service',
      role: 'storage',
    })
  })

  it('refuses a storage service without the asset-storage capability tag', async () => {
    const error = await refusal(
      admission(catalogResolver([inventory])).assertRunnable(
        'ws',
        block,
        {
          agentKinds: ['image-generator'],
          stepOptions: [{ binaryOutput: { storageServiceId: 'entity-inventory' } }],
        },
        null,
      ),
    )
    expect(error.details).toMatchObject({ problem: 'not_storage_capable' })
  })

  it('refuses an unknown CONTEXT id too — a typo there silently thins the scope', async () => {
    const error = await refusal(
      admission(catalogResolver([storage])).assertRunnable(
        'ws',
        block,
        {
          agentKinds: ['image-generator'],
          stepOptions: [
            { binaryOutput: { storageServiceId: 'asset-store', contextServiceIds: ['gone'] } },
          ],
        },
        null,
      ),
    )
    expect(error.details).toMatchObject({ serviceId: 'gone', role: 'context' })
  })

  it('names EVERY unresolved id, so one edit clears the refusal', async () => {
    // Surfacing only the first would cost a refuse-fix-restart round per lost service, each one a
    // full admission cycle. `details.issues` is the machine-readable whole; the headline fields
    // stay for the SPA toast.
    const error = await refusal(
      admission(catalogResolver([storage])).assertRunnable(
        'ws',
        block,
        {
          agentKinds: ['image-generator'],
          stepOptions: [
            {
              binaryOutput: {
                storageServiceId: 'gone-store',
                contextServiceIds: ['gone-inventory', 'entity-inventory'],
              },
            },
          ],
        },
        null,
      ),
    )
    expect(error.details).toMatchObject({
      reason: 'binary_output_service_invalid',
      serviceId: 'gone-store',
      issues: [
        { role: 'storage', serviceId: 'gone-store', problem: 'unknown_service' },
        { role: 'context', serviceId: 'gone-inventory', problem: 'unknown_service' },
        { role: 'context', serviceId: 'entity-inventory', problem: 'unknown_service' },
      ],
    })
    expect(error.message).toContain('gone-inventory')
    expect(error.message).toContain('entity-inventory')
  })

  it('admits a resolvable selection, and a chain with no generator step at all', async () => {
    const adm = admission(catalogResolver([storage, inventory]))
    await expect(
      adm.assertRunnable(
        'ws',
        block,
        {
          agentKinds: ['image-generator'],
          stepOptions: [
            {
              binaryOutput: {
                storageServiceId: 'asset-store',
                contextServiceIds: ['entity-inventory'],
              },
            },
          ],
        },
        null,
      ),
    ).resolves.toBeUndefined()
    await expect(
      adm.assertRunnable('ws', block, { agentKinds: ['coder'] }, null),
    ).resolves.toBeUndefined()
  })

  it('skips resolution with no catalog seam wired (presence still holds via the shape check)', async () => {
    await expect(
      admission().assertRunnable(
        'ws',
        block,
        {
          agentKinds: ['image-generator'],
          stepOptions: [{ binaryOutput: { storageServiceId: 'anything' } }],
        },
        null,
      ),
    ).resolves.toBeUndefined()
    await expect(
      admission().assertRunnable(
        'ws',
        block,
        { agentKinds: ['image-generator'], stepOptions: [null] },
        null,
      ),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('imposes nothing on a DISABLED generator step', async () => {
    await expect(
      admission(catalogResolver([])).assertRunnable(
        'ws',
        block,
        { agentKinds: ['image-generator'], enabled: [false], stepOptions: [null] },
        null,
      ),
    ).resolves.toBeUndefined()
  })
})

describe('RunAdmission — generative integration selection', () => {
  const storageOnly = () =>
    catalogResolver([{ id: 'asset-store', capabilities: [ASSET_STORAGE_CAPABILITY] }])

  it('admits a selection whose integrations cover every content type the step declares', async () => {
    await expect(
      admission(storageOnly()).assertRunnable(
        'ws',
        block,
        {
          agentKinds: ['image-generator'],
          stepOptions: [
            {
              binaryOutput: {
                storageServiceId: 'asset-store',
                generatorIds: ['retro-diffusion', 'studio-music'],
                modalities: ['image', 'audio'],
              },
            },
          ],
        },
        null,
      ),
    ).resolves.toBeUndefined()
  })

  it('refuses an integration id the deployment does not register, under its OWN reason', async () => {
    // A separate reason from `binary_output_service_invalid` on purpose: that one is fixed in the
    // workspace catalog, this one in the deployment's build. One reason would send half the
    // readers to the wrong place.
    const error = await refusal(
      admission(storageOnly()).assertRunnable(
        'ws',
        block,
        {
          agentKinds: ['image-generator'],
          stepOptions: [
            {
              binaryOutput: { storageServiceId: 'asset-store', generatorIds: ['ghost-synth'] },
            },
          ],
        },
        null,
      ),
    )
    expect(error.details).toMatchObject({
      reason: 'binary_output_generator_invalid',
      problem: 'unknown_generator',
      generatorId: 'ghost-synth',
    })
  })

  it('refuses a content type no selected integration produces', async () => {
    const error = await refusal(
      admission(storageOnly()).assertRunnable(
        'ws',
        block,
        {
          agentKinds: ['image-generator'],
          stepOptions: [
            {
              binaryOutput: {
                storageServiceId: 'asset-store',
                generatorIds: ['retro-diffusion'],
                modalities: ['image', 'audio'],
              },
            },
          ],
        },
        null,
      ),
    )
    expect(error.details).toMatchObject({
      reason: 'binary_output_generator_invalid',
      problem: 'modality_uncovered',
      modality: 'audio',
    })
    expect(error.message).toContain('audio')
  })

  it('refuses a FORMAT no selected integration emits, one notch under the content type', async () => {
    // The failure this rule exists for: a mesh delivered in a container the engine cannot import
    // is not a thinner deliverable, and at the end of a paid run it reads as a bad generation.
    const error = await refusal(
      admission(storageOnly()).assertRunnable(
        'ws',
        block,
        {
          agentKinds: ['image-generator'],
          stepOptions: [
            {
              binaryOutput: {
                storageServiceId: 'asset-store',
                generatorIds: ['meshy'],
                modalities: ['3d-model'],
                mediaTypes: ['model/gltf-binary', 'model/fbx'],
              },
            },
          ],
        },
        null,
      ),
    )
    expect(error.details).toMatchObject({
      reason: 'binary_output_generator_invalid',
      problem: 'media_type_uncovered',
      mediaType: 'model/fbx',
    })
    expect(error.message).toContain('model/fbx')
  })

  it('admits a format an integration DECLINED to declare rather than punishing the honesty', async () => {
    // `retro-diffusion` declares no `mediaTypes` — a documented "only the modality is known"
    // state, not an empty answer. The run starts and the gap is stated in the brief instead.
    await expect(
      admission(storageOnly()).assertRunnable(
        'ws',
        block,
        {
          agentKinds: ['image-generator'],
          stepOptions: [
            {
              binaryOutput: {
                storageServiceId: 'asset-store',
                generatorIds: ['retro-diffusion'],
                mediaTypes: ['image/webp'],
              },
            },
          ],
        },
        null,
      ),
    ).resolves.toBeUndefined()
  })

  it('refuses the generative half even with NO catalog seam wired', async () => {
    // The registry is in-process composition data, so this check needs no I/O and must not be
    // skipped alongside the catalog read — a deployment with no catalog can still point a step at
    // an integration it never registered.
    const error = await refusal(
      admission().assertRunnable(
        'ws',
        block,
        {
          agentKinds: ['image-generator'],
          stepOptions: [
            { binaryOutput: { storageServiceId: 'anything', generatorIds: ['ghost-synth'] } },
          ],
        },
        null,
      ),
    )
    expect(error.details).toMatchObject({ reason: 'binary_output_generator_invalid' })
  })

  it('refuses an UNREADABLE integration set as an outage, never as an unknown generator', async () => {
    // The disposition that carries the mothership-mode seam. Softening an unreachable source to
    // an empty one would refuse every generator-selecting step with `unknown_generator` for the
    // duration of the outage — a false configuration error, reported against the very step the
    // product's own picker filled in, which is the misattribution the remote source exists to
    // remove. Admitting anyway is the other wrong answer: the run would dispatch with no brief
    // and no credential, and the agent would discover at the end of a paid run that it had
    // nothing to generate with.
    const unreachable = {
      views: async () => {
        throw new UnavailableError(
          'The deployment’s generative integrations could not be read from the mothership',
          'binary_generators_unreachable',
          { status: 503 },
        )
      },
      documentsFor: async () => new Map(),
    }
    await expect(
      admission(
        catalogResolver([{ id: 'asset-store', capabilities: [ASSET_STORAGE_CAPABILITY] }]),
        unreachable,
      ).assertRunnable(
        'ws',
        block,
        {
          agentKinds: ['image-generator'],
          stepOptions: [
            {
              // An id this deployment DOES register — so an empty-set reading would have called
              // it unknown, which is exactly the claim that must not be made.
              binaryOutput: { storageServiceId: 'asset-store', generatorIds: ['retro-diffusion'] },
            },
          ],
        },
        null,
      ),
    ).rejects.toMatchObject({
      code: 'unavailable',
      details: { reason: 'binary_generators_unreachable' },
    })
  })
})

// The START-GUARD half of how a preset's route order reaches a run. The dispatch half rides
// `AgentRunContext.providerPreference`; this half rides the capability set the guard resolves, and
// wiring only one is silent either way — a run ADMITTED against a route it never takes, or every
// dispatch quietly on the deployment's default order.
describe('RunAdmission — the capability set is resolved under the block’s preset', () => {
  function capabilityAdmission() {
    const resolveProviderCapabilities = vi.fn(async () => ({
      directProviders: new Set<string>(),
      subscriptionVendors: new Set<string>(),
      cloudflareEnabled: true,
    }))
    const deps = {
      workspaceRepository: { accountOf: vi.fn(async () => 'acc') },
      blockRepository: { listByWorkspace: vi.fn(async () => []) },
      executionRepository: { listLive: vi.fn(async () => []) },
      contextBuilder: {
        resolveServiceFrame: vi.fn(async () => null),
        resolveServiceConfig: vi.fn(async () => null),
        resolveFrontendConfig: vi.fn(async () => null),
      },
      agentKindRegistry: registry,
      spend: { isOverBudget: vi.fn(async () => false) },
      binaryGeneratorSource: registryBinaryGeneratorSource(generatorRegistry()),
      resolveProviderCapabilities,
    } as unknown as RunAdmissionDeps
    return { admission: new RunAdmission(deps), resolveProviderCapabilities }
  }

  it('passes the block’s SELECTED preset id, so the guard walks the dispatch order', async () => {
    const { admission: guard, resolveProviderCapabilities } = capabilityAdmission()
    const pinned = { ...block, modelPresetId: 'mdp_compliance' } as unknown as Block
    await guard.assertRunnable('ws', pinned, { agentKinds: ['coder'], stepOptions: [null] }, 'u1')
    expect(resolveProviderCapabilities).toHaveBeenCalledWith('ws', 'u1', 'mdp_compliance')
  })

  it('passes undefined when the block selects none (⇒ the workspace default preset)', async () => {
    const { admission: guard, resolveProviderCapabilities } = capabilityAdmission()
    await guard.assertRunnable('ws', block, { agentKinds: ['coder'], stepOptions: [null] }, 'u1')
    expect(resolveProviderCapabilities).toHaveBeenCalledWith('ws', 'u1', undefined)
  })
})
