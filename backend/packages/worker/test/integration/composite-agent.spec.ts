import { describe, expect, it } from 'vitest'
import type { AgentExecutor, AgentRunContext, AgentRunResult } from '@cat-factory/core'
import { CompositeAgentExecutor } from '../../src/infrastructure/ai/CompositeAgentExecutor'

// CompositeAgentExecutor must send only the implementation (`coder`) step to the
// container, leaving every other agent kind on the inline executor.

class Tagged implements AgentExecutor {
  constructor(private readonly tag: string) {}
  run(_context: AgentRunContext): Promise<AgentRunResult> {
    return Promise.resolve({ output: this.tag })
  }
}

function ctx(agentKind: string): AgentRunContext {
  return {
    agentKind,
    pipelineName: 'P',
    stepIndex: 0,
    isFinalStep: true,
    block: { title: 'T', type: 'service', description: 'D' },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
  }
}

describe('CompositeAgentExecutor', () => {
  const composite = new CompositeAgentExecutor(new Tagged('inline'), new Tagged('container'))

  it('routes coder to the container executor', async () => {
    expect((await composite.run(ctx('coder'))).output).toBe('container')
  })

  it('routes other kinds to the inline executor', async () => {
    for (const kind of ['architect', 'reviewer', 'tester', 'documenter', 'custom-x']) {
      expect((await composite.run(ctx(kind))).output).toBe('inline')
    }
  })
})
