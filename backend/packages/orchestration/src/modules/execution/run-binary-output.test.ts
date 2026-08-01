import { AgentKindRegistry, BINARY_OUTPUT_TRAIT } from '@cat-factory/agents'
import type { PipelineStep } from '@cat-factory/contracts'
import { BINARY_OUTPUT_BRIEF_FILE, BINARY_OUTPUT_DECLARATION_TAG } from '@cat-factory/kernel'
import { describe, expect, it, vi } from 'vitest'
import type { FoundationalServiceResolver } from './run-foundational-services.js'
import {
  createBinaryOutputDeclarationRecorder,
  resolveBinaryOutputContext,
} from './run-binary-output.js'

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
    expect(deps.binaryOutputContextFilesFor).toHaveBeenCalledWith('ws', {
      storageServiceId: 'asset-store',
    })
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

  it('leaves a non-trait step unannotated', async () => {
    const target = step({ agentKind: 'coder' })
    await createBinaryOutputDeclarationRecorder({
      agentKindRegistry: registry,
      foundationalServiceResolver: resolver(),
    })('ws', target, declaration)
    expect(target.binaryOutputs).toBeUndefined()
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
})
