import type {
  BlockRepository,
  Clock,
  ExecutionInstance,
  Logger,
  PrReportIssue,
  PrReportOwnPullRequest,
  PrReportTarget,
  PrVerificationReportPublisher,
  ProvisioningLogRepository,
  ResolveRunRepoContext,
  TaskRepository,
  WorkspaceSettingsRepository,
} from '@cat-factory/kernel'
import { DEFAULT_WORKSPACE_SETTINGS, describeError } from '@cat-factory/kernel'
import { DEPLOYER_AGENT_KIND } from '@cat-factory/integrations'
import type { PrVerificationReport, RunOutcome, ServiceSpecView } from '@cat-factory/contracts'
import { composeRunOutcome } from '@cat-factory/contracts'
import { RunEvidenceLoader, specDocOf } from './RunEvidenceLoader.js'
import { boundOutcomeForApi } from './runOutcome.boundary.js'
import type { PrReportInputs } from './prReport.logic.js'
import { composePrVerificationReport, renderPrVerificationReport } from './prReport.logic.js'
import type { ProvisioningLifecycleRead } from './prReport.environments.js'

/**
 * How many of the run's environment provisioning rows the lifecycle timeline reads. A run stands
 * up one environment per involved service frame and retries a failing provision, so the realistic
 * count is single digits; the bound exists so a pathological retry loop (or a long stack recipe,
 * which logs a row per STEP) cannot make the report's own read unbounded.
 *
 * A read that comes back FULL is reported as truncated rather than folded. The fold follows
 * environment ids to decide whether everything the run stood up was reclaimed, and rows arrive
 * newest first, so a partial history silently loses the OLDEST bring-ups: an environment whose
 * provision row fell off the end reads as one that never existed, and therefore as one that never
 * needed reclaiming. That is a confident wrong answer where "the history is too long to date" is
 * an honest one.
 */
const PROVISIONING_EVENT_LIMIT = 200

/**
 * The own-service pull request, as a peer report names it, or null when the run has not opened
 * one.
 *
 * Read off the SAME resolved target list the reports are published onto rather than re-resolved
 * from the block, so the pull request a peer's copy points at and the one the own-service copy
 * is written onto cannot come from two different answers. Null is a real case and reported as
 * one: the coding agent can open a peer repo's PR on a run whose own-service PR is still to
 * come, and naming a pull request that does not exist is worse than saying it does not.
 */
function ownPrPointer(targets: readonly PrReportTarget[]): PrReportOwnPullRequest | null {
  const own = targets.find((t) => t.role === 'own')
  if (!own) return null
  return { repo: own.repo, number: own.prNumber, url: own.url ?? null }
}

/**
 * The report's inputs MINUS the three that are statements about one pull request rather than
 * about the run. Everything here is read once per settlement and shared by every copy of that
 * settlement's report; see {@link PrVerificationReportController.loadRunScopedInputs}.
 */
type RunScopedReportInputs = Omit<PrReportInputs, 'repo' | 'provider' | 'scope'>

/**
 * Layer one pull request's identity onto the run's shared evidence. Pure, and deliberately so:
 * the difference between two of a multi-repo run's reports is exactly these three fields plus
 * what the composer derives from them (a peer's copy withholds the own-service-only sections),
 * so composing the second one must cost no read.
 *
 * `target` is null for a run with no resolvable pull request, which only the READ path reaches:
 * it reports on the run itself with `repo`/`provider` unstated.
 */
