import type { ConsensusContribution, ConsensusRound } from '@cat-factory/kernel'
import type { StrategyInput, StrategyResult } from './types.js'
import {
  SYNTHESIZER_SYSTEM,
  participantSystem,
  renderAnonymized,
  sumUsage,
  synthesisPrompt,
} from './shared.js'

/**
 * Specialist panel: every participant answers the goal INDEPENDENTLY and in parallel
 * (blind to each other — no anchoring/groupthink), then a neutral synthesizer merges the
 * drafts into one polished result. The single highest-leverage consensus shape: diversity
 * of role + model, independence before exposure, neutral synthesis.
 */
export async function runSpecialistPanel(input: StrategyInput): Promise<StrategyResult> {
  const { participants, baseSystem, goalPrompt, generate, tags } = input

  const drafts = await Promise.all(
    participants.map(async (p) => {
      const { text, usage } = await generate({
        model: p.model,
        system: participantSystem(baseSystem, p),
        prompt: goalPrompt,
        temperature: 0.7,
        tags,
      })
      return { contribution: { participantId: p.id, text } as ConsensusContribution, usage }
    }),
  )

  const draftRound: ConsensusRound = {
    index: 0,
    kind: 'draft',
    contributions: drafts.map((d) => d.contribution),
  }
  await input.onProgress?.({ rounds: [draftRound], status: 'synthesizing' })

  const rendered = renderAnonymized(draftRound.contributions, participants)
  const { text: synthesis, usage: synthUsage } = await generate({
    model: input.synthesizer.model,
    system: SYNTHESIZER_SYSTEM,
    prompt: synthesisPrompt(
      goalPrompt,
      rendered,
      'Produce the single best final result now, in exactly the format the task requires.',
    ),
    temperature: 0.2,
    tags,
  })

  return {
    rounds: [draftRound],
    synthesis,
    confidence: null,
    dissent: [],
    usage: sumUsage([...drafts.map((d) => d.usage), synthUsage]),
  }
}
