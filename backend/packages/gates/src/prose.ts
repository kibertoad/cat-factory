/**
 * Composing the operator-facing prose a gate emits when it gives up.
 *
 * Every give-up path splices a `summary` into a sentence, and that summary is routinely ABSENT:
 * a gate that exhausted its attempts without a helper ever reporting one, a parked run resumed
 * with no `lastFailureSummary` persisted. Writing the hole inline as `${summary ?? ''}` puts a
 * separator on BOTH sides of nothing, and `.trim()` is not the fix for it: it binds to the last
 * template literal of a `+` chain, so it silently does nothing whenever the hole sits mid-sentence
 * and only appears to work when the hole happens to sit at one end. The result reaches a human as
 * a doubled space in the body of the notification asking them to intervene.
 *
 * Composing the fragments instead makes the absence STRUCTURAL: a call site states the pieces it
 * has and the empty ones drop out, wherever they sit.
 */

/**
 * Join sentence fragments with a single space, dropping every fragment an optional value left
 * empty (or whitespace-only). Each surviving fragment is trimmed, so a summary carrying its own
 * trailing newline from a provider does not re-introduce the gap this exists to close.
 */
export function joinSentences(...parts: readonly (string | null | undefined)[]): string {
  const present: string[] = []
  for (const part of parts) {
    const trimmed = part?.trim() ?? ''
    if (trimmed.length > 0) present.push(trimmed)
  }
  return present.join(' ')
}