function composeForTarget(
  instance: ExecutionInstance,
  base: RunScopedReportInputs,
  target: PrReportTarget | null,
  ownPullRequest: PrReportOwnPullRequest | null,
): PrVerificationReport {
  return composePrVerificationReport(instance, {
    ...base,
    repo: target?.repo ?? null,
    provider: target?.provider ?? null,
    scope: {
      role: target?.role ?? 'own',
      frameId: target?.frameId ?? null,
      // Only a PEER's copy points elsewhere: on the own-service report this would name the
      // very pull request the reader already has open.
      ownPullRequest: target?.role === 'peer' ? ownPullRequest : null,
    },
  })
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
 *
 * The same composition also answers the public read (`GET /api/v1/runs/:runId/report`) through
 * {@link PrVerificationReportController.composeForRun}, which is why there is no second
 * API-shaped projection of these facts: two composers is how a pull request and an API start
 * disagreeing about what a run proved.
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
   * Optional: this deployment's own externally-reachable BACKEND base URL (`PUBLIC_URL` on Node,
   * `WORKER_PUBLIC_URL` on the Worker), used to build every link a MACHINE follows: the bytes of
   * the artifacts the report lists, the run's tool-call trajectory, and the report itself served
   * live. Absent ⇒ those fields are null and the report states the ids alone.
   *
   * Deliberately separate from {@link appBaseUrl}: the two are the same origin on a same-origin
   * deployment and different ones the moment the SPA is served from its own host, and a link built
   * from the wrong one is worse than no link. They also answer different questions — the app URL
   * opens a panel a human browses, this one returns bytes to anything holding a credential.
   */
  apiBaseUrl?: string
  /**
   * Optional structured logger for the best-effort failure path. Wire it: publishing is the
   * one part of the run that is DESIGNED to fail silently, so without a log a revoked token or
   * a rejected body leaves no trace anywhere — the report simply stops appearing.
   */
  logger?: Logger
}

export class PrVerificationReportController {
  /**
   * The last section published per (execution, pull request), so settlements that change nothing
   * a reader would see cost no PR edit at all. Keyed by TARGET as well as run because a
   * multi-repo run publishes a different section to each of its PRs on the same settlement.
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
   * Hard cap on {@link lastPublished}, counted in PULL REQUESTS rather than runs: a single-repo
   * run holds one entry and a cross-service run one per PR it writes. Sized above the
   * `RunEvidenceLoader`'s per-RUN spec bound for that reason. Keyed per run, a handful of
   * concurrent cross-service runs would otherwise evict the single-repo runs' entries out from
   * under them.
   *
   * A long-lived Node replica serves an unbounded number of runs and each entry holds a rendered
   * section, so the map is bounded here rather than relying on a call site to evict finished runs
   * (a coupling that would silently leak the moment a new terminal path forgot to call it).
   * Oldest-first eviction: `Map` preserves insertion order, and evicting an entry only costs one
   * redundant (idempotent) republish.
   */
  private static readonly MAX_TRACKED_SECTIONS = 1024

  /**
   * The block + `spec/` reads both of this run's reductions share. A collaborator rather than two
   * private methods because {@link composeOutcomeForRun} needs exactly the same two answers, and a
   * second reader with its own branch choice or its own memo would drift from this one.
   */
  private readonly evidence: RunEvidenceLoader

  constructor(private readonly deps: PrVerificationReportControllerDeps) {
    this.evidence = new RunEvidenceLoader(deps)
  }

  /**
   * The run's OUTCOME summary (`GET /api/v1/runs/:runId/outcome`): the non-code answer to "what
   * did this run change, and what backs that up", for a reader who does not open the diff. Null
   * when the run's block is gone, exactly as {@link composeForRun} is.
   *
   * It lives on this controller because it reads the SAME evidence as the verification report and
   * must not read it differently: the reduction itself is `composeRunOutcome` in
   * `@cat-factory/contracts` (shared with the SPA, which composes it live off its own store), and
   * the coverage rules underneath both documents are shared too. What this method contributes is
   * the loader, so the summary a headless consumer fetches and the report on the pull request
   * cannot be built from two different reads of one run.
   *
   * Cheaper than the report on the ordinary path and never more expensive: it needs no linked
   * issues, no provisioning history and no pull-request target resolution, and it hits the same
   * gated, memoised `spec/` read.
   */
  async composeOutcomeForRun(
    workspaceId: string,
    instance: ExecutionInstance,
  ): Promise<RunOutcome | null> {
    const evidence = await this.evidence.load(workspaceId, instance)
    if (!evidence) return null
    // Composed from the loader's read VIEW, the same value the SPA's store now holds for this
    // run: the composer's `spec: 'not_read'` arm and a repo carrying no `spec/` are the one fact
    // arriving from two sides, and fabricating a view here would have been a third.
    const outcome = composeRunOutcome({
      block: evidence.block,
      instance,
      spec: evidence.specView,
    })
    // The BOUNDARY treatment, owed here and nowhere earlier: `composeRunOutcome` is shared with
    // the SPA, which renders into a DOM for a member of the workspace, while this value is the
    // response body of a public endpoint any read-scope key can fetch. The report already scrubs
    // and clamps the same tester text on its way onto a pull request; serving it verbatim here
    // would have made the weaker of the two surfaces the one an integration reads.
    return boundOutcomeForApi(outcome)
  }

