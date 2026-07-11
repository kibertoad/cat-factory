import type {
  AgentConfigValues,
  AgentRunContext,
  ForkChatMessage,
  ForkDecisionStepState,
  ForkOption,
  ForkProposal,
  PipelineStep,
  StepGating,
  TaskEstimate,
} from '@cat-factory/kernel'
import { shouldRunGatedStep } from './stepGating.logic.js'

// Pure logic + constants for the optional implementation-fork decision phase on the Coder
// step. The engine resolves the per-task tri-state + the risk-policy gate to decide whether
// to propose (Phase A), records the proposer's structured output onto `step.forkDecision`,
// parks the run for the human, folds the chosen approach into the Coder's prompt (Phase B),
// and pass-through everywhere the feature can't run. Kept side-effect-free so it is unit- and
// conformance-testable without the engine's I/O.

/** The producer kind the fork-decision phase attaches to (the Coder). */
export const FORK_DECISION_PRODUCER_KIND = 'coder'

/** Default hard budget on grounded chat turns (human messages) before a 409. */
export const DEFAULT_FORK_MAX_CHAT_TURNS = 15

/** The per-task tri-state that gates the phase (the `coder.forkDecision` agent-config value). */
export type ForkTriState = 'auto' | 'always' | 'off'

/** Descriptor id of the Coder's fork-decision tri-state (mirrors `CODER_FORK_DECISION_CONFIG_ID`). */
export const CODER_FORK_DECISION_CONFIG_ID = 'coder.forkDecision'

/** The fork-decision statuses that are terminal for the step handler (the phase is resolved). */
const RESOLVED_STATUSES = new Set(['chosen', 'single_path', 'skipped'])

/**
 * The block's tri-state for the fork phase: the explicit `coder.forkDecision` agent-config
 * choice when set to a known value, else the default `auto`. Kept lenient (any unknown value
 * falls back to `auto`) exactly like {@link resolveAgentConfigValue}.
 */
export function resolveForkTriState(agentConfig: AgentConfigValues | undefined): ForkTriState {
  const chosen = agentConfig?.[CODER_FORK_DECISION_CONFIG_ID]
  return chosen === 'always' || chosen === 'off' ? chosen : 'auto'
}

/**
 * Whether the `auto` tri-state should propose, given the risk policy's fork gating and the
 * block's estimate. An absent/disabled gating group means fork surfacing is OFF in `auto`
 * mode (the OPPOSITE polarity of {@link shouldRunGatedStep}, which treats disabled gating as
 * "run unconditionally"); when the group is enabled the axis/`onMissingEstimate` decision is
 * exactly the shared gated-step logic.
 */
export function shouldProposeForkAuto(
  gating: StepGating | null | undefined,
  estimate: TaskEstimate | null | undefined,
): boolean {
  if (!gating?.enabled) return false
  return shouldRunGatedStep(estimate, gating)
}

/**
 * Whether the fork-decision step handler owns this step right now: a `coder` step whose
 * tri-state isn't `off` and whose fork phase isn't already resolved (`chosen` / `single_path`
 * / `skipped`). A parked `awaiting_choice` step is intercepted by the run-lifecycle re-entry
 * guard BEFORE the handler runs, so this stays true for it without harm.
 */
export function forkPhasePending(step: PipelineStep, tri: ForkTriState): boolean {
  if (step.agentKind !== FORK_DECISION_PRODUCER_KIND) return false
  if (tri === 'off') return false
  const status = step.forkDecision?.status
  return status == null || !RESOLVED_STATUSES.has(status)
}

/**
 * The forks from a proposal that are usable as distinct choices: a non-empty title AND a
 * non-empty approach (a blank entry a lenient parse left behind is not a real option). Used to
 * decide the single-path escape hatch (<2 usable ⇒ single path, no park).
 */
export function usableForks(proposal: ForkProposal): ForkProposal['forks'] {
  return proposal.forks.filter((f) => f.title.trim().length > 0 && f.approach.trim().length > 0)
}

/**
 * Mint the live `ForkDecisionStepState.forks` from a proposal, assigning engine-minted ids
 * (`fork_*`) via the supplied id generator. Ensures EXACTLY ONE fork is `recommended` (the
 * proposer's pick, else the first) so the window always has a default highlight.
 */
export function mintForks(usable: ForkProposal['forks'], nextId: () => string): ForkOption[] {
  const recommendedIdx = usable.findIndex((f) => f.recommended === true)
  const winner = recommendedIdx >= 0 ? recommendedIdx : 0
  return usable.map((f, i) => ({
    id: nextId(),
    title: f.title.trim(),
    summary: f.summary.trim(),
    approach: f.approach.trim(),
    tradeoffs: f.tradeoffs.filter((t) => t.trim().length > 0),
    ...(f.riskNotes ? { riskNotes: f.riskNotes } : {}),
    recommended: i === winner,
  }))
}

/** How many HUMAN turns a fork chat holds — the budget (`maxChatTurns`) is measured in these. */
export function humanChatTurns(chat: ForkChatMessage[] | undefined): number {
  return (chat ?? []).reduce((n, m) => (m.role === 'human' ? n + 1 : n), 0)
}

/**
 * Whether a fork chat has spent its human-turn budget: the human has already sent
 * `maxChatTurns` messages (each answered by one assistant turn). A further chat is refused with a
 * 409 — the chat is grounded on a fixed proposal, not a live container, so unbounded turns only
 * add spend and step-row bloat. Pick / custom stay available at the cap.
 */
export function forkChatBudgetSpent(state: ForkDecisionStepState): boolean {
  return humanChatTurns(state.chat) >= (state.maxChatTurns ?? DEFAULT_FORK_MAX_CHAT_TURNS)
}

/**
 * Build the Coder's binding {@link AgentRunContext.implementationChoice} from a resolved
 * fork decision, or `undefined` when nothing was chosen (skipped / single path / proposing).
 * A picked fork resolves to its recorded option; a custom approach becomes a `custom` source.
 * `alternativesConsidered` names the titles of the forks the human did NOT pick.
 */
export function buildImplementationChoice(
  state: ForkDecisionStepState | null | undefined,
): AgentRunContext['implementationChoice'] | undefined {
  const chosen = state?.chosen
  if (!chosen) return undefined
  const forks = state?.forks ?? []
  if (chosen.custom != null && chosen.custom.length > 0) {
    return {
      source: 'custom',
      title: 'Custom approach',
      approach: chosen.custom,
      ...(chosen.note ? { note: chosen.note } : {}),
      alternativesConsidered: forks.map((f) => f.title),
    }
  }
  const picked = forks.find((f) => f.id === chosen.forkId)
  if (!picked) return undefined
  return {
    source: 'proposed',
    title: picked.title,
    approach: picked.approach,
    ...(chosen.note ? { note: chosen.note } : {}),
    alternativesConsidered: forks.filter((f) => f.id !== picked.id).map((f) => f.title),
  }
}
