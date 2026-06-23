import type { LanguageModel } from 'ai'
import type { ConsensusRound, ConsensusSessionStatus } from '@cat-factory/kernel'

// The runtime-neutral contract a consensus strategy runs against. The executor resolves
// the participants' + synthesizer's models and supplies a `generate` function (a thin
// wrapper over the Vercel AI SDK `generateText`, or a fake in tests), so the strategies
// themselves are pure orchestration and fully unit-testable.

/** Token usage accumulated across a strategy's LLM calls. */
export interface ConsensusUsage {
  inputTokens: number
  outputTokens: number
}

/** A participant with its model resolved to a concrete handle. */
export interface ResolvedParticipant {
  id: string
  role: string
  systemFraming?: string
  model: LanguageModel
  /** `provider:model`, for the transcript + synthesizer label. */
  modelLabel: string
}

/** Observability tags threaded into every sub-call's provider options. */
export interface ObsTags {
  agentKind: string
  workspaceId?: string
  executionId?: string
}

export interface GenerateArgs {
  model: LanguageModel
  system: string
  prompt: string
  temperature?: number
  maxOutputTokens?: number
  tags: ObsTags
}

export interface GenerateResult {
  text: string
  usage: ConsensusUsage
}

/** Inject the LLM call so strategies stay testable; defaults to {@link defaultGenerate}. */
export type GenerateFn = (args: GenerateArgs) => Promise<GenerateResult>

export interface StrategyInput {
  agentKind: string
  /** The base role/system prompt of the underlying agent kind. */
  baseSystem: string
  /** The user prompt describing the goal (the same one the standard agent would get). */
  goalPrompt: string
  participants: ResolvedParticipant[]
  synthesizer: { model: LanguageModel; modelLabel: string }
  /** Debate rounds (incl. the initial draft); clamped/ignored by non-debate strategies. */
  rounds: number
  generate: GenerateFn
  tags: ObsTags
  /**
   * Stream progress so the executor can persist + push the live transcript after each
   * round / on synthesis. Best-effort; failures are swallowed by the executor's wiring.
   */
  onProgress?: (update: { rounds: ConsensusRound[]; status: ConsensusSessionStatus }) => Promise<void>
}

export interface StrategyResult {
  rounds: ConsensusRound[]
  /** The final synthesized artifact — becomes the step's output. */
  synthesis: string
  /** Aggregate confidence (0..1) when the strategy yields one (ranked-voting), else null. */
  confidence: number | null
  /** Notable unresolved disagreements surfaced during the process. */
  dissent: string[]
  usage: ConsensusUsage
}