  /**
   * The run's `spec/` as the SPA's outcome card must join against it: the same read, through the
   * same loader and the same branch rule, that {@link composeOutcomeForRun} uses.
   *
   * Here rather than on a spec-owning module because the branch is a fact about the RUN, and the
   * card asking a service-scoped endpoint for it is exactly how the two came to answer one
   * question differently. See {@link RunEvidenceLoader.specViewForRun}.
   */
  async readRunSpec(workspaceId: string, instance: ExecutionInstance): Promise<ServiceSpecView> {
    return this.evidence.specViewForRun(workspaceId, instance)
  }

  /**
   * Compose the report for `instance` and upsert it onto every pull request the run opened.
   * Best-effort: returns silently on every skip/failure path.
   */
  async publishForRun(workspaceId: string, instance: ExecutionInstance): Promise<void> {
    const publisher = this.deps.publisher
    if (!publisher) return
    try {
      if (!(await this.publishingEnabled(workspaceId))) return
      // Ask the adapter WHERE this would go before composing anything: it both short-circuits a
      // run that has no PR yet (most runs, for most of their life) and supplies the repo +
      // provider + role each report states — the same resolution the writes themselves use, so
      // a report can never name a different repo from the one it lands on.
      //
      // A multi-repo run resolves several targets (own-service PR plus one per peer repo the
      // run opened a PR in) and each gets its OWN composed report: they are not the same
      // document, because the own-service-only sections are withheld from a peer's copy.
      const targets = await publisher.resolveTargets(workspaceId, instance.blockId)
      if (!targets.length) return

      // The run-scoped evidence is read ONCE for the whole set, not once per pull request. Every
      // one of these reads answers a question about the RUN (its block, its linked issues, its
      // service's `spec/`, its provisioning history), so the answer cannot differ between two of
      // its PRs — reading them per target would be a plain N+1 on a hook that fires on every
      // settled step. What varies per target is the repo, the provider and the scope, and those
      // are already in hand.
      const base = await this.loadRunScopedInputs(workspaceId, instance)
      // Only a task carries an implementation PR; a frame/module run has nothing to report on.
      if (!base) return
      const ownPullRequest = ownPrPointer(targets)

      for (const target of targets) {
        // Each target is published independently and a failure on one does not cost the others:
        // a peer repo whose token was revoked must not stop the own-service PR — the one a
        // reviewer is most likely looking at — from getting its report.
        await this.publishTo(publisher, workspaceId, instance, base, target, ownPullRequest)
      }
    } catch (error) {
      // A PR-report write is bookkeeping. A provider outage, a revoked token, or a PR someone
      // closed underneath the run must never turn a green run red.
      this.deps.logger?.warn('Failed to publish the PR verification report', {
        err: describeError(error),
        executionId: instance.id,
        blockId: instance.blockId,
        workspaceId,
      })
    }
  }

  /**
   * Compose and publish the report for ONE resolved target. Best-effort per target: a failure is
   * logged and swallowed here rather than at the loop, so one unreachable peer repo does not
   * cost every remaining PR its report.
   */
  private async publishTo(
    publisher: PrVerificationReportPublisher,
    workspaceId: string,
    instance: ExecutionInstance,
    base: RunScopedReportInputs,
    target: PrReportTarget,
    ownPullRequest: PrReportOwnPullRequest | null,
  ): Promise<void> {
    try {
      const section = renderPrVerificationReport(
        composeForTarget(instance, base, target, ownPullRequest),
      )
      // `generatedAt` changes on every compose, so compare the section with it masked out —
      // otherwise the cache would never hit and every step would edit the PR.
      const fingerprint = section.replaceAll(/"generatedAt": \d+/g, '"generatedAt": 0')
      // Keyed by run AND target: a multi-repo run publishes several DIFFERENT sections per
      // settlement, so one key per run would let the first target's fingerprint suppress every
      // other target's write and the peers would carry a stale report forever.
      const key = `${instance.id} ${target.repo}#${target.prNumber}`
      if (this.lastPublished.get(key) === fingerprint) return
      // The publisher is passed in rather than re-read off `deps` and optional-chained: such a
      // call would no-op silently while `remember` below still recorded the fingerprint, which
      // suppresses every later write for this pull request.
      await publisher.publish(workspaceId, target, section)
      this.remember(key, fingerprint)
    } catch (error) {
      this.deps.logger?.warn('Failed to publish the PR verification report onto a pull request', {
        err: describeError(error),
        executionId: instance.id,
        blockId: instance.blockId,
        workspaceId,
        repo: target.repo,
        prNumber: target.prNumber,
        role: target.role,
      })
    }
  }

