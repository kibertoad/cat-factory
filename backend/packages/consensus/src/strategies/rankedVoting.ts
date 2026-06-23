import type { ConsensusContribution, ConsensusRound, ConsensusScore } from '@cat-factory/kernel'
import type { ConsensusUsage, ResolvedParticipant, StrategyInput, StrategyResult } from './types.js'
import { anonLabel, participantSystem, renderAnonymized, sumUsage } from './shared.js'

/**
 * Ranked voting / scoring: each participant produces an independent candidate answer,
 * then every participant scores ALL candidates (0..1) against the task; scores are
 * aggregated deterministically (mean) and the highest-rated candidate wins. The winning
 * candidate becomes the result, the mean is the confidence, and a near-tie is reported as
 * dissent. Independence first; peer scoring is anonymized; aggregation is deterministic.
 */
export async function runRankedVoting(input: StrategyInput): Promise<StrategyResult> {
  const { participants, baseSystem, goalPrompt, generate, tags } = input
  const usageParts: ConsensusUsage[] = []

  // Round 0 — independent candidates, in parallel.
  const candidates = await Promise.all(
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
  const draftRound: ConsensusRound = { index: 0, kind: 'draft', contributions: candidates }
  await input.onProgress?.({ rounds: [draftRound], status: 'running' })

  const labels = participants.map((_, i) => anonLabel(i))
  const rendered = renderAnonymized(candidates, participants)

  // Round 1 — each participant scores every candidate 0..1.
  const scoreContributions = await Promise.all(
    participants.map(async (p) => {
      const { text, usage } = await generate({
        model: p.model,
        system: participantSystem(baseSystem, p),
        prompt: scorePrompt(goalPrompt, rendered, labels),
        temperature: 0.1,
        tags,
      })
      usageParts.push(usage)
      const map = parseScoreMap(text, labels)
      const scores: ConsensusScore[] = labels.map((label) => ({
        dimension: label,
        value: map[label] ?? 0,
      }))
      return { participantId: p.id, text, scores } as ConsensusContribution
    }),
  )
  const scoreRound: ConsensusRound = { index: 1, kind: 'score', contributions: scoreContributions }
  await input.onProgress?.({ rounds: [draftRound, scoreRound], status: 'synthesizing' })

  // Deterministic aggregation: mean score per candidate across all scorers.
  const means = labels.map((label) => {
    const vals = scoreContributions
      .map((c) => c.scores?.find((s) => s.dimension === label)?.value)
      .filter((v): v is number => typeof v === 'number')
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
  })
  let winner = 0
  for (let i = 1; i < means.length; i++) if (means[i]! > means[winner]!) winner = i

  const sorted = [...means].sort((a, b) => b - a)
  const dissent: string[] =
    sorted.length >= 2 && sorted[0]! - sorted[1]! < 0.1
      ? [`Close vote: top candidates scored ${sorted[0]!.toFixed(2)} vs ${sorted[1]!.toFixed(2)}.`]
      : []

  return {
    rounds: [draftRound, scoreRound],
    synthesis: candidates[winner]?.text ?? '',
    confidence: means[winner] ?? null,
    dissent,
    usage: sumUsage(usageParts),
  }
}

function scorePrompt(goalPrompt: string, rendered: string, labels: string[]): string {
  return [
    'TASK:',
    goalPrompt,
    '',
    'Candidate answers from independent experts (anonymized):',
    '',
    rendered,
    '',
    `Score how well EACH candidate solves the task, from 0 (poor) to 1 (excellent). Be discriminating. Respond with ONLY a JSON object mapping each label to its score, e.g. {${labels
      .map((l) => `"${l}":0.0`)
      .join(',')}} — no prose, no code fences.`,
  ].join('\n')
}

/** Tolerant parse of a `{ "Expert A": 0.8, ... }` score map; clamps to [0,1]. */
export function parseScoreMap(text: string, labels: string[]): Record<string, number> {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  const out: Record<string, number> = {}
  if (start === -1 || end <= start) return out
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    return out
  }
  if (!raw || typeof raw !== 'object') return out
  const obj = raw as Record<string, unknown>
  for (const label of labels) {
    const v = obj[label]
    if (typeof v === 'number' && Number.isFinite(v)) out[label] = Math.max(0, Math.min(1, v))
  }
  return out
}
