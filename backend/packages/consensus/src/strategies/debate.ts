import type { ConsensusContribution, ConsensusRound } from '@cat-factory/kernel'
import type { ConsensusUsage, ResolvedParticipant, StrategyInput, StrategyResult } from './types.js'
import {
  SYNTHESIZER_SYSTEM,
  participantSystem,
  renderAnonymized,
  sumUsage,
  synthesisPrompt,
} from './shared.js'

/**
 * Debate: an initial independent draft round, then `rounds-1` critique rounds in which
 * each participant sees the ANONYMIZED latest peer arguments and revises its own position
 * (defending or conceding on the merits), and finally a neutral judge synthesizes the last
 * round. Independence first, anonymized exposure, explicit disagreement, capped rounds.
 */
export async function runDebate(input: StrategyInput): Promise<StrategyResult> {
  const { participants, baseSystem, goalPrompt, generate, tags } = input
  const totalRounds = Math.max(1, Math.min(5, Math.floor(input.rounds || 2)))
  const rounds: ConsensusRound[] = []
  const usageParts: ConsensusUsage[] = []

  // Round 0 — independent drafts, in parallel.
  let latest = await Promise.all(
    participants.map(async (p) => {
      const { text, usage } = await generate({
        model: p.model,
        system: participantSystem(baseSystem, p),
        prompt: goalPrompt,
        temperature: 0.7,
        tags,
      })
      usageParts.push(usage)
      return { participantId: p.id, text } as ConsensusContribution
    }),
  )
  rounds.push({ index: 0, kind: 'draft', contributions: latest })
  await input.onProgress?.({ rounds: [...rounds], status: 'running' })

  // Critique rounds — each participant revises after reading the anonymized peers.
  for (let r = 1; r < totalRounds; r++) {
    const priorByParticipant = new Map(latest.map((c) => [c.participantId, c]))
    const next = await Promise.all(
      participants.map(async (p) => {
        const peers = latest.filter((c) => c.participantId !== p.id)
        const ownPrior = priorByParticipant.get(p.id)?.text ?? ''
        const prompt = debateCritiquePrompt(goalPrompt, ownPrior, peers, participants)
        const { text, usage } = await generate({
          model: p.model,
          system: participantSystem(baseSystem, p),
          prompt,
          temperature: 0.5,
          tags,
        })
        usageParts.push(usage)
        return { participantId: p.id, text } as ConsensusContribution
      }),
    )
    latest = next
    rounds.push({ index: r, kind: 'critique', contributions: next })
    await input.onProgress?.({ rounds: [...rounds], status: 'running' })
  }

  await input.onProgress?.({ rounds: [...rounds], status: 'synthesizing' })
  const rendered = renderAnonymized(latest, participants)
  const { text: synthesis, usage: synthUsage } = await generate({
    model: input.synthesizer.model,
    system: SYNTHESIZER_SYSTEM,
    prompt: synthesisPrompt(
      goalPrompt,
      rendered,
      'These are the experts’ final positions after debate. Produce the single best final result now, in exactly the format the task requires.',
    ),
    temperature: 0.2,
    tags,
  })
  usageParts.push(synthUsage)

  return { rounds, synthesis, confidence: null, dissent: [], usage: sumUsage(usageParts) }
}

function debateCritiquePrompt(
  goalPrompt: string,
  ownPrior: string,
  peers: ConsensusContribution[],
  participants: ResolvedParticipant[],
): string {
  return [
    'TASK:',
    goalPrompt,
    '',
    'Your previous answer:',
    ownPrior || '(none)',
    '',
    'Other experts answered the same task as follows (anonymized):',
    '',
    renderAnonymized(peers, participants),
    '',
    'Critique their reasoning and reconsider your own. Where a peer is more correct, adopt it; where you are right, defend it with evidence. Then give your improved, complete answer to the task (not just the diff).',
  ].join('\n')
}
