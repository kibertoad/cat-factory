import { describe, expect, it } from 'vitest'
import type { Block, ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import { InitiativePresetRegistry } from '@cat-factory/kernel'
import { defaultAgentKindRegistry } from '@cat-factory/agents'
import { AgentContextBuilder } from './AgentContextBuilder.js'

// The WIRING half of the open-findings slice: `openFindingsFor` decides what is open and
// `renderOpenFindings` writes it, but only the builder joins them to the run. It is asserted here
// because the seam is easy to break silently: the registry argument `priorOutputsFor` needs is
// optional, so dropping it typechecks and simply stops resolving a deployment's own companions.

const TASK = {
  id: 'task_1',
  title: 'Stand up the catalog API',
  type: 'service',
  description: 'A small Fastify service.',
  level: 'task',
  parentId: null,
} as unknown as Block

function run(verdictComments: { body: string; severity: 'blocker' | 'major' | 'minor' }[]) {
  const steps = [
    { agentKind: 'architect', state: 'done', progress: 1, output: 'Step 2: one tsconfig.' },
    {
      agentKind: 'architect-companion',
      state: 'done',
      progress: 1,
      companion: {
        threshold: 0.8,
        maxAttempts: 3,
        attempts: 1,
        verdicts: [
          { rating: 0.83, threshold: 0.8, passed: true, feedback: 'ok', comments: verdictComments },
        ],
      },
    },
    { agentKind: 'coder', state: 'running', progress: 0 },
  ] as unknown as PipelineStep[]
  return {
    id: 'exec_1',
    blockId: TASK.id,
    pipelineName: 'Standard build',
    status: 'running',
    currentStep: 2,
    steps,
  } as unknown as ExecutionInstance
}

async function coderContext(comments: { body: string; severity: 'blocker' | 'major' | 'minor' }[]) {
  const instance = run(comments)
  const registry = defaultAgentKindRegistry()
  registry.register({ kind: 'architect', systemPrompt: 'You design.' })
  registry.register({ kind: 'architect-companion', systemPrompt: 'You grade.' })
  registry.registerCompanion({
    kind: 'architect-companion',
    targets: ['architect'],
    defaultThreshold: 0.8,
    reviews: 'the design',
  })
  const builder = new AgentContextBuilder({
    workspaceRepository: { get: async () => null } as never,
    blockRepository: { get: async () => TASK } as never,
    accountRepository: { get: async () => null } as never,
    agentKindRegistry: registry,
    initiativePresetRegistry: new InitiativePresetRegistry(),
  })
  return builder.buildContext('ws1', instance, instance.steps[2]!, false, TASK)
}

describe('AgentContextBuilder open findings', () => {
  it('hands the coder the design findings the companion passed the work with', async () => {
    // The run this was written from: a `major` naming a build-breaking tsconfig cleared the bar at
    // 0.83, and the coder that implemented that tsconfig was never told.
    const context = await coderContext([
      { body: 'rootDir src breaks the build', severity: 'major' },
      { body: 'a wording nit', severity: 'minor' },
    ])

    const design = context.priorOutputs.find((p) => p.agentKind === 'architect')
    expect(design?.openFindings?.map((f) => f.body)).toEqual(['rootDir src breaks the build'])
  })

  it('leaves priorOutputs unannotated when the review left nothing open', async () => {
    const context = await coderContext([{ body: 'a wording nit', severity: 'minor' }])
    expect(
      context.priorOutputs.find((p) => p.agentKind === 'architect')?.openFindings,
    ).toBeUndefined()
  })
})
