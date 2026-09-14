import type { StepSubtasks, StreamedFollowUp, WebSearchAvailability } from '../domain/types.js'
import type { SubscriptionVendor, DispatchToolServers } from '@cat-factory/contracts'
import type { HarnessFailureCause } from '../domain/harness-failure.js'
import type { AgentExecutor, AgentRunContext, AgentRunResult } from './agent-executor.js'
import type { ContainerEvictionKind } from './runner-transport.js'
import type { DelegationHandle } from './delegated-executor.js'

// ---------------------------------------------------------------------------
// An agent job that OUTLIVES the request that started it: how it is addressed, how it is observed,
// and how what it holds is reclaimed.
//
// Its own module because the three answer one question and because the answer is shaped by ONE
// constraint the rest of the executor port does not share: a poll runs in a different process,
// after a durable replay, and rebuilds everything it knows from the persisted STEP. That is why
// the handle carries facts an executor could otherwise resolve for itself (the model, the leased
// token, the delegation), why the update carries evidence rather than only a verdict, and why a
// reclaim takes a target rather than a job.
//
// `agent-executor.ts` re-exports all of it, so either module is a valid import site. The split
// exists because that file sits at its size budget, which is a split trigger rather than a
// number to raise.
// ---------------------------------------------------------------------------

/** A handle to an asynchronous agent job (e.g. a long-running container run). */
export interface AgentJobHandle {
  /** Opaque identifier the executor uses to address the running job when polled. */
  jobId: string
  /**
   * The run (execution) the job belongs to. A run executes a sequence of jobs (one
   * per pipeline step) that share one per-run container, so the poll/stop site needs
   * the run id (alongside the per-step {@link jobId}) to address that container
   * (and to reclaim it). Set by the executor at dispatch and re-supplied by the
   * engine at the poll/stop site (it always has the execution id in scope). Absent ⇒
   * the job IS its own run (a single-job flow), so callers fall back to {@link jobId}.
   */
  runId?: string
  /**
   * The model the job runs (`provider:model`), known at dispatch. Recorded on the
   * step immediately so the board shows it even though the poll site, which maps
   * the eventual result, has no access to the resolved model ref.
   */
  model?: string
  /**
   * The workspace the job belongs to. The engine sets this at the poll site (it is
   * in scope there) so an executor that picks a per-workspace backend (e.g. the
   * container executor choosing a self-hosted runner pool over Cloudflare
   * Containers) can resolve the same backend when polling, given only the job id.
   */
  workspaceId?: string
  /**
   * For a subscription-harness job, the id of the pooled token leased for it, so
   * the poll site can attribute the run's usage back to the right pool row
   * (usage-aware rotation). Absent for proxy-metered Pi jobs.
   */
  subscriptionTokenId?: string
  /**
   * The run initiator's user id, carried so the poll site can attribute a PERSONAL
   * (individual-usage) subscription run's quota usage to the right user: the personal
   * path leases no pooled token, so {@link subscriptionTokenId} is absent for it. Set by
   * the executor at dispatch; absent for runs with no known initiator (system paths).
   */
  initiatedByUserId?: string
  /**
   * The model provider/vendor the job runs on (e.g. `claude`, `codex`, `openai`),
   * known at dispatch. Carried so the poll site can stamp it on the per-call telemetry
   * a subscription harness reports (which the proxy would otherwise supply). Absent ⇒
   * telemetry falls back to the provider parsed from {@link model}.
   */
  provider?: string
  /**
   * The SUBSCRIPTION VENDOR this job's harness runs on, when the dispatch resolved one: the
   * vendor slug (`claude` / `codex` / `glm` / `kimi` / `deepseek`), not the model's provider.
   *
   * Carried separately from {@link provider} because the two differ for four of the five vendors
   * (`claude`⇄`anthropic`, `codex`⇄`openai`, `glm`⇄`zai`, `kimi`⇄`moonshot`), and it is the VENDOR
   * that keys a quota cycle. Read off the provider instead, the modeled quota fold silently
   * matched only DeepSeek and counted nothing at all for the other four. Absent for a
   * proxy-metered Pi job, which has no vendor and no quota to fold.
   */
  subscriptionVendor?: SubscriptionVendor
  /**
   * The agent kind the job runs as (`coder`, `merger`, …). The poll site MUST supply it
   * for any kind whose result is mapped kind-aware (e.g. a migrated `merger`/`on-call`,
   * whose structured output is coerced into `mergeAssessment`/`onCallAssessment`); without
   * it that coercion silently no-ops and the engine's gate sees no assessment. Also used to
   * label the job's tool spans on the observability trace. Optional only because not every
   * executor needs it; absent ⇒ no kind-aware mapping + spans grouped under the run unlabelled.
   */
  agentKind?: string
  /**
   * Whether web search was available to this job's container and which upstream backend
   * served it, resolved backend-side at dispatch (the run's account web-search keys, else
   * the deployment default). Recorded on the step immediately so the run details surface
   * "Web search: SearXNG" / "unavailable" without waiting for a poll. Absent for executors
   * that don't resolve search availability (inline agents, tests).
   */
  search?: WebSearchAvailability
  /**
   * The repo this job operates on, resolved at dispatch. Recorded in the run's diagnostics so a
   * later investigation knows which repo/branch the step ran against without re-joining the
   * service↔repo↔installation projection. `provider` is the VCS provider (`github`/`gitlab`) from
   * the run's repo origin. Absent for executors that don't operate on a repo (inline agents, tests).
   */
  repo?: { owner: string; name: string; baseBranch?: string; provider?: string }
  /**
   * What this dispatch did with the tool servers (MCP) the running agent kind declared: the ones
   * it wired, and the ones it dropped with the reason it dropped them. Recorded on the step
   * immediately, for the same reason {@link model} and {@link search} are: the poll site rebuilds
   * this handle from the STEP alone, so a dispatch-time resolution not recorded here is gone by
   * the time the job settles.
   *
   * It genuinely cannot be re-derived later: whether a server is servable depends on the resolved
   * harness and on the facade-wired secret/OAuth resolvers at that moment, and a workspace that
   * fills in a missing credential an hour later would make a step that ran without the tool read
   * as one that had it. Absent for executors that wire no tool servers (inline agents, tests).
   *
   * Carries no agent kind: `recordDispatchAttribution` stamps the DISPATCHED kind on it as it
   * folds, from the same parameter that feeds `step.dispatches`, so an executor cannot label a
   * resolution with a kind other than the one the engine dispatched.
   */
  toolServers?: DispatchToolServers
  /**
   * The DELEGATION this handle addresses, when the step ran on an external executor rather than a
   * container: which registered executor, its own id for the work, and where a human watches it.
   *
   * On the handle for the same reason `model` and `toolServers` are: the durable poll path rebuilds
   * the handle from the STEP alone, and `recordDispatchAttribution` persists exactly what is here.
   * Without it a poll has no executor to route to, and the step settles against nothing.
   */
  delegated?: {
    executor: string
    externalId: string
    url?: string
    /** The branch pair the dispatch resolved; see `DelegationHandle.branches` for why. */
    branches?: { base: string; work: string }
    /** The repository the WORK targets; see `DelegationHandle.repo` for why it is not derivable. */
    repo?: { owner: string; name: string }
  }
}

