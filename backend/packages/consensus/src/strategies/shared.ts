import { generateText } from 'ai'
import { catFactoryObservability } from '@cat-factory/kernel'
import type { ConsensusContribution } from '@cat-factory/kernel'
import type {
  ConsensusUsage,
  GenerateArgs,
  GenerateFn,
  GenerateResult,
  ResolvedParticipant,
} from './types.js'

// Shared helpers for the consensus strategies: the default Vercel-AI-SDK `generate`
// implementation, usage accumulation, anonymization (so peers judge ideas, not authors),
// and the participant/synthesizer prompt builders that encode the debate best-practices.

/** The default LLM call: a one-shot `generateText` tagged for the observability sink. */
export const defaultGenerate: GenerateFn = async (args: GenerateArgs): Promise<GenerateResult> => {
  const { text, usage } = await generateText({
    model: args.model,
    system: args.system,
    prompt: args.prompt,
    ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
    ...(args.maxOutputTokens !== undefined ? { maxOutputTokens: args.maxOutputTokens } : {}),
    providerOptions: catFactoryObservability({
      agentKind: args.tags.agentKind,
      workspaceId: args.tags.workspaceId,
      executionId: args.tags.executionId,
    }),
  })
  return {
    text: text.trim(),
    usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 },
  }
}

const ZERO_USAGE: ConsensusUsage = { inputTokens: 0, outputTokens: 0 }

function addUsage(a: ConsensusUsage, b: ConsensusUsage): ConsensusUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  }
}

export function sumUsage(parts: ConsensusUsage[]): ConsensusUsage {
  return parts.reduce(addUsage, ZERO_USAGE)
}

/** Stable anonymous label for a participant index, so peers can't anchor on identity. */
export function anonLabel(index: number): string {
  return `Expert ${String.fromCharCode(65 + (index % 26))}`
}

/** The per-participant system prompt: base role + their distinct perspective framing. */
export function participantSystem(base: string, participant: ResolvedParticipant): string {
  if (!participant.systemFraming) return base
  return `${base}\n\nYour assigned perspective as the "${participant.role}": ${participant.systemFraming}\nArgue your perspective rigorously and honestly; do not merely agree.`
}

/**
 * Render a set of contributions anonymously for a critique/synthesis prompt. `participants`
 * provides the index order so labels are stable across rounds.
 */
export function renderAnonymized(
  contributions: ConsensusContribution[],
  participants: ResolvedParticipant[],
): string {
  return contributions
    .map((c) => {
      const idx = participants.findIndex((p) => p.id === c.participantId)
      return `### ${anonLabel(idx < 0 ? 0 : idx)}\n${c.text}`
    })
    .join('\n\n')
}

/** The neutral synthesizer/judge system prompt. */
export const SYNTHESIZER_SYSTEM = [
  'You are a neutral synthesizer chairing a panel of independent experts who each tackled the SAME task.',
  'Your job is to produce ONE final, polished result that is better than any single contribution.',
  'Combine the strongest, best-justified points; resolve contradictions on the merits (not by vote-counting or splitting the difference); and silently drop weak or unsupported claims.',
  'Do not mention the experts, the panel, or that a synthesis occurred — output only the final result itself, in exactly the format the task requires.',
].join(' ')

/**
 * Build the synthesizer prompt: the original goal plus the anonymized contributions to
 * merge. `formatReminder` re-states the required output format (e.g. JSON for an
 * estimator) so the synthesis stays consumable by the engine.
 */
export function synthesisPrompt(
  goalPrompt: string,
  rendered: string,
  formatReminder: string,
): string {
  return [
    'TASK:',
    goalPrompt,
    '',
    'The independent expert responses to merge:',
    '',
    rendered,
    '',
    formatReminder,
  ].join('\n')
}