  /**
   * The same report, composed for a READER rather than for the pull request
   * (`GET /api/v1/runs/:runId/report`). Null when the run's block is gone, which is the only way
   * a run has nothing to report on.
   *
   * Three differences from {@link publishForRun}, each deliberate:
   *  - **A run with no pull request still gets a report.** The publish path short-circuits on an
   *    unresolved target because there is nowhere to write; a reader is asking about the RUN, and
   *    a headless job or a run that failed before it pushed is exactly the case a PR-body-scraping
   *    consumer could never see. An unresolved target simply leaves `repo`/`provider` null.
   *  - **The per-workspace opt-out is not consulted.** `publishPrVerificationReport` says whether
   *    this deployment writes onto someone's pull request, which is a statement about a REMOTE
   *    surface; it was never a statement about whether the workspace's own evidence may be read
   *    back over an authenticated, workspace-scoped key.
   *  - **Failures are not swallowed.** Publishing is bookkeeping that must never fail a run; a
   *    read that cannot answer must say so rather than hand back a report with holes in it that
   *    look like findings.
   *
   * WHAT A CALLER IS BUYING. Composition is not free and this is the one `/api/v1` read that can
   * reach OUTSIDE the deployment: a run whose tester reported pulls the service's `spec/` tree off
   * the run's branch over the VCS API ({@link PrVerificationReportController.serviceSpec}), which
   * is memoised per run but only within one process, so a Worker isolate that has not seen the run
   * pays it again. Everything else is a handful of indexed row reads. That cost is accepted rather
   * than dodged: dropping the spec join on the read path would make the API answer differ from the
   * pull-request body, and one report with two contents is the exact failure serving the report
   * verbatim exists to prevent. It is stated in `backend/docs/public-api.md` so an integration
   * polling every run knows what it is asking for, and left OUT of the app-cache seam on purpose,
   * since the branch it reads keeps moving and the seam is pass-through for mutable state on the
   * Worker anyway: a cache there would add a coherence problem without removing the fetch.
   */
  async composeForRun(
    workspaceId: string,
    instance: ExecutionInstance,
  ): Promise<PrVerificationReport | null> {
    // The OWN-SERVICE report is what a reader asking about the run gets, on a multi-repo run as
    // much as a single-repo one: it is the complete one (a peer's copy deliberately withholds
    // the own-service-only sections), and the API answers a question about the RUN, not about
    // one of its pull requests. A run with no own-service PR composes an unscoped report, the
    // same as one with no PR at all.
    const targets = (await this.deps.publisher?.resolveTargets(workspaceId, instance.blockId)) ?? []
    const own = targets.find((t) => t.role === 'own') ?? null
    const base = await this.loadRunScopedInputs(workspaceId, instance)
    if (!base) return null
    return composeForTarget(instance, base, own, ownPrPointer(targets))
  }

  /**
   * Read everything the report needs that is a fact about the RUN rather than about one of its
   * pull requests. Null when the block is gone, the only way a run has nothing to report on.
   *
   * Called ONCE per settlement, however many pull requests the run opened: none of these answers
   * can differ between two PRs of the same run, so re-reading them per target would be an N+1
   * over a list — the exact shape this codebase bans — on the hook that fires on every settled
   * step. What is genuinely per-PR (repo, provider, scope) is layered on top by
   * {@link composeForTarget}, which touches no repository at all.
   *
   * `now` is stamped here for the same reason: every copy of one settlement's report is the same
   * observation, so they carry the same `generatedAt` rather than drifting by however long the
   * writes take.
   *
   * The block is read here even though the publisher's `resolveTargets` has just read it too, and
   * that second point read is deliberate rather than overlooked: threading the row through would
   * mean this controller deciding which pull request is the block's, the judgement the publisher
   * owns precisely so nothing else forms a second opinion about it. Two indexed reads by primary
   * key is a fine price for that; a per-target read would not have been.
   */
  private async loadRunScopedInputs(
    workspaceId: string,
    instance: ExecutionInstance,
  ): Promise<RunScopedReportInputs | null> {
    const evidence = await this.evidence.load(workspaceId, instance)
    if (!evidence) return null
    return {
      block: evidence.block,
      issues: await this.linkedIssues(workspaceId, instance.blockId),
      runUrl: this.deepLink(workspaceId, instance, 'observability'),
      trajectoryUrl: this.apiLink(
        `/api/v1/debug/runs/${encodeURIComponent(instance.id)}/tool-calls?order=trajectory`,
      ),
      reportUrl: this.apiLink(`/api/v1/runs/${encodeURIComponent(instance.id)}/report`),
      spec: specDocOf(evidence.specView),
      environments: {
        provisioning: await this.provisioningEvents(workspaceId, instance),
        evidenceUrl: this.deepLink(workspaceId, instance, 'test-evidence'),
        artifactUrl: (artifactId) => this.artifactUrl(workspaceId, artifactId),
      },
      now: this.deps.clock.now(),
    }
  }

