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

/**
 * Build a `ready` review carrying one still-open finding. The conformance suite seeds this
 * to assert the async-incorporate route's pre-LLM guard on EVERY runtime: incorporation is
 * refused (no findings folded, no run signalled) while any finding is unanswered — a
 * deterministic check that needs no live reviewer model, mirroring the re-review guard test.
 */
export function makeReadyReviewWithOpenItem(blockId: string): RequirementReview {
  return {
    id: `rrv_seed_${blockId}`,
    blockId,
    status: 'ready',
    items: [
      {
        id: `rri_seed_${blockId}`,
        category: 'gap',
        severity: 'high',
        title: 'Unspecified session lifetime',
        detail: 'How long should an authenticated session stay valid?',
        status: 'open',
        reply: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    model: 'fake:fake',
    incorporatedRequirements: null,
    iteration: 1,
    maxIterations: 3,
    createdAt: 1,
    updatedAt: 2,
  }
}
