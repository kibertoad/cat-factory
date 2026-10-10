import type {
  Block,
  BlockRepository,
  ExecutionInstance,
  RepoFiles,
  ResolveRunRepoContext,
  RunRepoContext,
  SpecDoc,
} from '@cat-factory/kernel'
import type { PublicSpecProvenance, ServiceSpecView } from '@cat-factory/contracts'
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

/**
 * WHERE a run's `spec/` read stopped, and what it produced.
 *
 * The reductions above fold every one of these onto "no spec", which is right for them: a coverage
 * section already states its own absence, and a report that refused to compose because a repository
 * was unreachable would be worse than one that says so. It is wrong for a caller that has to REPORT
 * the read rather than survive it, which is what `GET /api/v1/runs/:runId/spec` does: folded, an
 * outage tells an integrator that the run's service declares no requirements, and nothing in the
 * payload contradicts it.
 *
 * So the states are separated HERE, at the one read, and the folding consumers fold on the way out.
 * A second reader that made its own branch choice, ran its own gate or kept its own memo would
 * describe a different run from the outcome summary the caller is joining against, which is the
 * exact drift this loader exists to prevent.
 */
export type RunSpecRead =
  /** The run's block is gone: there is nothing to read a spec FOR. */
  | { status: 'no_block' }
  /**
   * Nothing was read, because no tester has reported yet.
   *
   * Not a failure and not an empty spec. The read is gated on a tester report so the tree served is
   * the one the verdicts were made against (see {@link RunEvidenceLoader}), so before that point
   * the platform has consulted no tree and the run's own outcome summary says `spec: 'not_read'`.
   *
   * It outranks both wiring states below, and the ordering is the whole answer to "where did this
   * read stop": a read that was never DUE stopped at the gate, and it never reached the resolver to
   * discover whether one was wired. Ranked the other way the two wiring faults behaved differently
   * for the same run, because one of them is free to check and the other costs a resolve: an
   * unwired DEPLOYMENT was reported from a run's first settlement while an unconnected WORKSPACE
   * waited for the tester, so one condition answered `503` throughout and the other flipped from
   * `200` to `503` mid-run without anything about the deployment changing.
   */
  | { status: 'not_read' }
  /** This deployment wired no run-repo resolver at all. */
  | { status: 'vcs_unwired' }
  /** Wired, but this workspace has connected no version control (the resolver answered null). */
  | { status: 'no_connection' }
  /** The repository could not be read. Retry: the spec may well be there. */
  | { status: 'read_failed' }
  /** A tree, an empty branch, or a corrupt anchor: the reader's own view, plus where it came from. */
  | { status: 'read'; view: ServiceSpecView; provenance: PublicSpecProvenance }

/** What resolving a branch's head established. See {@link RunEvidenceLoader.headSha}. */
type HeadProbe =
  /** The branch is there, at this commit. */
  | { state: 'resolved'; sha: string }
  /** The branch does not exist: a definite 404 on the ref itself, which cannot mean anything else. */
  | { state: 'absent' }
  /** The provider would not answer for the ref. Says nothing about whether the branch exists. */
  | { state: 'unproven' }

/** The memoised half of a settled read: the view, and the snapshot it describes. */
interface MemoisedSpec {
  view: ServiceSpecView
  provenance: PublicSpecProvenance
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
    const read = await this.readRunSpec(workspaceId, instance, block)
    return { block, specView: read.status === 'read' ? read.view : null }
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
   * design (see {@link runSpecRead}).
   */
  async specViewForRun(workspaceId: string, instance: ExecutionInstance): Promise<ServiceSpecView> {
    const read = await this.runSpecRead(workspaceId, instance)
    return read.status === 'read' ? read.view : EMPTY_SERVICE_SPEC_VIEW
  }

  /**
   * The run's `spec/` read WITH the outcome of the read, for a caller whose job is to report it:
   * `GET /api/v1/runs/:runId/spec`.
   *
   * The same gate, the same branch rule, the same memo and the same reader the two reductions use.
   * The difference is only that nothing is folded on the way out (see {@link RunSpecRead}), which
   * is what lets a headless caller tell a service that declares nothing from a repository nobody
   * can currently read.
   */
  async runSpecRead(workspaceId: string, instance: ExecutionInstance): Promise<RunSpecRead> {
    const block = await this.deps.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return { status: 'no_block' }
    return this.readRunSpec(workspaceId, instance, block)
  }

