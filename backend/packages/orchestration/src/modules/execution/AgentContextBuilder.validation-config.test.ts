import { describe, expect, it } from 'vitest'
import type { Block, ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import { createRecordingLogger, InitiativePresetRegistry } from '@cat-factory/kernel'
import { AgentContextBuilder, type AgentContextBuilderDeps } from './AgentContextBuilder.js'
import { defaultAgentKindRegistry } from '@cat-factory/agents'

// A dispatch whose validation-config read FAILS runs with no checks and no dependency install,
// the same context an unconfigured service produces, deliberately, so a store outage can never
// wedge every coding run. These tests pin the other half of that bargain: the two causes are told
// apart on the step and reported to the operator, so neither the PR verification report nor a
// human reading the logs can mistake "could not read" for "configures none".

function step(over: Partial<PipelineStep> = {}): PipelineStep {
  return { agentKind: 'coder', state: 'running', progress: 0, ...over } as unknown as PipelineStep
}

function instance(steps: PipelineStep[]): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: 'frame_1',
    pipelineName: 'Build',
    status: 'running',
    currentStep: 0,
    steps,
  } as unknown as ExecutionInstance
}

const FRAME = {
  id: 'frame_1',
  title: 'Auth service',
  type: 'service',
  description: 'do the thing',
  level: 'frame',
  parentId: null,
} as unknown as Block

function makeDeps(over: Partial<AgentContextBuilderDeps> = {}): AgentContextBuilderDeps {
  return {
    workspaceRepository: { get: async () => null } as never,
    blockRepository: {
      get: async (_ws: string, id: string) => (id === FRAME.id ? FRAME : null),
      listByWorkspace: async () => [FRAME],
    } as never,
    accountRepository: { get: async () => null } as never,
    agentKindRegistry: defaultAgentKindRegistry(),
    initiativePresetRegistry: new InitiativePresetRegistry(),
    ...over,
  }
}

describe('a validation-config read that FAILS', () => {
  it('degrades to no checks, marks the step, and reports the cause to the operator', async () => {
    const logger = createRecordingLogger()
    const deps = makeDeps({
      logger,
      resolveValidationChecks: async () => {
        throw new Error('D1_ERROR: no such table: validation_configs')
      },
    })
    const s = step()
    const context = await new AgentContextBuilder(deps).buildContext(
      'ws1',
      instance([s]),
      s,
      true,
      FRAME,
    )

    // The run is NOT wedged: the dispatch proceeds with exactly the unconfigured context.
    expect(context.validationChecks).toBeUndefined()
    expect(context.dependencyInstall).toBeUndefined()
    // But the fact rides the step, which is what carries it onto the PR verification report.
    expect(s.validationConfigUnreadable).toBe(true)
    const warned = logger.lines.find((l) => l.level === 'warn' && l.msg.includes('Validation'))
    expect(warned).toBeDefined()
    // The frame is the actionable identifier (the config is keyed by it) and the cause has to
    // survive: a warning that says only "it failed" leaves the operator exactly where they were.
    expect(warned?.fields.frameId).toBe('frame_1')
    expect(String(warned?.fields.err)).toContain('no such table')
  })

  it('is NOT confused with a service that configured nothing', async () => {
    // The whole point of the flag: `null` is the ordinary unconfigured answer and must leave the
    // step clean, or every run on every unconfigured service would cry outage.
    const s = step()
    const deps = makeDeps({ resolveValidationChecks: async () => null })
    await new AgentContextBuilder(deps).buildContext('ws1', instance([s]), s, true, FRAME)
    expect(s.validationConfigUnreadable).toBeUndefined()
  })

  it('is cleared by a re-dispatch whose read succeeds', async () => {
    // The flag describes the read behind the tree THIS step pushed, not a high-water mark: a
    // transient outage that recovered before the PR-opening dispatch must not leave the report
    // warning about checks that did in fact run.
    let failing = true
    const deps = makeDeps({
      resolveValidationChecks: async () => {
        if (failing) throw new Error('store unavailable')
        return { checks: [{ label: 'test', command: 'npm test' }], maxAttempts: 3 }
      },
    })
    const builder = new AgentContextBuilder(deps)
    const s = step()
    await builder.buildContext('ws1', instance([s]), s, true, FRAME)
    expect(s.validationConfigUnreadable).toBe(true)

    failing = false
    const context = await builder.buildContext('ws1', instance([s]), s, true, FRAME)
    expect(s.validationConfigUnreadable).toBeUndefined()
    expect(context.validationChecks?.checks).toHaveLength(1)
  })
})
