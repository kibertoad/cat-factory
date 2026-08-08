import type {
  Block,
  BlockRepository,
  ExecutionInstance,
  ResolveRunRepoContext,
  SpecDoc,
} from '@cat-factory/kernel'
import type { ServiceSpecView } from '@cat-factory/contracts'
import { EMPTY_SERVICE_SPEC_VIEW, isTesterKind, runSpecBranch } from '@cat-factory/contracts'
import { readServiceSpec } from '@cat-factory/agents'

// ---------------------------------------------------------------------------
// The two reads every reduction of a run's evidence starts from: the run's BLOCK (what was
// asked, and which pull requests it opened) and the enclosing service's in-repo `spec/` (the
// denominator requirement coverage is counted against).
//
// Its own collaborator because there are now two reductions and they must not read differently.
// The PR verification report composes a reviewer's document; `composeRunOutcome` composes the
// non-code summary served at `GET /api/v1/runs/:runId/outcome` and rendered in the SPA. Both
// answer "which requirements did this run verify", so a second loader with its own branch choice
// or its own memo would reintroduce, one layer down, exactly the drift the shared composition
// rules were pulled into `@cat-factory/contracts` to remove.
// ---------------------------------------------------------------------------

/** What a run's evidence reductions read before they compose anything. */
export interface RunEvidence {
  block: Block
  /**
   * The service's in-repo `spec/` as it stands on the RUN's branch, or null when it could not be
   * read at all (no VCS wired, no repo resolved, a transport failure, or a tester that has not
   * reported yet). Every consumer reports that absence explicitly rather than as a clean, empty
   * coverage section.
   *
   * The read VIEW rather than the doc, because the SPA's outcome card is served this same answer
   * over {@link RunEvidenceLoader.specViewForRun} and a `present: false` spec (a repo that
   * carries no `spec/`) is a different fact from an unread one.
   */
  specView: ServiceSpecView | null
}

/** The doc a reduction counts against, or null when there is none. */
export function specDocOf(view: ServiceSpecView | null): SpecDoc | null {
  return view?.present ? view.spec : null
}

export interface RunEvidenceLoaderDeps {
  blockRepository: BlockRepository
  /**
   * Optional: per-run, checkout-free repo access, used to reassemble the service's `spec/`.
   * Absent (tests, a no-VCS deployment) ⇒ `spec` is null and each consumer says so.
   */
  resolveRunRepoContext?: ResolveRunRepoContext
}

/**
 * How many runs' spec answers are memoised. A long-lived Node replica serves an unbounded number
 * of runs and each entry holds a reassembled tree, so the map is bounded here rather than relying
 * on a call site to evict finished runs (a coupling that would silently leak the moment a new
 * terminal path forgot to call it). Oldest-first eviction: `Map` preserves insertion order, and
 * evicting an entry only costs one repeated read.
 */
const MAX_TRACKED_RUNS = 256

export class RunEvidenceLoader {
  constructor(private readonly deps: RunEvidenceLoaderDeps) {}

  /**
   * Read a run's block and its service spec. Null when the block is gone, which is the only way
   * a run has nothing to report on at all.
   */
  async load(workspaceId: string, instance: ExecutionInstance): Promise<RunEvidence | null> {
    const block = await this.deps.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return null
    return { block, specView: await this.serviceSpec(workspaceId, instance, block) }
  }

  /**
   * The run's `spec/` as a read VIEW, for the SPA's outcome card.
   *
   * The card composes `composeRunOutcome` live off its own store, so the ONE input it cannot
   * derive from pushed state is this spec, and it used to fetch the SERVICE's spec from the
   * repo's DEFAULT branch. That is a different document: the requirement ids this run's verdicts
   * name are on the run's own branch until the pull request merges, so every one of them landed
   * as "not checked" and the card's counts contradicted `GET /api/v1/runs/:runId/outcome` for the
   * same run. Served from here, the two read one branch through one rule.
   *
   * `EMPTY_SERVICE_SPEC_VIEW` rather than null on an unread spec: the card's own composer already
   * treats an absent spec as `spec: 'not_read'` and says so, and the read is best-effort by
   * design (see {@link serviceSpec}).
   */
  async specViewForRun(workspaceId: string, instance: ExecutionInstance): Promise<ServiceSpecView> {
    const block = await this.deps.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return EMPTY_SERVICE_SPEC_VIEW
    return (await this.serviceSpec(workspaceId, instance, block)) ?? EMPTY_SERVICE_SPEC_VIEW
  }