/** The outcome of polling an {@link AgentJobHandle}. */
export type AgentJobUpdate =
  /**
   * Still working: the durable driver should keep polling. `subtasks`, when
   * present, carries the job's latest subtask counts (the container agent reads
   * these from the coding tool's todo list) so the driver can surface live
   * "N/M done" progress on the step between polls. `followUps`, when present,
   * carries the forward-looking items the Coder streamed since the last poll
   * (drain-on-read) so the engine can append them to the run's step live (the
   * Follow-up companion). `phase` carries the container's current lifecycle phase
   * (clone / agent / push) and `container` its identity/address (id, url) once up,
   * so the engine can surface what the container is doing + where it's running.
   */
  | {
      state: 'running'
      subtasks?: StepSubtasks
      followUps?: StreamedFollowUp[]
      phase?: string
      container?: { id?: string; url?: string }
      /** Which runner backend served this job (see {@link RunnerJobView.backend}); recorded in
       *  the run diagnostics on the first poll that reports it. */
      backend?: string
      /**
       * Epoch ms of the harness's last sign of life (forwarded from {@link RunnerJobView.heartbeatAt}),
       * so a quiet-but-alive job keeps advancing the step's throttled `lastActivityAt`, and thus the
       * run's `updated_at`, even when no subtask/phase changed. Absent on an older harness image.
       */
      lastActivityAt?: number
      /**
       * The LATEST pre-PR validation attempt's report (forwarded from
       * {@link RunnerJobView.validationReport}), so the engine can surface "lint failed,
       * repairing (attempt 2 of 3)" on the step WHILE the loop is still running. Absent for a
       * job whose service configured no checks / on an older harness image.
       */
      validationReport?: unknown
      /**
       * The reproduction proof as it stands mid-run (forwarded from
       * {@link RunnerJobView.reproductionReport}), so the engine can surface "verifying the
       * reproduction" / a failed verification on the step WHILE the loop is still running.
       * Absent for a job carrying no declaration / on an older harness image.
       */
      reproductionReport?: unknown
      /**
       * The per-slice reviews a parallel PR review has captured so far (forwarded from
       * {@link RunnerJobView.sliceReviews}), so the engine can persist each slice's completed
       * review work as it lands instead of only from the terminal structured output.
       *
       * Unlike the two reports above this is not merely for surfacing: the reviewer returns its
       * `slices`/`findings` ONLY at completion, so before this a review killed mid-run (or one
       * whose aggregation pass wedged) lost every finished slice and could only be re-run from
       * zero. What the engine folds from here is what a manual resume re-aggregates from. Absent
       * for a job that dispatched no subagents / on an older harness image.
       */
      sliceReviews?: unknown
      /**
       * What the agent's CLI reported about the tool servers it loaded (forwarded from
       * {@link RunnerJobView.toolServers}), so the step's tool-server record gains the OBSERVED
       * half while the run is still going, which is when a failed server is still worth acting
       * on. Absent for a job that wired none, a harness whose CLI reports nothing, or an older
       * image; the engine records that as "not observed", never as a failure.
       */
      toolServers?: unknown
      /**
       * What a DELEGATED executor learned about its own run after starting it: today the external
       * URL, which many systems cannot supply until the run has an id (`workflow_dispatch` answers
       * 204). Folded onto the step's delegation record, where it is the primary affordance: the
       * link a human follows to the executor's own logs. Absent for every container job.
       */
      delegated?: { url?: string }
    }
  /**
   * Finished successfully; `result` carries the work product. `followUps`, when present,
   * carries any final burst of streamed items the harness drained on the SAME poll that
   * observed completion (the tailer is flushed before the job is marked done), so the
   * engine never loses the last items, notably a question that must hold the gate.
   * `toolServers` carries the CLI's startup report for the same reason it rides the failed
   * variant: a job short enough to settle between two polls is never seen `running` at all, so
   * the settled poll is the ONLY one that can deliver it.
   */
  | {
      state: 'done'
      result: AgentRunResult
      followUps?: StreamedFollowUp[]
      toolServers?: unknown
      /**
       * What a DELEGATED executor settled with: its external URL (see the running variant), and
       * the branch its work LANDED on when it pushed without opening a pull request.
       *
       * The branch is carried rather than dropped because it is the whole product of that case,
       * which the port names as legitimate (`DelegationResult.branch`): a seed-only step, or an
       * executor whose policy is to push and let a later step open the PR. Without it the platform
       * records the run as done with nothing to show for it, which is the "absent and zero must
       * never render the same" failure one level up from the one this seam already guards.
       */
      delegated?: { url?: string; branch?: string }
    }
  /**
   * Finished with a failure (agent error, inactivity/max-duration watchdog, …). When the
   * harness reported a STRUCTURED `failureCause`, it is forwarded here so the driver can
   * classify the failure (→ `AgentFailureKind`) without regex-matching `error`; absent on an
   * older harness image (the driver falls back to the error-string regex). `detail` carries an
   * extended, redacted diagnostic (phase timings, last-tool breadcrumb) distinct from the
   * one-line `error`, surfaced as the failure detail on the board. `evicted` carries the
   * transport's STRUCTURED container-eviction classification (forwarded from
   * {@link RunnerJobView.evicted}) so the driver recovers it on the right budget without
   * regex-matching `error`; absent on a non-eviction failure or an older producer.
   */
  | {
      state: 'failed'
      error: string
      failureCause?: HarnessFailureCause
      detail?: string
      backend?: string
      evicted?: ContainerEvictionKind
      /**
       * The transport watched the harness EXIT CLEANLY with this job still in flight (forwarded
       * from {@link RunnerJobView.harnessShutdown}): it was shut down, not lost. Mutually
       * exclusive with `evicted`, and the driver treats it as terminal rather than recovering it.
       */
      harnessShutdown?: true
      /**
       * The pre-PR validation report of a job that failed BECAUSE its checks stayed red until
       * the attempt budget was spent: the evidence behind the failure (each command's exit code
       * + a bounded, secret-scrubbed output tail). The engine records it on the step beside the
       * failure detail. Absent for every other failure and for a job with no checks configured.
       */
      validationReport?: unknown
      /**
       * The reproduction proof of a job that failed for an UNRELATED reason after the proof ran
       * (a red pre-PR validation check, an eviction). A failed verification never fails a job by
       * itself (see the initiative's D6), so this is evidence carried alongside someone else's
       * failure, recorded on the step so the work is not lost with the run.
       */
      reproductionReport?: unknown
      /**
       * What the agent's CLI reported about the tool servers it loaded (forwarded from
       * {@link RunnerJobView.toolServers}). Carried on the FAILED path deliberately, and this is
       * the disposition that matters most: a run that failed after the prompt promised it tools
       * its CLI never managed to start is exactly the run whose post-mortem needs this, and a job
       * that dies before its first successful poll would otherwise carry no observation at all.
       */
      toolServers?: unknown
      /**
       * What a DELEGATED executor failed with: its external URL, and whether the verdict is
       * TERMINAL.
       *
       * The url is carried on this path for the reason `toolServers` is, and it matters more here:
       * the failure message is one line and the executor's own logs are the whole post-mortem, so a
       * failed delegated step with no link is a dead end.
       *
       * `terminal` is the delegated counterpart of {@link harnessShutdown} and deliberately NOT a
       * reuse of it: the two want the same disposition ("do not spend a recovery budget") and
       * different names, and only the name reaches a human. Borrowing the container flag reported
       * every external CI failure as `harness_shutdown`, which renders as "Harness shut down" for a
       * step that never had a harness. Absent ⇒ the failure is re-driven on the ordinary
       * job-failure budget, which is what an executor's own `retryable: true` asks for.
       */
      delegated?: { url?: string; terminal?: true }
    }

