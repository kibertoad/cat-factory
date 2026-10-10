import type {
  AssistantActionId,
  AssistantActionResult,
  AssistantClarificationReason,
  BlockEditAuthority,
  DescriptorField,
  DescriptorFieldValues,
} from '@cat-factory/contracts'

// ---------------------------------------------------------------------------
// The vocabulary an assistant ACTION is written against.
//
// An action is the platform half of a turn: the model names one and copies its arguments out of
// the sentence, and this is everything that happens afterwards. Two properties of the type carry
// the design:
//
//  - `parameters` are ordinary DESCRIPTOR FIELDS, the same vocabulary a task type's form and an
//    inline use case's brief are declared in. So an action's arguments are validated, defaulted
//    and sanitized by the shared validator rather than by per-action code, and the model's catalog
//    entry is DERIVED from the same declaration the validator reads, so the two cannot drift into
//    describing different arguments.
//  - `run` returns an OUTCOME rather than throwing for an unresolvable argument. "No service by
//    that name" is a fact about the sentence, and the turn's answer to it is a question with
//    candidates attached; the exceptions stay for what they have always meant here, a refusal by
//    the service underneath (an unconfigured integration, an issue already filed, a board rule),
//    which reaches the SPA through the one error funnel with its `details.reason` intact.
// ---------------------------------------------------------------------------

/** What one action is handed to run: the request's scope, its arguments, and whose authority. */
export interface AssistantActionContext {
  workspaceId: string
  /** Validated + sanitized arguments: declared keys only, defaults applied, values trimmed. */
  arguments: DescriptorFieldValues
  /** Whose tier every board write this action makes is judged under (ADR 0037). */
  editor: BlockEditAuthority
  /** The acting user, recorded as the author of what the action creates. */
  userId: string | null
}

/**
 * What an action did, or the ONE argument it could not resolve.
 *
 * `needs_input` names a single field rather than a list, because a turn asks one question: a
 * person handed three at once re-types the whole sentence anyway, and the second question is
 * usually answered by whatever the first one settles.
 */
export type AssistantActionOutcome =
  | { status: 'performed'; result: AssistantActionResult }
  | {
      status: 'needs_input'
      reason: AssistantClarificationReason
      /** The argument key that could not be resolved. */
      field: string
      /** What the platform was choosing between; empty when nothing matched at all. */
      candidates: string[]
    }

/** One action the assistant can perform. */
export interface AssistantActionDefinition {
  actionId: AssistantActionId
  /** One line on what performing it does, in English, for the model's catalog. */
  purpose: string
  /** Prompts that should route here, so the catalog shows the shape of a request. */
  examples: readonly string[]
  /** The arguments it accepts, in the shared descriptor vocabulary. */
  parameters: readonly DescriptorField[]
  run(context: AssistantActionContext): Promise<AssistantActionOutcome>
}

/** The clarification outcome, as an action states it. */
export function needsInput(
  reason: AssistantClarificationReason,
  field: string,
  candidates: readonly string[] = [],
): AssistantActionOutcome {
  return { status: 'needs_input', reason, field, candidates: [...candidates] }
}

/** The performed outcome, as an action states it. */
export function performed(result: AssistantActionResult): AssistantActionOutcome {
  return { status: 'performed', result }
}
