import { generateText } from 'ai'
import { catFactoryObservability, sumAgentTokenUsage } from '@cat-factory/kernel'
import type { ConsensusContribution } from '@cat-factory/kernel'
import { agentUsageFromModelUsage } from '@cat-factory/agents'
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
  return { text: text.trim(), usage: agentUsageFromModelUsage(usage) }
}

/**
 * The strategy's total across its calls. Kernel's fold, so the rule for an aggregate's input
 * CLASS split is stated once for the companion repair retry and the consensus rounds alike:
 * each part keeps its own split, and a part whose provider reported none folds in as fresh.
 *
 * A panel is the aggregate that rule was written for. Its parts are DIFFERENT MODELS behind
 * different providers, and not all of them report cache details (`workers-ai-provider` reports
 * none), so an all-or-nothing split would let one such participant re-price the whole panel's
 * input at the fresh rate: the several-fold over-charge classed pricing exists to remove, on
 * the shape that re-sends one goal prompt to every participant and is therefore mostly cache
 * reads. Nothing here may re-state that rule locally; a strategy folds through kernel.
 *
 * The identity is `undefined` rather than a zeroed usage: a strategy that made no priced call
 * has nothing to say about its classes, and a zero split would assert it cached nothing. Only
 * the final total is coerced to a zero, since a strategy's declared usage is not optional.
 */
export function sumUsage(parts: ConsensusUsage[]): ConsensusUsage {
  return (
    parts.reduce<ConsensusUsage | undefined>(
      (total, part) => sumAgentTokenUsage(total, part),
      undefined,
    ) ?? { inputTokens: 0, outputTokens: 0 }
  )
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
