import { defaultAgentKindRegistry } from '@cat-factory/agents'
import type { PipelineStep } from '@cat-factory/contracts'
import { FOUNDATIONAL_CATALOG_FILE, FOUNDATIONAL_INDEX_FILE } from '@cat-factory/kernel'
import { describe, expect, it, vi } from 'vitest'
import {
  type FoundationalServiceResolver,
  declaredSelection,
  createFoundationalDeclarationRecorder,
  resolveFoundationalContext,
} from './run-foundational-services.js'

const registry = defaultAgentKindRegistry()

const step = (overrides: Partial<PipelineStep> = {}): PipelineStep =>
  ({ agentKind: 'architect', state: 'done', ...overrides }) as PipelineStep

function resolver(overrides: Partial<FoundationalServiceResolver> = {}) {
  return {
    catalogFor: vi.fn(async () => [
      {
        id: 'file-storage',
        name: 'File Storage',
        summary: 'Stores uploads.',
        description: '',
        capabilities: [],
        contracts: [],
      },
    ]),
    catalogIdsFor: vi.fn(async () => ['file-storage']),
    contextFilesFor: vi.fn(async () => [{ path: FOUNDATIONAL_INDEX_FILE, content: 'index' }]),
    binaryOutputContextFilesFor: vi.fn(async () => []),
    ...overrides,
  } satisfies FoundationalServiceResolver & Record<string, unknown>
}

describe('resolveFoundationalContext', () => {
  it('gives a design kind the CATALOG file', async () => {
    const deps = resolver()
    const files = await resolveFoundationalContext({
      workspaceId: 'ws',
      agentKind: 'architect',
      agentKindRegistry: registry,
      priorSteps: [],
      foundationalServiceResolver: deps,
    })
    expect(files.map((f) => f.path)).toEqual([FOUNDATIONAL_CATALOG_FILE])
    expect(deps.contextFilesFor).not.toHaveBeenCalled()
  })

  it('gives a consumer kind the declared services’ CONTRACTS, never the catalog', async () => {
    const deps = resolver()
    for (const agentKind of ['coder', 'researcher']) {
      const files = await resolveFoundationalContext({
        workspaceId: 'ws',
        agentKind,
        agentKindRegistry: registry,
        priorSteps: [step({ foundationalServices: { declared: ['file-storage'], unknown: [] } })],
        foundationalServiceResolver: deps,
      })
      expect(files.map((f) => f.path)).toEqual([FOUNDATIONAL_INDEX_FILE])
    }
    expect(deps.contextFilesFor).toHaveBeenCalledWith('ws', {
      declared: ['file-storage'],
      unknown: [],
    })
    expect(deps.catalogFor).not.toHaveBeenCalled()
  })

  it('gives an unrelated kind nothing, and pays for nothing', async () => {
    const deps = resolver()
    expect(
      await resolveFoundationalContext({
        workspaceId: 'ws',
        agentKind: 'merger',
        agentKindRegistry: registry,
        priorSteps: [],
        foundationalServiceResolver: deps,
      }),
    ).toEqual([])
    expect(deps.catalogFor).not.toHaveBeenCalled()
    expect(deps.contextFilesFor).not.toHaveBeenCalled()
  })

  it('injects nothing when the catalog is not wired', async () => {
    expect(
      await resolveFoundationalContext({
        workspaceId: 'ws',
        agentKind: 'architect',
        agentKindRegistry: registry,
        priorSteps: [],
      }),
    ).toEqual([])
  })

  it('degrades to no files (never a thrown run) when the catalog read fails', async () => {
    const files = await resolveFoundationalContext({
      workspaceId: 'ws',
      agentKind: 'architect',
      agentKindRegistry: registry,
      priorSteps: [],
      foundationalServiceResolver: resolver({
        catalogFor: vi.fn(async () => {
          throw new Error('store unreachable')
        }),
      }),
    })
    expect(files).toEqual([])
  })
})

describe('declaredSelection', () => {
  it('takes the LAST prior declaration, so a reworked design supersedes its first pass', () => {
    expect(
      declaredSelection([
        step({ foundationalServices: { declared: ['file-storage'], unknown: [] } }),
        step({ foundationalServices: { declared: ['notifications'], unknown: [] } }),
      ]),
    ).toEqual({ declared: ['notifications'], unknown: [] })
  })

  it('distinguishes an empty declaration from no declaration at all', () => {
    expect(
      declaredSelection([step({ foundationalServices: { declared: [], unknown: [] } })]),
    ).toEqual({ declared: [], unknown: [] })
    expect(declaredSelection([step()])).toBeUndefined()
  })
})

describe('createFoundationalDeclarationRecorder', () => {
  const declare = async (agentKind: string, output: string | undefined) => {
    const target = step({ agentKind })
    const record = createFoundationalDeclarationRecorder({
      agentKindRegistry: registry,
      foundationalServiceResolver: resolver(),
    })
    await record('ws', target, output)
    return target.foundationalServices
  }

  it('binds to a no-op when the catalog is not wired', async () => {
    const target = step()
    await createFoundationalDeclarationRecorder({ agentKindRegistry: registry })(
      'ws',
      target,
      '```foundational-services\nfile-storage\n```',
    )
    expect(target.foundationalServices).toBeUndefined()
  })

  it('splits the declared ids into resolved and unknown', async () => {
    expect(
      await declare('architect', 'design\n```foundational-services\nfile-storage\nmade-up\n```'),
    ).toEqual({ declared: ['file-storage'], unknown: ['made-up'] })
  })

  it('records an EMPTY selection for a design that declared none — a real, distinct answer', async () => {
    expect(await declare('architect', '```foundational-services\nnone\n```')).toEqual({
      declared: [],
      unknown: [],
    })
  })

  it('records nothing for a kind that does not carry the design trait', async () => {
    expect(await declare('coder', '```foundational-services\nfile-storage\n```')).toBeUndefined()
  })
})