  /**
   * The service's in-repo `spec/`, reassembled from the run's branch for the requirement →
   * evidence join, and WHERE the read stopped when there is no tree to hand back.
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
  private async readRunSpec(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block,
  ): Promise<RunSpecRead> {
    const testerReported = instance.steps.some(
      (s) => isTesterKind(s.agentKind) && s.test?.lastReport != null,
    )
    if (!testerReported) return { status: 'not_read' }
    const cached = this.specByRun.get(instance.id)
    if (cached) return { status: 'read', ...cached }
    const resolve = this.deps.resolveRunRepoContext
    if (!resolve) return { status: 'vcs_unwired' }
    try {
      const ctx = await resolve(workspaceId, instance.blockId)
      if (!ctx) return { status: 'no_connection' }
      const attempt = await this.walkSpec(ctx, block)
      // The reader is TOTAL, so a provider outage arrives as a returned value rather than a throw:
      // without this line the `catch` below covered only a throwing resolver, and one flaky read
      // was memoised as the run's answer for the rest of its life. The reader's own anchor is the
      // discriminator. Every other state IS an answer and is cached: a tree, a branch with no
      // `spec/`, and a corrupt anchor, which re-reading cannot improve.
      if (attempt.view.diagnostics?.anchor === 'read_failed') return { status: 'read_failed' }
      const provenance: PublicSpecProvenance = {
        provider: ctx.provider ?? 'github',
        // The resolver's owner/name are optional for back-compat with older fakes; the real
        // resolvers always set them, and an empty string is the honest stand-in for a binding
        // that did not.
        owner: ctx.owner ?? '',
        repo: ctx.name ?? '',
        ref: attempt.ref,
        commit: attempt.commit,
      }
      this.rememberSpec(instance.id, { view: attempt.view, provenance })
      return { status: 'read', view: attempt.view, provenance }
    } catch {
      // Best-effort for the two reductions: an unreadable spec is reported as such by each
      // consumer, never fails a run, and is re-attempted on the next settlement. The reporting
      // caller gets the same fact as a refusal rather than as an empty spec.
      return { status: 'read_failed' }
    }
  }

  /**
   * Walk the spec at the branch this run pushed to, falling back to the repo default when that
   * branch is demonstrably GONE.
   *
   * The primary ref is the RUN's branch, not the repo default: the spec increment this task wrote
   * is on the pull request's head and has not merged yet, so the default branch would be missing
   * exactly the requirements the tester just ruled on. The rule is `runSpecBranch` rather than a
   * local `??` because the SPA answers the same question and the two had already drifted.
   *
   * The fallback exists because `block.pullRequest` is never cleared and a merged pull request's
   * head branch is routinely deleted (GitHub deletes it automatically when the repository is
   * configured that way). Left un-handled, the run named a branch nobody can read for the rest of
   * the block's life: no head, every file a 404, and a reporting caller refused with a permanent
   * `spec_ref_unresolved`. That makes the post-hoc audit, which is the case this read exists for,
   * the one case that cannot be served. It is also the case `runSpecBranch` already describes as
   * resolved: once the pull request merges, the two branches carry the same requirements, so the
   * default branch is not a substitute for the run's tree but the same tree under its surviving
   * name.
   *
   * Two conditions gate it TOGETHER, and both are needed:
   *  - the ref probe came back a definite 404 (the branch does not exist), never a throw, which is
   *    an outage and must not be allowed to switch trees mid-incident;
   *  - the walk itself found no anchor. A provider degraded only on refs still answers the tree,
   *    and re-reading elsewhere would discard an answer we hold.
   * Together they are the same discriminator the public read refuses on ("unresolved plus absent
   * is unproven"), applied one layer earlier, where there is still something to be done about it.
   *
   * What it does NOT do is hide which tree was served: `provenance.ref` names the branch actually
   * read. A pull request CLOSED without merging and then deleted is the one case where the
   * fallback answers with a tree the run was not judged against, and naming the ref is what keeps
   * that legible rather than silent.
   */
  private async walkSpec(
    ctx: RunRepoContext,
    block: Block,
  ): Promise<{ ref: string; commit: string | null; view: ServiceSpecView }> {
    const ref = runSpecBranch(block, ctx.baseBranch)
    // Resolved BEFORE the walk, so the commit named is one the tree is at least as new as, and
    // memoised with it: a later reader of this run gets the snapshot the tester ruled against
    // rather than a commit resolved long afterwards. It is also the only POSITIVE evidence the
    // read has that the branch resolves at all, which is what lets a reporting caller tell an
    // empty branch from an unreachable repository (both answer 404 for the anchor).
    const head = await this.headSha(ctx.repo, ref)
    const view = await readServiceSpec(ctx.repo, ref)
    const anchor = view.diagnostics?.anchor
    if (ref === ctx.baseBranch || head.state !== 'absent' || anchor !== 'absent') {
      return { ref, commit: head.state === 'resolved' ? head.sha : null, view }
    }
    const fallbackHead = await this.headSha(ctx.repo, ctx.baseBranch)
    return {
      ref: ctx.baseBranch,
      commit: fallbackHead.state === 'resolved' ? fallbackHead.sha : null,
      view: await readServiceSpec(ctx.repo, ctx.baseBranch),
    }
  }

  /**
   * What resolving a branch's head PROVED, in the three states the callers above act on
   * differently.
   *
   * A bare `string | null` folded the last two together, and the fold is what made a deleted
   * branch indistinguishable from a provider that would not answer: both left `commit: null`,
   * both read as "unproven", and only one of them can be repaired by reading somewhere else.
   * `RepoFiles.headSha` already draws the line (its contract answers null for a branch that does
   * not exist and throws for everything else), so keeping it costs nothing but the naming.
   *
   * `unproven` may never fail the read, which is why the throw is swallowed here rather than left
   * to the caller's outer `catch` (that one means the spec itself could not be read).
   */
  private async headSha(repo: RepoFiles, ref: string): Promise<HeadProbe> {
    try {
      const sha = await repo.headSha(ref)
      return sha ? { state: 'resolved', sha } : { state: 'absent' }
    } catch {
      // silent-catch-ok: an unresolvable ref is a VALUE this read reports (`commit: null`), and
      // the anchor's own bytes decide whether an empty answer is trustworthy.
      return { state: 'unproven' }
    }
  }

  /** Per-execution spec memo, bounded by {@link MAX_TRACKED_RUNS}. */
  private readonly specByRun = new Map<string, MemoisedSpec>()

  private rememberSpec(executionId: string, spec: MemoisedSpec): void {
    this.specByRun.delete(executionId)
    this.specByRun.set(executionId, spec)
    while (this.specByRun.size > MAX_TRACKED_RUNS) {
      const oldest = this.specByRun.keys().next()
      if (oldest.done) break
      this.specByRun.delete(oldest.value)
    }
  }
}