  /**
   * Record the published fingerprint, evicting the oldest entry once the cap is reached. `key`
   * is per run AND per target, so a multi-repo run holds one entry per pull request it writes.
   */
  private remember(key: string, fingerprint: string): void {
    this.lastPublished.delete(key)
    this.lastPublished.set(key, fingerprint)
    while (this.lastPublished.size > PrVerificationReportController.MAX_TRACKED_SECTIONS) {
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
   * The run's rows in the provisioning event log, which DATE the environment lifecycle, or the
   * REASON there are none. Each of the three ways this comes back empty is its own answer,
   * because each is a different thing to fix and only one of them is a statement about how the
   * deployment is configured: an unwired log, a read that failed, and a truncated read all
   * produce the same empty timeline (absent is not zero, and neither is unreadable).
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
  ): Promise<ProvisioningLifecycleRead> {
    const repo = this.deps.provisioningLogRepository
    if (!repo) return { status: 'unwired' }
    if (!instance.steps.some((s) => s.agentKind === DEPLOYER_AGENT_KIND)) {
      return { status: 'not_provisioned' }
    }
    try {
      const events = await repo.list(workspaceId, {
        subsystem: 'environment',
        executionId: instance.id,
        limit: PROVISIONING_EVENT_LIMIT,
      })
      // A full page is indistinguishable from a page that had more behind it, so it is reported
      // as incomplete rather than folded into a verdict (see PROVISIONING_EVENT_LIMIT).
      if (events.length >= PROVISIONING_EVENT_LIMIT) return { status: 'truncated' }
      return { status: 'read', events }
    } catch (error) {
      // Best-effort like every other read here: a transport blip reports the timeline as
      // unreadable on this publish and is re-attempted on the next one, never a fabricated
      // "torn down". Reported rather than dropped, because a permanently broken telemetry
      // binding would otherwise show only as a section that never dates anything.
      this.deps.logger?.warn('Failed to read the provisioning log for the PR report', {
        err: describeError(error),
        executionId: instance.id,
        workspaceId,
      })
      return { status: 'unreadable' }
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
  /**
   * The direct link to ONE stored artifact's bytes, on this deployment's authenticated blob
   * endpoint (`GET /workspaces/:ws/artifacts/:id/blob`), or null when no public backend URL is
   * configured.
   *
   * This is what turns a captured screenshot from an opaque id into something a reviewer can open
   * and a downstream tool can fetch. The endpoint is authenticated, which is the point: the bytes
   * are workspace-scoped, and a report on a public repository must never carry an unguessable-URL
   * bypass of that. A reader without access gets a 401 rather than the image — the honest outcome,
   * and the same one the app deep link beside it produces.
   */
  private artifactUrl(workspaceId: string, artifactId: string): string | null {
    return this.apiLink(
      `/workspaces/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}/blob`,
    )
  }

  /**
   * An absolute link to one of this deployment's own backend endpoints, or null when no public
   * backend URL is configured (in which case the report states the ids and no link, rather than
   * a link to nowhere).
   *
   * `path` is already-encoded and starts with `/`. Built by hand rather than with `URL`, for the
   * reason {@link deepLink} gives: orchestration is runtime-neutral and compiles without the DOM.
   */
  private apiLink(path: string): string | null {
    const base = this.deps.apiBaseUrl?.trim()
    return base ? `${base.replace(/\/$/, '')}${path}` : null
  }

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
