import { randomUUID } from 'node:crypto'
import { requirementsLogic } from '@cat-factory/core'
import { generateText } from 'ai'
import type { RequirementReviewFixture } from '../fixtures'
import type { RunnerInput, RunnerOutput } from './types'

// Requirement-review candidate: the exact stateless reviewer logic from core
// (REVIEW_SYSTEM_PROMPT is the default prompt; buildReviewPrompt + coerceReviewItems
// are reused verbatim), run through a single generateText call.

export async function runRequirementReview(
  input: RunnerInput<RequirementReviewFixture>,
): Promise<RunnerOutput> {
  const { fixture, prompt, deps, modelRef } = input
  const model = deps.provider.resolve(modelRef)
  const { text, usage } = await generateText({
    model,
    system: prompt.system,
    prompt: requirementsLogic.buildReviewPrompt(fixture.context),
    temperature: prompt.temperature ?? 0.2,
    maxOutputTokens: prompt.maxOutputTokens ?? 5000,
    abortSignal: deps.signal,
  })
  const items = requirementsLogic.coerceReviewItems(
    requirementsLogic.extractJson(text),
    () => randomUUID(),
    Date.now(),
  )
  const rendered = items.length
    ? items
        .map((i) => `- [${i.severity}/${i.category}] ${i.title}\n  ${i.detail}`)
        .join('\n')
    : '(no review items raised — requirements judged complete)'
  return {
    output: rendered,
    usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 },
    meta: { itemCount: items.length, raw: text },
  }
}
