import type {
  BlockRepository,
  Clock,
  ExecutionInstance,
  Logger,
  PrReportIssue,
  PrVerificationReportPublisher,
  ProvisioningLogRepository,
  ResolveRunRepoContext,
  SpecDoc,
  TaskRepository,
  WorkspaceSettingsRepository,
} from '@cat-factory/kernel'
import { DEFAULT_WORKSPACE_SETTINGS } from '@cat-factory/kernel'
import { readServiceSpec } from '@cat-factory/agents'
import { DEPLOYER_AGENT_KIND } from '@cat-factory/integrations'
import { composePrVerificationReport, renderPrVerificationReport } from './prReport.logic.js'
import type { ProvisioningLifecycleEvent } from './prReport.environments.js'
import { isTesterKind } from './ci.logic.js'

/**
 * How many of the run's environment provisioning rows the lifecycle timeline reads. A run
 * stands up one environment per involved service frame and retries a failing provision, so the
 * realistic count is single digits; the bound exists so a pathological retry loop cannot make
 * the report's own read unbounded. The timeline folds first/last/counts, so a capped read can
 * only ever UNDERSTATE the failure counts, which is why the cap is set far above any real run
 * rather than being surfaced as a truncation the reader would have to reason about.
 */
const PROVISIONING_EVENT_LIMIT = 200

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
   * Optional: per-run, checkout-free repo access, used to reassemble the service's `spec/`
   * for the requirement → evidence join. Absent (tests, a no-VCS deployment) ⇒ that section
   * reports `absent` with a note saying the spec could not be read — never a silent blank.
   */
  resolveRunRepoContext?: ResolveRunRepoContext
  /**
   * Optional: the per-workspace `publishPrVerificationReport` opt-out. Absent (or no saved
   * settings row) ⇒ the default, which is ON — a deployment that wired a publisher wants the
   * report.
   */
  workspaceSettingsRepository?: WorkspaceSettingsRepository
  /**
   * Optional: the provisioning event log, which DATES the environment lifecycle: the only
   * store that records when a throwaway environment came up and when it was reclaimed. Absent
   * (a deployment that retains no log) ⇒ the section says the lifecycle could not be dated
   * rather than reporting "never torn down", which is the same value and the opposite fact.
   */
  provisioningLogRepository?: Pick<ProvisioningLogRepository, 'list'>
  /**
   * Optional: the deployment's public SPA base URL, used to build the observability and
   * captured-evidence deep links. Absent ⇒ those fields are null and no link is rendered
   * (better than emitting a link to nowhere).
   */
  appBaseUrl?: string
  /**
   * Optional structured logger for the best-effort failure path. Wire it: publishing is the
   * one part of the run that is DESIGNED to fail silently, so without a log a revoked token or
   * a rejected body leaves no trace anywhere — the report simply stops appearing.
   */
  logger?: Logger
}

export class PrVerificationReportController {
  /**
   * The last section published per execution id, so settlements that change nothing a reader
   * would see cost no PR edit at all.
   *
   * It does NOT collapse a run to one edit: the report carries a per-step state table, so most
   * settlements genuinely do change it and the report tracks the run as it progresses — which
   * is the intent ("rewritten in place as the run progresses"). What the cache removes is the
   * repeat write from a replayed durable step, a re-poll, or a settlement whose evidence is
   * identical to the last one.
   *
   * In-process only and deliberately so: it is a WRITE-AVOIDANCE cache, never a correctness
   * mechanism — the marker splice is idempotent, so a cold process (or a peer replica) simply
   * re-publishes the same section and the adapter's own unchanged-check suppresses the remote
   * write.
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
      if (!(await this.publishingEnabled(workspaceId))) return
      // Ask the adapter WHERE this would go before composing anything: it both short-circuits a
      // run that has no PR yet (most runs, for most of their life) and supplies the repo +
      // provider the report states — the same resolution the write itself uses, so the report
      // can never name a different repo from the one it lands on.
      const target = await publisher.resolveTarget(workspaceId, instance.blockId)
      if (!target) return

      const block = await this.deps.blockRepository.get(workspaceId, instance.blockId)
      // Only a task carries an implementation PR; a frame/module run has nothing to report on.
      if (!block) return

      const section = renderPrVerificationReport(
        composePrVerificationReport(instance, {
          block,
          issues: await this.linkedIssues(workspaceId, instance.blockId),
          repo: target.repo,
          provider: target.provider,
          runUrl: this.deepLink(workspaceId, instance, 'observability'),
          spec: await this.serviceSpec(workspaceId, instance, block.pullRequest?.branch),
          environments: {
            provisioningEvents: await this.provisioningEvents(workspaceId, instance),
            evidenceUrl: this.deepLink(workspaceId, instance, 'test-evidence'),
          },
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
      this.deps.logger?.warn('Failed to publish the PR verification report', {
        err: error,
        executionId: instance.id,
        blockId: instance.blockId,
        workspaceId,
      })
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

  /**
   * The workspace's opt-out. Checked BEFORE anything is read or composed, so a workspace that
   * turned the report off pays nothing for the hook. A workspace with no saved settings row
   * reads as the default (on).
   */
  private async publishingEnabled(workspaceId: string): Promise<boolean> {
    const repo = this.deps.workspaceSettingsRepository
    if (!repo) return true
    const settings = (await repo.get(workspaceId)) ?? DEFAULT_WORKSPACE_SETTINGS
    return settings.publishPrVerificationReport
  }

