import type {
  BlockRepository,
  Clock,
  ExecutionInstance,
  PrReportIssue,
  PrVerificationReportPublisher,
  TaskRepository,
} from '@cat-factory/kernel'
import { isVcsProvider } from '@cat-factory/kernel'
import { composePrVerificationReport, renderPrVerificationReport } from './prReport.logic.js'

/**
 * The engine collaborator that keeps a run's **verification report** on its pull request.
 *
 * Shape decision (see `docs/initiatives/pr-verification-report.md`, D2): this is an engine
 * HOOK on step settlement, not a pipeline step — so it is pipeline-shape agnostic (a
 * deployment-authored pipeline gets a report without editing it) and a run that fails or
 * parks part-way still leaves its evidence on the PR. `RunDispatcher.recordStepResult` calls
 * {@link publishForRun} once per settled step, positioned AFTER the terminal step resolver
 * (so the `merger` step's publish carries the resolved `MergeDecision`) and BEFORE
 * `finalizeBlock` (so the `pipeline_complete` card a merger-less pipeline raises points at a
 * PR that already carries the finished report). A passing polling gate settles through the
 * same `recordStepResult`, so the CI verdict needs no hook of its own.
 *
 * Everything it reports is already in memory on the {@link ExecutionInstance}; the only reads
 * are one block point-read and one batched `listByBlock` for the linked tracker issues — no
 * N+1, and no re-probe of the CI/mergeability providers (which would cost a round trip and
 * could disagree with the verdict the gate actually acted on).
 *
 * Every failure mode is a silent no-op: no publisher wired (tests, a no-VCS deployment), no
 * PR yet, an unchanged report, or a transport error. Publishing a report must never fail a
 * run that otherwise succeeded.
 */
export interface PrVerificationReportControllerDeps {
  blockRepository: BlockRepository
  clock: Clock
  /**
   * Optional: writes the rendered section onto the block's PR. Absent (no VCS client wired)
   * ⇒ every publish is a no-op, so the engine behaves exactly as it did before this feature.
   */
  publisher?: PrVerificationReportPublisher
  /** Optional: resolves the task's linked tracker issues in ONE batched read. */
  taskRepository?: TaskRepository
  /**
   * Optional: the deployment's public SPA base URL, used to build the observability deep
   * link. Absent ⇒ the report's `observability.runUrl` is null and no link is rendered
   * (better than emitting a link to nowhere).
   */
  appBaseUrl?: string
  /** Optional structured logger for the best-effort failure path. */
  logger?: { warn?: (obj: unknown, msg: string) => void }
}

export class PrVerificationReportController {
  /**
   * The last section published per execution id, so a 12-step run does not make 12 identical
   * PR edits. In-process only and deliberately so: it is a WRITE-AVOIDANCE cache, never a
   * correctness mechanism — the marker splice is idempotent, so a cold process (or a peer
   * replica) simply re-publishes the same section and the adapter's own unchanged-check
   * suppresses the remote write.
   */
  private readonly lastPublished = new Map<string, string>()

  /**
   * Hard cap on {@link lastPublished}. A long-lived Node replica serves an unbounded number of
   * runs, and each entry holds a rendered section, so the map is bounded here rather than
   * relying on a call site to evict finished runs (a coupling that would silently leak the
   * moment a new terminal path forgot to call it). Oldest-first eviction: `Map` preserves
   * insertion order, and evicting an entry only costs one redundant (idempotent) republish.
   */
  private static readonly MAX_TRACKED_RUNS = 256

  constructor(private readonly deps: PrVerificationReportControllerDeps) {}

  /**
   * Compose the report for `instance` and upsert it onto the run's PR. Best-effort: returns
   * silently on every skip/failure path.
   */
  async publishForRun(workspaceId: string, instance: ExecutionInstance): Promise<void> {
    const publisher = this.deps.publisher
    if (!publisher) return
    try {
      const block = await this.deps.blockRepository.get(workspaceId, instance.blockId)
      // Only a task carries an implementation PR; a frame/module run has nothing to report on.
      if (!block?.pullRequest) return

      const section = renderPrVerificationReport(
        composePrVerificationReport(instance, {
          block,
          issues: await this.linkedIssues(workspaceId, instance.blockId),
          repo: this.repoFullName(instance),
          provider: this.provider(instance),
          runUrl: this.runUrl(workspaceId, instance),
          now: this.deps.clock.now(),
        }),
      )
      // `generatedAt` changes on every compose, so compare the section with it masked out —
      // otherwise the cache would never hit and every step would edit the PR.
      const fingerprint = section.replaceAll(/"generatedAt": \d+/g, '"generatedAt": 0')
      if (this.lastPublished.get(instance.id) === fingerprint) return
      await publisher.publish(workspaceId, block.id, section)
      this.remember(instance.id, fingerprint)
    } catch (error) {
      // A PR-report write is bookkeeping. A provider outage, a revoked token, or a PR someone
      // closed underneath the run must never turn a green run red.
      this.deps.logger?.warn?.(
        { err: error, executionId: instance.id, workspaceId },
        'Failed to publish the PR verification report',
      )
    }
  }

  /** Record the published fingerprint, evicting the oldest entry once the cap is reached. */
  private remember(executionId: string, fingerprint: string): void {
    this.lastPublished.delete(executionId)
    this.lastPublished.set(executionId, fingerprint)
    while (this.lastPublished.size > PrVerificationReportController.MAX_TRACKED_RUNS) {
      const oldest = this.lastPublished.keys().next()
      if (oldest.done) break
      this.lastPublished.delete(oldest.value)
    }
  }

  private async linkedIssues(workspaceId: string, blockId: string): Promise<PrReportIssue[]> {
    const repo = this.deps.taskRepository
    if (!repo) return []
    const records = await repo.listByBlock(workspaceId, blockId)
    return records.map((record) => ({
      source: record.source,
      externalId: record.externalId,
      title: record.title,
      url: record.url,
    }))
  }

  /** `owner/name` of the repo the run's last container step operated on, when recorded. */
  private repoFullName(instance: ExecutionInstance): string | null {
    const repo = instance.diagnostics?.lastDispatch?.repo
    return repo ? `${repo.owner}/${repo.name}` : null
  }

  /** The run's VCS provider, narrowed from the free-text diagnostics value. */
  private provider(instance: ExecutionInstance): 'github' | 'gitlab' | null {
    const provider = instance.diagnostics?.lastDispatch?.repo?.provider
    return isVcsProvider(provider) ? provider : null
  }

  /**
   * The deep link into the run's observability panel (Model activity / Provided context).
   * The SPA is a single canvas, so the target is the board with the run's view params — see
   * `useRunDeepLink` in `@cat-factory/app`, and slice 4 of the global-search initiative,
   * which will generalise the parser.
   */
  private runUrl(workspaceId: string, instance: ExecutionInstance): string | null {
    const base = this.deps.appBaseUrl?.trim()
    if (!base) return null
    // Built by hand rather than with `URLSearchParams`: orchestration is runtime-neutral and
    // compiles without the DOM lib, so the global isn't in its type surface.
    const query = Object.entries({
      ws: workspaceId,
      block: instance.blockId,
      run: instance.id,
      view: 'observability',
    })
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&')
    return `${base.replace(/\/$/, '')}/?${query}`
  }
}
