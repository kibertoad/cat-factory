import type { ClarityReview } from '@cat-factory/kernel'

/**
 * Build an already-"incorporated" clarity (bug-report triage) review for a block — the
 * clarity mirror of {@link makeIncorporatedReview}. The conformance suite seeds this into
 * each facade's real clarity store so the engine's substitution of the clarified report
 * into the agent context is asserted on EVERY runtime, without driving the real-LLM
 * review/rework calls themselves.
 */
export function makeIncorporatedClarityReview(blockId: string, report: string): ClarityReview {
  return {
    id: `clr_seed_${blockId}`,
    blockId,
    status: 'incorporated',
    items: [],
    model: 'fake:fake',
    clarifiedReport: report,
    iteration: 1,
    maxIterations: 3,
    createdAt: 1,
    updatedAt: 2,
  }
}
