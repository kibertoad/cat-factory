// Field masking: dropping a value from a result before it reaches the caller.
//
// The one rule worth stating is that masking REPLACES rather than deletes. A removed key and a
// key the deployment had no value for read identically to the agent consuming the result, and
// they are different facts: "your policy hides this" is a question for an operator, while "the
// platform said null" is an answer about the run. So a masked leaf becomes the sentinel below,
// which says which of the two happened, in the shape every other value already has.
//
// Paths are dotted and traverse arrays element-wise (`steps.status` masks the status of every
// step). A path that matches nothing is not an error: a result shape legitimately varies by
// operation, and a policy naming a field some responses do not carry is not a misconfiguration.

/** What a masked leaf becomes. Stated, never removed. */
export const MASKED = '[masked by gatekeeper policy]'

function maskIn(value: unknown, segments: readonly string[]): unknown {
  const [head, ...rest] = segments
  if (head === undefined) return MASKED

  if (Array.isArray(value)) {
    return value.map((element) => maskIn(element, segments))
  }
  if (value === null || typeof value !== 'object') return value

  const source = value as Record<string, unknown>
  if (!(head in source)) return value

  return { ...source, [head]: maskIn(source[head], rest) }
}

/**
 * Apply every masked path to one result, returning a copy. The input is never mutated: the same
 * decoded body may be handed to more than one consumer (a card derivation and the caller's
 * result), and a mask applied in place would silently redact the other one too.
 */
export function applyMask(value: unknown, paths: readonly string[]): unknown {
  let masked = value
  for (const path of paths) {
    const segments = path.split('.').filter((segment) => segment.length > 0)
    if (segments.length === 0) continue
    masked = maskIn(masked, segments)
  }
  return masked
}
