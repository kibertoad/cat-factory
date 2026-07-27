import type {
  BlockRepository,
  Clock,
  ExecutionInstance,
  PrReportIssue,
  PrVerificationReportPublisher,
  TaskRepository,
  WorkspaceSettingsRepository,
} from '@cat-factory/kernel'
import { DEFAULT_WORKSPACE_SETTINGS } from '@cat-factory/kernel'
import type {
  ResolvedAcceptanceCriteria,
  ResolvedAcceptanceCriterion,
} from '@cat-factory/contracts'
import { composePrVerificationReport, renderPrVerificationReport } from './prReport.logic.js'

/** Minimal structured logger (pino-compatible); optional, like every other best-effort path. */
export interface PrReportLogger {
  warn(obj: Record<string, unknown>, msg?: string): void
}

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
   * Optional: the per-workspace `publishPrVerificationReport` opt-out. Absent (or no saved
   * settings row) ⇒ the default, which is ON — a deployment that wired a publisher wants the
   * report.
   */
  workspaceSettingsRepository?: WorkspaceSettingsRepository
  /**
   * Optional: the deployment's public SPA base URL, used to build the observability deep
   * link. Absent ⇒ the report's `observability.runUrl` is null and no link is rendered
   * (better than emitting a link to nowhere).
   */
  appBaseUrl?: string
  /**
   * Optional: resolve the service's CONFIRMED acceptance criteria for the run's BLOCK (the
   * controller has no frame in hand, so this closure owns the frame walk). Absent — or resolving
   * to none — ⇒ the criteria section reports `absent` with a note saying the service has no
   * contract recorded, which is the honest answer rather than a silently missing section.
   *
   * One indexed read per publish, and it is the ONLY read this hook added: the criteria are
   * service-scoped state that genuinely isn't on the `ExecutionInstance`, unlike every other
   * section, which composes from memory.
   */
  resolveAcceptanceCriteria?: (
    workspaceId: string,
    blockId: string,
  ) => Promise<ResolvedAcceptanceCriteria | null>
  /**
   * Optional structured logger for the best-effort failure path. Wire it: publishing is the
   * one part of the run that is DESIGNED to fail silently, so without a log a revoked token or
   * a rejected body leaves no trace anywhere — the report simply stops appearing.
   */
  logger?: PrReportLogger
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
          acceptanceCriteria: await this.acceptanceCriteria(workspaceId, instance.blockId),
          repo: target.repo,
          provider: target.provider,
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
      this.deps.logger?.warn(
        { err: error, executionId: instance.id, blockId: instance.blockId, workspaceId },
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
   * The service's confirmed acceptance criteria for the run's block. Degrades to `[]` on any
   * failure: the report is bookkeeping, and a criterion-store outage must cost the section its
   * detail, never the whole report its publish.
   */
  private async acceptanceCriteria(
    workspaceId: string,
    blockId: string,
  ): Promise<ResolvedAcceptanceCriterion[]> {
    const resolve = this.deps.resolveAcceptanceCriteria
    if (!resolve) return []
    try {
      return (await resolve(workspaceId, blockId))?.criteria ?? []
    } catch {
      return []
    }
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

/**
 * The engine's construction of a {@link PrVerificationReportController} — the hook that keeps a
 * run's verification report on its PR as each step settles (a hook, not a pipeline step: see
 * `docs/initiatives/pr-verification-report.md`). A no-op when no publisher is wired, so no-VCS
 * deployments and the engine tests are untouched.
 *
 * It also owns the one piece of
 * wiring the constructor cannot express declaratively: the report needs the service's confirmed
 * ACCEPTANCE CRITERIA, but its own dep is keyed by the run's BLOCK while the criteria store is
 * keyed by the SERVICE FRAME — so the frame walk is adapted in here.
 *
 * Factored out of the `ExecutionService` constructor (which is at its per-function line budget)
 * following the established controller-extraction pattern: it takes a small deps object of
 * already-built collaborators and bound call-backs, and the constructor keeps a one-line call.
 */
export function buildPrVerificationReportController(
  deps: Omit<PrVerificationReportControllerDeps, 'resolveAcceptanceCriteria'> & {
    /** Resolve a block's owning service frame id (the engine's context-builder walk), or null. */
    resolveServiceFrameId: (workspaceId: string, blockId: string) => Promise<string | null>
    /** The facade's FRAME-keyed criteria resolver; absent ⇒ the report reports them as absent. */
    resolveAcceptanceCriteria?: (
      workspaceId: string,
      frameId: string,
    ) => Promise<ResolvedAcceptanceCriteria | null>
  },
): PrVerificationReportController {
  const { resolveServiceFrameId, resolveAcceptanceCriteria, ...base } = deps
  return new PrVerificationReportController({
    ...base,
    ...(resolveAcceptanceCriteria
      ? {
          resolveAcceptanceCriteria: async (workspaceId: string, blockId: string) => {
            const frameId = await resolveServiceFrameId(workspaceId, blockId)
            return frameId ? resolveAcceptanceCriteria(workspaceId, frameId) : null
          },
        }
      : {}),
  })
}