  /**
   * The service's in-repo `spec/`, reassembled from the run's branch for the requirement →
   * evidence join. Null whenever it could not be read — which the section reports with a note
   * rather than a blank.
   *
   * GATED, then MEMOISED, because this is the report's only repo-reading path and the hook
   * fires on EVERY settled step:
   *  - Gate: nothing is read until a tester step has actually produced a report. Before that
   *    the section's answer is already determined ("no tester step" / "no report yet"), so a
   *    read would buy nothing; this keeps the ~15 settlements before the tester at zero repo
   *    calls, exactly as they were before this feature.
   *  - Memo: reassembling the sharded tree costs one read per module + per group, so the
   *    handful of settlements AFTER the tester would otherwise repeat it each time. Cached
   *    per execution id under the same bound as {@link lastPublished}.
   *
   * The memo deliberately holds the spec as it stood when the tester ruled. That is the tree
   * the verdicts were made against, so pairing a later re-read with those same verdicts would
   * be less truthful, not more — and the promotion post-op rewrites the spec on this very
   * branch right after the tester settles.
   *
   * Only an ANSWER is memoised — a tree that was read, or a repo that demonstrably carries no
   * `spec/`. A FAILURE (an unresolvable repo, a throwing transport) is not: caching it would
   * turn one flaky read into "the spec could not be read" on every remaining publish of the
   * run, when the very next settlement would have succeeded.
   */
  private async serviceSpec(
    workspaceId: string,
    instance: ExecutionInstance,
    prBranch: string | null | undefined,
  ): Promise<SpecDoc | null> {
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
      // the requirements the tester just ruled on.
      const view = await readServiceSpec(ctx.repo, prBranch ?? ctx.baseBranch)
      const spec = view.present ? view.spec : null
      this.rememberSpec(instance.id, spec)
      return spec
    } catch {
      // Best-effort, like every other part of this hook: an unreadable spec reports `absent`
      // with a note, never fails the run, and is re-attempted on the next settlement.
      return null
    }
  }

  /** Per-execution spec memo, bounded exactly like {@link lastPublished}. */
  private readonly specByRun = new Map<string, SpecDoc | null>()

  private rememberSpec(executionId: string, spec: SpecDoc | null): void {
    this.specByRun.delete(executionId)
    this.specByRun.set(executionId, spec)
    while (this.specByRun.size > PrVerificationReportController.MAX_TRACKED_RUNS) {
      const oldest = this.specByRun.keys().next()
      if (oldest.done) break
      this.specByRun.delete(oldest.value)
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

  /**
   * The run's rows in the provisioning event log, which DATE the environment lifecycle. Null
   * whenever they could not be read, which the section reports as "not evidenced" rather than
   * as an empty history (absent is not zero: an unwired log and an environment nobody reclaimed
   * produce the same empty list and opposite facts).
   *
   * GATED on the run actually having a deployer step, for the same reason the `spec/` read is
   * gated on a tester report: with no deployer the section's answer is already determined, so
   * the ~15 settlements of an ordinary build-and-merge run make no query at all. Deliberately
   * NOT memoised, unlike the spec: the teardown row is appended at the very END of the
   * lifecycle (often after the run itself has settled), so a memo taken on the deploying step
   * would pin the section to "still live" forever, which is the exact hole this section exists
   * to close.
   */
  private async provisioningEvents(
    workspaceId: string,
    instance: ExecutionInstance,
  ): Promise<ProvisioningLifecycleEvent[] | null> {
    const repo = this.deps.provisioningLogRepository
    if (!repo) return null
    if (!instance.steps.some((s) => s.agentKind === DEPLOYER_AGENT_KIND)) return null
    try {
      return await repo.list(workspaceId, {
        subsystem: 'environment',
        executionId: instance.id,
        limit: PROVISIONING_EVENT_LIMIT,
      })
    } catch {
      // Best-effort like every other read here. A transport blip reports the timeline as
      // un-evidenced on this publish and is re-attempted on the next settlement, never a
      // fabricated "torn down".
      return null
    }
  }

  /**
   * A deep link into one of the run's panels. The SPA is a single canvas, so the target is the
   * board with the run's view params (see `useRunDeepLink` in `@cat-factory/app`, and slice 4
   * of the global-search initiative, which will generalise the parser.
   *
   * `observability` opens Model activity / Provided context; `test-evidence` opens the tester
   * step's result window, where the screenshots the lifecycle section lists are rendered. Both
   * are values that narrow parser knows: adding a third means teaching it the view first, or
   * the link silently degrades to "the right board, no panel".
   */
  private deepLink(
    workspaceId: string,
    instance: ExecutionInstance,
    view: 'observability' | 'test-evidence',
  ): string | null {
    const base = this.deps.appBaseUrl?.trim()
    if (!base) return null
    // Built by hand rather than with `URLSearchParams`: orchestration is runtime-neutral and
    // compiles without the DOM lib, so the global isn't in its type surface.
    const query = Object.entries({
      ws: workspaceId,
      block: instance.blockId,
      run: instance.id,
      view,
    })
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&')
    return `${base.replace(/\/$/, '')}/?${query}`
  }
}
