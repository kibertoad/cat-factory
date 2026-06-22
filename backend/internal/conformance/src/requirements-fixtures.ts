import type { RequirementReview } from '@cat-factory/kernel'

/**
 * Build an already-"incorporated" requirements review for a block — the persisted
 * outcome of a human reacting to the reviewer's findings and running the rework
 * agent. The conformance suite seeds this straight into each facade's real review
 * store (via {@link ConformanceApp.seedIncorporatedReview}) so the engine's
 * substitution of the reworked requirements into the agent context is asserted on
 * EVERY runtime, without driving the (real-LLM) review/rework calls themselves.
 *
 * No open items: a settled, incorporated review carrying only the reworked document.
 */
export function makeIncorporatedReview(blockId: string, requirements: string): RequirementReview {
  return {
    id: `rrv_seed_${blockId}`,
    blockId,
    status: 'incorporated',
    items: [],
    model: 'fake:fake',
    incorporatedRequirements: requirements,
    iteration: 1,
    maxIterations: 3,
    createdAt: 1,
    updatedAt: 2,
  }
}