/**
 * An executor whose work can outlive a single request. Instead of `run()`
 * blocking until the work finishes (which would cap the work at one durable
 * step's timeout), the driver {@link startJob}s it and then {@link pollJob}s for
 * completion between durable sleeps. This lets a long coding job run for many
 * minutes while every individual driver step stays short and cheaply retriable.
 *
 * Implemented by the container executor (whose Pi coding run can take a long
 * time); inline LLM executors stay plain {@link AgentExecutor}s and run in one
 * shot. `run()` remains available (it dispatches then polls internally) for
 * non-durable callers and tests.
 */
export interface AsyncAgentExecutor extends AgentExecutor {
  /** Whether `context` should be driven as a polled job rather than run inline. */
  runsAsync(context: AgentRunContext): boolean
  /**
   * Start the job for `context`, or re-attach to one already running for it. Must
   * be idempotent per execution so a replayed dispatch never starts a duplicate.
   */
  startJob(context: AgentRunContext): Promise<AgentJobHandle>
  /** Poll a previously-started job for its current state. */
  pollJob(handle: AgentJobHandle): Promise<AgentJobUpdate>
  /**
   * Best-effort: reclaim EVERY runner resource the run holds (e.g. kill its per-run
   * containers), so a user cancel / block delete / orphan sweep does not leak one that idles
   * until its watchdog. Optional: backends with nothing to reclaim may omit it, and callers must
   * treat it as best-effort and must not let a failure here derail their own teardown.
   * Idempotent: reclaiming an already-gone run is a no-op.
   *
   * It takes a {@link RunReclaimTarget} rather than a job handle because a run is NOT one
   * container: a step declaring a different executor image runs in its own, beside the
   * ordinary one, and a reclaim addressing a single job leaves the other alive until its
   * maximum lifetime elapses (a `tester-ui` step leaks a whole browser container that way).
   *
   * It may ANSWER with what the reclaim achieved (see {@link RunReclaimReport}), which matters for
   * exactly one class of resource: work running in somebody else's system. Returning nothing keeps
   * the prior contract and is right for a container backend, where the reclaim either killed the
   * container or it was already gone.
   */
  reclaimRun?(target: RunReclaimTarget): Promise<RunReclaimReport | void>
}

