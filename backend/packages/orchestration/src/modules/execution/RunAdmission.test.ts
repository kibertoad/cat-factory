import { AgentKindRegistry } from '@cat-factory/agents'
import type { Block } from '@cat-factory/kernel'
import { ASSET_STORAGE_CAPABILITY, ConflictError, ValidationError } from '@cat-factory/kernel'
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

function admission(resolver?: FoundationalServiceResolver): RunAdmission {
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
