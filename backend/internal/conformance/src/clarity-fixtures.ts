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
    rev: 0,
    createdAt: 1,
    updatedAt: 2,
  }
}

/** The canned triage questions {@link makeReadyClarityReview} draws from, in order. */
const OPEN_ITEMS = [
  { title: 'No reproduction steps', detail: 'What exactly do you do to make the error appear?' },
  { title: 'Unknown environment', detail: 'Which browser and version does this happen on?' },
] as const

/**
 * Build a `ready` clarity review carrying `openItems` still-open findings — a bug-report triage
 * parked on a human, the state whose questions the gate echoes onto the reporter's ticket.
 *
 * Two by default rather than one, for the reason the requirements twin takes a count: answering
 * the LAST open finding legitimately triggers incorporation, which calls a real reworking model no
 * conformance harness has.
 */
export function makeReadyClarityReview(blockId: string, openItems = 2): ClarityReview {
  return {
    id: `clr_seed_${blockId}`,
    blockId,
    status: 'ready',
    items: OPEN_ITEMS.slice(0, Math.max(1, openItems)).map((item, index) => ({
      id: index === 0 ? `clri_seed_${blockId}` : `clri_seed_${blockId}_${index}`,
      category: 'question' as const,
      severity: 'high' as const,
      title: item.title,
      detail: item.detail,
      status: 'open' as const,
      reply: null,
      createdAt: 1,
      updatedAt: 1,
    })),
    model: 'fake:fake',
    clarifiedReport: null,
    iteration: 1,
    maxIterations: 3,
    rev: 0,
    createdAt: 1,
    updatedAt: 2,
  }
}
