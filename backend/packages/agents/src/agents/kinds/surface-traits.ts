import type { AgentSurface } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// What a declared `agent.surface` IMPLIES, stated once, as a TOTAL table.
//
// Four questions are asked of a surface all over the platform: does the kind need one of OUR
// containers, does a dispatch of it hand the agent a checkout, is its deliverable the reply it
// returns, and does it leave the platform entirely. Every one of them used to be a `surface ===`
// comparison at its own call site, which is the shape that answers a NEW surface by falling
// through to whatever the `else` happened to be: a delegated kind would have read as an inline
// LLM call at three of the four, and each wrong answer is silent.
//
// So the answers live in one `Record<AgentSurface, SurfaceTraits>`: adding a surface fails the
// build here, on the table, with every question in front of the person adding it.
// ---------------------------------------------------------------------------

/** The four answers a surface owes, and nothing derived from a kind or a dispatch. */
export interface SurfaceTraits {
  /**
   * Whether the kind needs one of OUR containers: a checkout the harness clones, edits and pushes.
   * False for `delegated`, which needs a checkout very much: the executor's own.
   */
  container: boolean
  /**
   * Whether the kind's DELIVERABLE is the visible reply it returns, rather than a commit it
   * pushed. Drives `FINAL_ANSWER_IN_REPLY` and every caller that would otherwise read a step's
   * `output` as a proxy for its work. False for `delegated`: the product is the branch or the pull
   * request, and the executor's summary is recorded beside it.
   */
  deliverableIsReply: boolean
  /**
   * Whether the surface appends the READ-ONLY guardrail. `container-explore` does (a kind that
   * must never edit the checkout it was given); `delegated` does not, because the platform is not
   * the one handing out the working tree and has no standing to describe what may be done to it.
   */
  readOnlyGuardrail: boolean
  /**
   * Whether the work runs OUTSIDE the platform, on a registered `DelegatedExecutor`. The one
   * question with no prior answer, and the reason this table exists.
   */
  delegated: boolean
}

/**
 * The total table. Each row is the surface's OWN answer; nothing here consults a kind, a registry
 * or a dispatch, which is what keeps it a constant a reader can check in one glance.
 */
export const SURFACE_TRAITS: Record<AgentSurface, SurfaceTraits> = {
  inline: {
    container: false,
    deliverableIsReply: true,
    readOnlyGuardrail: false,
    delegated: false,
  },
  'container-explore': {
    container: true,
    deliverableIsReply: true,
    // Withdrawn per-kind by `localWrites` for an explore kind that legitimately writes inside its
    // own tree (a tester installing dependencies); that is a KIND's exception to this row, and it
    // is applied where the kind is in scope rather than smuggled into the table.
    readOnlyGuardrail: true,
    delegated: false,
  },
  'container-coding': {
    container: true,
    deliverableIsReply: false,
    readOnlyGuardrail: false,
    delegated: false,
  },
  delegated: {
    container: false,
    deliverableIsReply: false,
    readOnlyGuardrail: false,
    delegated: true,
  },
}

/**
 * The traits of a surface, or `undefined` for a kind that declared none.
 *
 * Undefined is a real answer, not a gap to default away: a kind with no `agent` spec is pure
 * pre/post-op work, and the callers here treat a `true` as licence to conclude something (that an
 * agent has a checkout, that its reply is its product). A kind that declared no surface has told us
 * nothing to conclude from, so each caller states its own fail-safe rather than sharing one.
 */
export function surfaceTraits(surface: AgentSurface | undefined): SurfaceTraits | undefined {
  return surface ? SURFACE_TRAITS[surface] : undefined
}
