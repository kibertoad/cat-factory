import type { PipelineStep } from '@cat-factory/contracts'
import { isDesignSource } from '@cat-factory/contracts'
import {
  PR_PRIOR_REVIEW_CONTEXT_FILE,
  PR_REVIEWER_KIND,
  renderPriorReviewContext,
} from '@cat-factory/agents'
import type { AgentKindRegistry } from '@cat-factory/agents'
import type { InjectedContextFile, ReviewedPoint } from '@cat-factory/kernel'
import { openFindingsFor } from './companion-review-context.js'
import type { LinkedContext, LinkedContextOptions } from './linked-context.js'

// ---------------------------------------------------------------------------
// The BUILDER's own context contributions derived from run STATE, extracted from
// `AgentContextBuilder` as a cohesive collaborator (the file-size ratchet's split trigger): the
// injected context FILES it derives itself — as opposed to the repo-derived files a registered
// kind's preOps contribute — plus the fold that keeps the two from clobbering each other, and the
// prior-output index a step reads its predecessors' work from.
// ---------------------------------------------------------------------------

/**
 * Start the block's linked-context resolution and derive, from that SAME resolution, whether the run
 * carries a design document (which is what folds the design-context guidance into the prompt).
 *
 * A pair rather than two calls because the two must not resolve the corpus twice. Linked context and
 * the fragment fold sit in the SAME `Promise.all` wave in `buildContext`, so the flag travels as a
 * promise the fragment resolver awaits, and it settles at the resolution's CHEAP half, off the
 * `onDocumentsResolved` hook, not off the finished context. That distinction is the whole point: the
 * finished context is only ready after a live version probe per linked source and a possible
 * whole-file re-download, and none of that can change which ORIGINS the run carries. Binding the flag
 * to it would serialise the fragment fold (an LLM call, when a standard needs condensing) behind a
 * Figma round trip on every dispatch, turning `max(linkedContext, fragments)` into their sum.
 *
 * The flag resolves `false` when the corpus never resolves at all, and never rethrows. An unreadable
 * or oversized corpus is already the wave's own failure through the linked-context entry itself, and
 * answering it twice would surface a run refusal as a fragment-resolution error naming the wrong
 * thing.
 */
export function linkedContextWithDesignFlag(
  includeLinked: boolean,
  resolve: (opts: LinkedContextOptions) => Promise<LinkedContext>,
): {
  linkedContext: Promise<LinkedContext>
  hasDesignContext: Promise<boolean>
} {
  let settle: (hasDesign: boolean) => void = () => {}
  const hasDesignContext = new Promise<boolean>((resolvePromise) => {
    settle = resolvePromise
  })
  const linkedContext = resolve({
    includeLinked,
    onDocumentsResolved: (origins) => settle(origins.some(isDesignSource)),
  })
  // A corpus that failed to resolve never reached the hook, so settle the flag on the failure too
  // (a second `settle` after the hook fired is a no-op, which is what makes this safe as a floor
  // rather than an override).
  void linkedContext.then(
    () => settle(false),
    () => settle(false),
  )
  return { linkedContext, hasDesignContext }
}

/**
 * What the steps BEFORE this one produced, as the prior-output list a prompt folds in.
 *
 * Only settled predecessors count (`currentStep` bounds it), and a finalized architecture
 * direction leads the list as a synthetic entry: it is a decision the run already took, so the
 * agents downstream of it must read it as prior work rather than re-open it, and it has no step
 * output of its own to be carried by.
 *
 * An output whose companion ended its loop with points still open carries them
 * ({@link openFindingsFor}). They ride the ENTRY rather than the context root because they are a
 * fact about ONE artifact: attached here they reach exactly the steps that are shown it, named
 * against the producer they belong to, and a pipeline with three steps between producer and
 * consumer cannot separate the caveat from the thing it qualifies. The synthetic entry never has
 * any. No companion graded it, and inventing an empty list would read as a reviewed-and-clean
 * artifact, which is the distinction this whole slice exists to keep.
 */
export function priorOutputsFor(
  instance: { steps: readonly PipelineStep[]; currentStep: number },
  architectureDirection: string | null,
  registry?: AgentKindRegistry,
): { agentKind: string; output: string; openFindings?: ReviewedPoint[] }[] {
  return [
    ...(architectureDirection
      ? [{ agentKind: 'architecture-brainstorm', output: architectureDirection }]
      : []),
    ...instance.steps
      .slice(0, instance.currentStep)
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => step.output)
      .map(({ step, index }) => {
        const openFindings = openFindingsFor(instance, index, registry)
        return {
          agentKind: step.agentKind,
          output: step.output!,
          ...(openFindings ? { openFindings } : {}),
        }
      }),
  ]
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