/**
 * What a reclaim ACHIEVED, for the resources where "we asked" and "it stopped" are different facts.
 *
 * A container reclaim needs none of this: the container is destroyed or it had already vanished,
 * and either way nothing of ours is still running. DELEGATED work is the opposite: the executor
 * may declare no `cancel` at all, in which case the external run carries on, opens its pull request
 * and bills its tokens long after the platform recorded the run as stopped. Reporting it is what
 * lets the step SAY so instead of rendering a clean teardown over a job nobody stopped.
 */
export interface RunReclaimReport {
  /** One entry per delegated unit the target named, keyed by its correlation key. */
  delegations?: readonly {
    correlationKey: string
    /** Whether the external work was actually stopped. False ⇒ it is still running. */
    cancelled: boolean
    /** Why not, or how: one line, recorded on the delegation record. Never a credential. */
    note?: string
  }[]
}

/**
 * What a run-level reclaim addresses (see {@link AsyncAgentExecutor.reclaimRun}).
 *
 * `agentKinds` is the load-bearing field and the reason this is not a job handle: only the
 * ENGINE knows which kinds a run dispatched (it holds the steps), and only the EXECUTOR knows
 * which executor image each kind declared, so neither can name the run's containers alone.
 * Passing the kinds lets the executor map them to the distinct images the run actually
 * started, rather than either reclaiming one container or waking every image variant a
 * deployment could serve.
 */