  /**
   * The service's in-repo `spec/`, reassembled from the run's branch for the requirement →
   * evidence join. Null whenever it could not be read, which every consumer reports with a
   * stated absence rather than a blank.
   *
   * GATED, then MEMOISED, because this is the only repo-reading path either reduction has and
   * the PR-report hook fires on EVERY settled step:
   *  - Gate: nothing is read until a tester step has actually produced a report. Before that the
   *    coverage answer is already determined ("no tester step" / "no report yet"), so a read
   *    would buy nothing; this keeps the ~15 settlements before the tester at zero repo calls.
   *  - Memo: reassembling the sharded tree costs one read per module + per group, so the handful
   *    of settlements AFTER the tester would otherwise repeat it each time.
   *
   * The memo deliberately holds the spec as it stood when the tester ruled. That is the tree the
   * verdicts were made against, so pairing a later re-read with those same verdicts would be less
   * truthful, not more, and the promotion post-op rewrites the spec on this very branch right
   * after the tester settles.
   *
   * Only an ANSWER is memoised: a tree that was read, a repo that demonstrably carries no `spec/`,
   * or an anchor that is there and corrupt. A FAILURE (an unresolvable repo, a throwing transport,
   * a provider that would not answer for the anchor) is not: caching it would turn one flaky read
   * into "the spec could not be read" for the rest of the run, when the very next settlement would
   * have succeeded. The reader never throws for the last of those, so the distinction is made on
   * its `diagnostics.anchor` rather than on control flow.
   */
  private async serviceSpec(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block,
  ): Promise<ServiceSpecView | null> {
    const resolve = this.deps.resolveRunRepoContext
    if (!resolve) return null
    const testerReported = instance.steps.some(
      (s) => isTesterKind(s.agentKind) && s.test?.lastReport != null,
    )
    if (!testerReported) return null
    const cached = this.specByRun.get(instance.id)
    if (cached !== undefined) return cached
    try {
      const ctx = await resolve(workspaceId, instance.blockId)
      if (!ctx) return null
      // Read the RUN's branch, not the repo default: the spec increment this task wrote is on
      // the PR branch and has not merged yet, so the default branch would be missing exactly
      // the requirements the tester just ruled on. The rule is `runSpecBranch` rather than a
      // local `??` because the SPA answers the same question and the two had already drifted.
      const view = await readServiceSpec(ctx.repo, runSpecBranch(block, ctx.baseBranch))
      // The reader is TOTAL, so a provider outage arrives as a returned value rather than a throw:
      // without this line the `catch` below covered only a throwing resolver, and one flaky read
      // was memoised as the run's answer for the rest of its life. The reader's own anchor is the
      // discriminator. Every other state IS an answer and is cached: a tree, a branch with no
      // `spec/`, and a corrupt anchor, which re-reading cannot improve.
      if (view.diagnostics?.anchor === 'read_failed') return null
      this.rememberSpec(instance.id, view)
      return view
    } catch {
      // Best-effort: an unreadable spec is reported as such by each consumer, never fails a run,
      // and is re-attempted on the next settlement.
      return null
    }
  }

  /** Per-execution spec memo, bounded by {@link MAX_TRACKED_RUNS}. */
  private readonly specByRun = new Map<string, ServiceSpecView>()

  private rememberSpec(executionId: string, spec: ServiceSpecView): void {
    this.specByRun.delete(executionId)
    this.specByRun.set(executionId, spec)
    while (this.specByRun.size > MAX_TRACKED_RUNS) {
      const oldest = this.specByRun.keys().next()
      if (oldest.done) break
      this.specByRun.delete(oldest.value)
    }
  }
}
