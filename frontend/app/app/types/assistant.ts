// ---------------------------------------------------------------------------
// The in-app assistant: one natural-language prompt, one action the platform performs on the
// person's behalf (declare a service dependency, add a service from a repository URL, file a task
// from a tracker issue).
//
// A turn answers with DATA, never with model prose: the outcome variant carries the ids and names
// of what was touched, or the machine-readable reason it could not act, and the SPA renders every
// sentence from those members through the i18n catalog. All wire shapes are sourced from
// @cat-factory/contracts (single source of truth).
// ---------------------------------------------------------------------------

export type {
  AssistantActionId,
  AssistantActionResult,
  AssistantCapability,
  AssistantClarificationReason,
  AssistantDeclineReason,
  AssistantOutcome,
  AssistantServiceRef,
  AssistantTurn,
  AssistantTurnInput,
} from '@cat-factory/contracts'
