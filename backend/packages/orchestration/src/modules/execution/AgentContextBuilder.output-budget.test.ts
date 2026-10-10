import { describe, expect, it } from 'vitest'
import type {
  Block,
  ExecutionInstance,
  PipelineStep,
  StepOptions,
  WorkspaceAgentSettingsRepository,
} from '@cat-factory/kernel'
import { InitiativePresetRegistry } from '@cat-factory/kernel'
import { AgentContextBuilder, type AgentContextBuilderDeps } from './AgentContextBuilder.js'
import { defaultAgentKindRegistry } from '@cat-factory/agents'

// The output-token ceiling a dispatch runs under is resolved ONCE per dispatch, here in the
// engine, and folded onto the context every executor reads — so the container, inline and
// consensus paths cannot disagree about the budget a step ran under.
//
// What these pin is the PRECEDENCE, narrowest tier first: the pipeline step's own option beats
// the workspace's per-kind setting, which beats the deployment routing default (expressed here as
// "absent from the context", since the executor is what applies its own fallback). Each rung
// getting this wrong is silent — the run completes, just truncated or over-budget — so the order
// is asserted rather than left to whichever tier a test happens to set.

function step(agentKind = 'doc-researcher', stepOptions?: StepOptions): PipelineStep {
  return { agentKind, state: 'running', progress: 0, stepOptions } as unknown as PipelineStep
}

function instance(steps: PipelineStep[]): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: 'task_1',
    pipelineName: 'Docs',
    status: 'running',
    currentStep: 0,
    steps,
  } as unknown as ExecutionInstance
}

const TASK = {
  id: 'task_1',
  title: 'Write the API guide',
  type: 'service',
  description: '',
  level: 'task',
  parentId: null,
} as unknown as Block

/** A settings store holding one kind's ceiling; every other kind reads as inheriting. */
function settingsRepo(
  row: { agentKind: string; maxOutputTokens: number | null } | null,
): WorkspaceAgentSettingsRepository {
  return {
    get: async (_ws, agentKind) =>
      row && row.agentKind === agentKind
        ? { agentKind, maxOutputTokens: row.maxOutputTokens, updatedAt: 1 }
        : null,
    list: async () => [],
    upsert: async () => undefined,
    remove: async () => undefined,
  }
}

function makeBuilder(over: Partial<AgentContextBuilderDeps> = {}): AgentContextBuilder {
  const blocks = new Map<string, Block>([[TASK.id, TASK]])
  return new AgentContextBuilder({
    workspaceRepository: { get: async () => null } as never,
    blockRepository: { get: async (_ws: string, id: string) => blocks.get(id) ?? null } as never,
    accountRepository: { get: async () => null } as never,
    agentKindRegistry: defaultAgentKindRegistry(),
    initiativePresetRegistry: new InitiativePresetRegistry(),
    ...over,
  })
}

async function contextFor(deps: Partial<AgentContextBuilderDeps>, s: PipelineStep) {
  return makeBuilder(deps).buildContext('ws1', instance([s]), s, true, TASK)
}

describe('AgentContextBuilder output-token ceiling', () => {
  it('folds the workspace setting for the dispatched kind onto the context', async () => {
    const context = await contextFor(
      { agentSettings: settingsRepo({ agentKind: 'doc-researcher', maxOutputTokens: 24_000 }) },
      step(),
    )
    expect(context.maxOutputTokens).toBe(24_000)
  })

  it("lets the step's own option win over the workspace setting", async () => {
    const context = await contextFor(
      { agentSettings: settingsRepo({ agentKind: 'doc-researcher', maxOutputTokens: 24_000 }) },
      step('doc-researcher', { maxOutputTokens: 40_000 }),
    )
    expect(context.maxOutputTokens).toBe(40_000)
  })

  it("honours the step's option with no workspace setting and no wired store", async () => {
    const context = await contextFor({}, step('doc-researcher', { maxOutputTokens: 12_000 }))
    expect(context.maxOutputTokens).toBe(12_000)
  })

  it('leaves the ceiling absent for a kind the workspace has not configured', async () => {
    const context = await contextFor(
      { agentSettings: settingsRepo({ agentKind: 'coder', maxOutputTokens: 8_000 }) },
      step(),
    )
    expect(context.maxOutputTokens).toBeUndefined()
  })

  it('treats a stored null ceiling as inheriting, not as a zero budget', async () => {
    // The service normally deletes the row instead of storing null, but the column is nullable —
    // and reading it as a ceiling would hand the executor 0, making every reply come back empty.
    const context = await contextFor(
      { agentSettings: settingsRepo({ agentKind: 'doc-researcher', maxOutputTokens: null }) },
      step(),
    )
    expect(context.maxOutputTokens).toBeUndefined()
  })

  it('resolves nothing when the settings store is not wired', async () => {
    const context = await contextFor({}, step())
    expect(context.maxOutputTokens).toBeUndefined()
  })

  it('ignores an unrelated step option rather than reading it as a ceiling', async () => {
    const context = await contextFor({}, step('doc-researcher', { autoRecommend: false }))
    expect(context.maxOutputTokens).toBeUndefined()
  })

  it('keys off the EFFECTIVE dispatched kind, so a gate helper gets its own ceiling', async () => {
    // A `ci` gate dispatches its `ci-fixer` helper off the hosting step, whose own kind is the
    // gate. The ceiling must follow what actually RUNS — inheriting the parent step's budget
    // would silently apply a doc-sized budget to a code fixer (or the reverse).
    const s = step('ci')
    const context = await makeBuilder({
      agentSettings: settingsRepo({ agentKind: 'ci-fixer', maxOutputTokens: 6_000 }),
    }).buildContext('ws1', instance([s]), s, true, TASK, { agentKind: 'ci-fixer' })
    expect(context.maxOutputTokens).toBe(6_000)
  })
})
