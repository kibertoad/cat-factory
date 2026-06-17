import { AiAgentExecutor, type AgentRouting } from '@cat-factory/agents'
import type { CodeReviewFixture } from '../fixtures'
import type { RunnerInput, RunnerOutput } from './types'

// Code-review candidate: reuses the real `reviewer` agent (AiAgentExecutor +
// the standard 'review' phase prompt/template). The prompt variant is injected
// through the agent routing's per-kind `system`/temperature override, so the
// only thing that changes between cells is the model and the prompt version.

export async function runCodeReview(input: RunnerInput<CodeReviewFixture>): Promise<RunnerOutput> {
  const { fixture, prompt, deps, modelRef } = input
  const routing: AgentRouting = {
    default: { ref: modelRef },
    byKind: {
      reviewer: {
        ref: modelRef,
        system: prompt.system,
        temperature: prompt.temperature,
        maxOutputTokens: prompt.maxOutputTokens,
      },
    },
  }
  const executor = new AiAgentExecutor({ modelProvider: deps.provider, agentRouting: routing })
  const result = await executor.run(fixture.context)
  return {
    output: result.output ?? '',
    usage: result.usage,
    meta: { model: result.model },
  }
}
