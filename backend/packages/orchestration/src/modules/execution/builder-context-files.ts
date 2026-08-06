import type { PipelineStep } from '@cat-factory/contracts'
import { isDesignSource } from '@cat-factory/contracts'
import {
  PR_PRIOR_REVIEW_CONTEXT_FILE,
  PR_REVIEWER_KIND,
  renderPriorReviewContext,
} from '@cat-factory/agents'
import type { InjectedContextFile } from '@cat-factory/kernel'
import type { LinkedContext } from './linked-context.js'

// ---------------------------------------------------------------------------
// The BUILDER's own injected-context-file contributors, extracted from `AgentContextBuilder`
// as a cohesive collaborator (the file-size ratchet's split trigger). These are the context
// files the builder derives from run STATE — as opposed to the repo-derived files a registered
// kind's preOps contribute — plus the fold that keeps the two from clobbering each other.
// ---------------------------------------------------------------------------

/**
 * Start the block's linked-context resolution and derive, from that SAME promise, whether the run
 * carries a design document (which is what folds the design-context guidance into the prompt).
 *
 * A pair rather than two calls because the two must not resolve the corpus twice. Linked context and
 * the fragment fold sit in the SAME `Promise.all` wave in `buildContext`, so the flag travels as a
 * promise the fragment resolver awaits: that serialises those two alone, where lifting the corpus
 * resolution out of the wave would cost every dispatch an extra round trip.
 *
 * The flag resolves `false` on rejection and never rethrows. An unreadable or oversized corpus is
 * already the wave's own failure through the linked-context entry itself, and answering it twice
 * would surface a run refusal as a fragment-resolution error naming the wrong thing.
 */
export function linkedContextWithDesignFlag(resolve: () => Promise<LinkedContext>): {
  linkedContext: Promise<LinkedContext>
  hasDesignContext: Promise<boolean>
} {
  const linkedContext = resolve()
  return {
    linkedContext,
    hasDesignContext: linkedContext.then(
      (ctx) => ctx.docs.some((doc) => isDesignSource(doc.origin)),
      () => false,
    ),
  }
}

/**
 * Concatenate the builder's context-file contributors into the single optional field, dropping
 * it entirely when every contributor produced nothing — an empty array would otherwise read
 * downstream as "files were prepared", and the executor would materialise an empty directory.
 */
export function mergeInjectedContextFiles(
  ...contributions: (InjectedContextFile[] | undefined)[]
): {
  injectedContextFiles?: InjectedContextFile[]
} {
  const files = contributions.flatMap((contribution) => contribution ?? [])
  return files.length > 0 ? { injectedContextFiles: files } : {}
}

/**
 * The `.cat-context/pr-prior-review.md` slice of a RESUMED PR review's context — the previous
 * attempt's captured slice reports plus the slices that still need reviewing. Empty object for
 * every other dispatch, so the fold at the {@link AgentContextBuilder.buildContext} call site
 * stays branch-free.
 *
 * Emitted by the BUILDER rather than by a preOp beside the reviewer's other three, for two
 * reasons. The state is on the STEP (`step.prReview`), which a {@link RepoOpContext} deliberately
 * does not carry — it hands ops the block-scoped run context and a `RepoFiles`. And a preOp only
 * runs once a run repo RESOLVES, which is right for the diff/comments/standards ops (all of them
 * read the repo) and wrong here: this file needs no repo access at all, and silently skipping it on
 * a deployment whose repo context is unwired would turn a resume back into a from-zero re-review
 * with nothing to say so.
 *
 * Gated on the dispatched kind being the reviewer itself: a `fix` / `post` / `challenge`
 * re-dispatch reuses this same step under an overriding kind, and none of them aggregates
 * anything, so handing them the prior reports would be noise charged on every turn.
 *
 * `resumePendingSlices` being ABSENT is the signal that this is not a resume (the controller
 * leaves it unset when a resume observed no prior work at all, which makes it a plain restart);
 * an EMPTY array is a real resume whose every planned slice already reported.
 */
export function priorPrReviewContextFor(
  agentKind: string,
  step: PipelineStep,
): { injectedContextFiles?: InjectedContextFile[] } {
  if (agentKind !== PR_REVIEWER_KIND) return {}
  const pending = step.prReview?.resumePendingSlices
  if (!pending) return {}
  return {
    injectedContextFiles: [
      {
        path: PR_PRIOR_REVIEW_CONTEXT_FILE,
        content: renderPriorReviewContext(step.prReview?.sliceReviews ?? [], pending),
      },
    ],
  }
}
