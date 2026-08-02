import type { UploadApiContract } from '@cat-factory/contracts'
import {
  ValidationError,
  describeFoundationalProblem,
  validateFoundationalDefinition,
} from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// Write-boundary validation for a supplied service definition.
//
// The RULES live in kernel (`validateFoundationalDefinition`), because a deployment's
// code-registered service is validated by exactly the same checks at boot and a second copy is
// a second place to relax one. This module is only the HTTP-shaped half: turn the problems into
// a `ValidationError` carrying the machine-readable `reason` the SPA keys off.
//
// The point of validating at all is to refuse a definition that will read as garbage to a
// downstream agent at the moment someone supplies it, rather than at the moment a coder is
// handed it.
// ---------------------------------------------------------------------------

/**
 * Refuse a supplied service definition whose capability tags near-miss a reserved one, or whose
 * contract set is not what it declares. Returns silently when the definition is acceptable.
 *
 * The FIRST problem decides the thrown `reason`, because the wire envelope carries one; the
 * rest ride `details.problems`, so a registrant fixing a batch sees the whole round rather than
 * peeling them off one request at a time.
 */
export function assertValidDefinition(input: {
  capabilities?: string[]
  contracts?: UploadApiContract[]
}): void {
  const problems = validateFoundationalDefinition(input)
  const first = problems[0]
  if (!first) return
  throw new ValidationError(describeFoundationalProblem(first), {
    ...first,
    problems: problems.map(describeFoundationalProblem),
  })
}