export interface RunReclaimTarget {
  /** The run (execution) whose resources are being reclaimed. */
  runId: string
  /** The workspace, so an executor picking a per-workspace backend resolves the same one. */
  workspaceId?: string
  /**
   * The in-flight step's job id, for a per-JOB backend (a self-hosted pool) that cancels
   * exactly that job. A per-run container backend ignores it and reclaims by run.
   */
  jobId: string
  /**
   * Every agent kind this run DISPATCHED, in no particular order and free of duplicates or
   * not. Empty is a valid answer (a run that never dispatched), and still reclaims the run's
   * ordinary container: the kinds only ever ADD the containers a non-default image opened.
   */
  agentKinds: readonly string[]
  /**
   * Every DELEGATED unit this run still has running somewhere else, as the handles the executors
   * address them by. Empty (and usually absent) for the ordinary run, which delegates nothing.
   *
   * On the target for the same reason `agentKinds` is: only the ENGINE holds the steps, so only it
   * can name what the run started, and a reclaim that addressed only containers left external work
   * running with nothing left pointing at it. Unlike the kinds, these carry an id the executor
   * cannot re-derive: a delegated step's whole identity in the external system is what the claim
   * persisted.
   */
  delegations?: readonly DelegationHandle[]
}

/** Narrow an executor to the async-capable interface. */
export function isAsyncAgentExecutor(executor: AgentExecutor): executor is AsyncAgentExecutor {
  const candidate = executor as Partial<AsyncAgentExecutor>
  return (
    typeof candidate.runsAsync === 'function' &&
    typeof candidate.startJob === 'function' &&
    typeof candidate.pollJob === 'function'
  )
}
