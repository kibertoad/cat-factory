import { describe, expect, it } from 'vitest'
import type { AgentExecutor, AgentRunContext, AgentRunResult } from '@cat-factory/core'
import { CompositeAgentExecutor } from '../../src/infrastructure/ai/CompositeAgentExecutor'

// CompositeAgentExecutor must send the repo-operating steps — implementation
// (`coder`), the mock builder (`mocker`) and the Playwright e2e writer
// (`playwright`) — to the container, leaving every other agent kind (including
// the `acceptance` scenario writer) on the inline executor.

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

  it('routes repo-operating kinds to the container executor', async () => {
    for (const kind of ['coder', 'mocker', 'playwright']) {
      expect((await composite.run(ctx(kind))).output).toBe('container')
    }
  })

  it('routes other kinds to the inline executor', async () => {
    for (const kind of ['architect', 'reviewer', 'tester', 'acceptance', 'documenter', 'custom-x']) {
      expect((await composite.run(ctx(kind))).output).toBe('inline')
    }
  })
})
