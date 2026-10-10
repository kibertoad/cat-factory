import type { UploadApiContract } from '@cat-factory/contracts'
import { storedTierMayNotDeclareCredentials } from '@cat-factory/contracts'
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
  credentials?: unknown[]
}): void {
  // The one rule that is about the DECLARER rather than the definition, which is why it lives at
  // this boundary and not in the kernel validator beside it: that validator also grades a
  // deployment's CODE-registered service at boot, where declaring a credential is exactly the
  // supported thing to do. Here the row belongs to an account or a workspace, and the shipped
  // resolver reads a declared key off the DEPLOYMENT'S OWN ENVIRONMENT — so accepting one would
  // let a workspace admin name a variable the platform then reads and hands to an agent process.
  // The record type carries no such field either, so this refusal is what turns a silently
  // dropped declaration into a stated one.
  const credentialProblem = storedTierMayNotDeclareCredentials(input)
  if (credentialProblem) {
    throw new ValidationError(credentialProblem, {
      reason: 'foundational_service_credentials_not_storable',
    })
  }
  const problems = validateFoundationalDefinition(input)
  const first = problems[0]
  if (!first) return
  throw new ValidationError(describeFoundationalProblem(first), {
    ...first,
    problems: problems.map(describeFoundationalProblem),
  })
}
