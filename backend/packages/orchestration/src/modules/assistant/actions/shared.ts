import type { DescriptorFieldValues } from '@cat-factory/contracts'
import type { Block } from '@cat-factory/kernel'
import type { ServiceMatch } from '../assistant.logic.js'
import type { AssistantActionOutcome } from '../types.js'
import { needsInput } from '../types.js'

// Two readings every built-in action repeats: an argument the model may simply not have supplied,
// and a service name that resolved to one frame, none, or several.

/**
 * One argument as a non-empty string, or undefined when the model omitted it.
 *
 * The descriptor validator has already refused a value of the wrong TYPE, so this narrows rather
 * than validates; a blank string is treated as absent because a model that emits `""` for a field
 * it had nothing to say about has, in substance, omitted it.
 */
export function readArgument(args: DescriptorFieldValues, key: string): string | undefined {
  const value = args[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** A resolved frame, or the clarification the turn answers with instead. */
export type ResolvedService =
  | { kind: 'one'; frame: Block }
  | { kind: 'unresolved'; outcome: AssistantActionOutcome }

/** Turn a name match into either the frame or the question to ask about `field`. */
export function resolveNamedService(match: ServiceMatch, field: string): ResolvedService {
  if (match.kind === 'one') return { kind: 'one', frame: match.frame }
  if (match.kind === 'many') {
    return { kind: 'unresolved', outcome: needsInput('ambiguous_service', field, match.candidates) }
  }
  return { kind: 'unresolved', outcome: needsInput('unknown_service', field) }
}

/**
 * The board's service titles, as the shortlist a clarification offers.
 *
 * Capped, because the list is rendered inside a question: a board with eighty services would
 * answer "which one?" with a wall nobody reads, and the cap is what keeps the question askable.
 * The names are the person's own, so there is nothing to sanitize beyond the truncation.
 */
export function serviceTitles(frames: readonly Block[], limit = 8): string[] {
  return frames.slice(0, limit).map((frame) => frame.title)
}
