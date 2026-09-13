import type { CapabilityCredential } from '@cat-factory/contracts'
import type { InjectedContextFile, PullRequestRef } from '../domain/types.js'
import type { VcsProvider } from '../domain/vcs-types.js'
import type { OwnServiceContext } from '../domain/block-tree.js'
import type { AgentTokenUsage } from './agent-executor.js'
import type { Clock } from './runtime.js'
import type { Logger } from './logging.js'
import type { RepoFiles } from './repo-files.js'
import type { UrlSafetyPolicy } from './url-safety-policy.js'

// ---------------------------------------------------------------------------
// DELEGATED EXECUTION: the third executor class, beside inline and container.
//
// A deployment already running its own lower-level coding executor (a GitHub-Actions
// implement/review/test loop, an internal job runner, a vendor's autonomous PR bot) plugs it in
// HERE, as the executor of one pipeline step. cat-factory stays the top-level orchestrator (what
// to work on, in which repo, with which standards, gated by which policy, followed by which merge
// and which notification), and the registered executor supplies only the middle.
//
// What the platform asks of such a system is deliberately small, because that is what makes the
// seam reachable: it must be startable, observable as running/failed/completed, and linkable. It
// is NOT asked for token usage, LLM call telemetry or a tool trajectory. Every hook for those
// exists (see `DelegationResult.usage` and the definition's `telemetry` declaration), and until an
// executor fills them in, each surface STATES that the data is not reported rather than rendering
// a zero: the "absent and zero must never render the same" rule applied to a whole executor.
//
// Design record: `docs/initiatives/delegated-executors.md`.
// ---------------------------------------------------------------------------

/**
 * The neutral bundle the engine hands an executor at dispatch: what the container path already
 * composes, extracted so it exists as a VALUE outside a harness job body.
 *
 * It is the production prompt. The container body builder consumes the same composition (see
 * `composeAgentBrief` in `@cat-factory/server`), so the standards a workspace agreed on, the
 * service estate it was briefed with and the workspace's own prompt override reach a delegated
 * executor and a container harness identically. A drift here would deliver them to one and not
 * the other, silently.
 *
 * It carries NO credentials. Those arrive through the second argument of
 * {@link DelegatedExecutor.start} / {@link DelegatedExecutor.poll}, resolved per call, so a value
 * whose lifetime is an hour is never frozen into a record that outlives it.
 */
export interface DelegationBrief {
  /**
   * The cat-factory job id for this dispatch, and the ONE stable handle an executor has for
   * recovering its own external id (see {@link DelegatedExecutor}). Many external systems return
   * nothing identifying at start (`workflow_dispatch` answers 204 with no run id), so the platform
   * does not paper over it: it supplies the key, and the executor correlates.
   */
  correlationKey: string
  workspaceId: string
  runId: string
  /** Which step of the run this is, so an executor's own record can name it. */
  stepIndex: number
  /** The agent kind that was dispatched, which is not always the step's declared one. */
  agentKind: string
  task: {
    id: string
    title: string
    description: string
    /** Where the work came from, when it came from a tracker. */
    trackerRef?: { provider: string; key: string; url?: string }
  }
  repo: {
    owner: string
    name: string
    cloneUrl: string
    provider: VcsProvider
    /** A monorepo subtree the service lives in, relative to the repo root. */
    directory?: string
  }
  branches: {
    /** The repo's default branch: what a change is diffed against and what work forks from. */
    base: string
    /** The deterministic per-task work branch every step of this run's pipeline shares. */
    work: string
  }
  /** Role, standards and trait guidance, with the workspace's prompt override already applied. */
  systemPrompt: string
  userPrompt: string
  /** `.cat-context/` bodies: the foundational catalog, linked docs, a kind's preOp output. */
  contextFiles: InjectedContextFile[]
  /**
   * Which service the work belongs to, as the DISCRIMINATED result the engine derives, never
   * omitted. A bare task title names no software, so an absent answer reads to a model like a task
   * whose product is obvious, and it supplies one.
   */
  ownService: OwnServiceContext
}

/** What an executor persists about one started unit of work, and re-addresses it by. */
export interface DelegationHandle {
  /** The executor this handle belongs to, so a poll routes back to the same registration. */
  executor: string
  /** The job id the brief carried; an executor that lost its own id re-correlates by it. */
  correlationKey: string
  /** The external system's own id for the started work. */
  externalId?: string
  /** Where a human goes to watch it (the Actions run, the job page). */
  url?: string
  /**
   * The branch pair this dispatch was given, carried onto every later call.
   *
   * On the HANDLE because a poll genuinely cannot derive it and routinely needs it: the work branch
   * is `cat-factory/<blockId>` and a handle carries the RUN, so an executor reading what its
   * workflow produced (the pull request whose head is that branch) would otherwise have to guess.
   * Guessing is exactly the failure this seam cannot afford: the wrong branch means the wrong pull
   * request recorded on the block, a `ci` gate polling somebody else's checks and a merger
   * considering somebody else's diff.
   *
   * Absent only on a handle rebuilt from a record written before the branches were persisted.
   */
  branches?: { base: string; work: string }
  workspaceId: string
  runId: string
  agentKind: string
}

/** What {@link DelegatedExecutor.start} answers. */
export interface DelegationStart {
  /**
   * The external system's id for the work just started. REQUIRED: an executor that cannot name
   * what it started cannot be polled, and the platform refuses to record a dispatch it could never
   * settle. Recovering one from a system that returns none is the executor's job, and
   * {@link DelegationBrief.correlationKey} is what makes it possible.
   */
  externalId: string
  /** A human-reachable page for the run. Absent ⇒ the step shows no external link. */
  url?: string
  /** One line for the delegation record, e.g. how the id was recovered. Never a credential. */
  note?: string
}

/** What one unit of delegated work produced. */
export interface DelegationResult {
  /** The executor's own summary, recorded verbatim as the step's output. */
  summary: string
  /** A pull request the executor opened; the engine records it on the block, as for any agent. */
  pullRequest?: PullRequestRef
  /** The branch the work landed on, when the executor pushed without opening a PR. */
  branch?: string
  /** The generic structured channel, exactly as a registered container kind's `result.custom`. */
  custom?: unknown
  /**
   * Token usage, ONLY when the executor actually knows it. Absent is the honest answer for a
   * system that does not report it, and the platform renders it as "not reported by <executor>"
   * rather than as a zero. See {@link DelegatedExecutorDefinition.telemetry}.
   */
  usage?: AgentTokenUsage
}

/** What {@link DelegatedExecutor.poll} answers. */
export type DelegationUpdate =
  | {
      state: 'running'
      /** A url that only became known after start (an Actions run id resolved on the first poll). */
      url?: string
      /** A coarse phase for the board, in the executor's own vocabulary. */
      phase?: string
      /**
       * Epoch ms of the executor's last sign of life, folded onto the step's throttled
       * `lastActivityAt` so a long, quiet external run is not swept as orphaned.
       */
      lastActivityAt?: number
    }
  | { state: 'done'; result: DelegationResult }
  | {
      state: 'failed'
      /** One line, shown to a human as the run's failure. */
      error: string
      url?: string
      /** An extended diagnostic; recorded as the failure detail. */
      detail?: string
      /**
       * Whether re-driving the step could plausibly succeed (a runner outage, a rate limit).
       * Absent ⇒ terminal: the run fails rather than spending the job-failure budget on a verdict
       * the executor already called final.
       */
      retryable?: boolean
    }

/**
 * One deployment-owned executor: how to start, observe and cancel one unit of work in an external
 * system. Built ONCE per app from {@link DelegatedExecutorDefinition.create}.
 *
 * `start` MUST be idempotent per {@link DelegationBrief.correlationKey}. Both durable drivers
 * replay, and an executor that starts a second workflow on a replayed dispatch produces two pull
 * requests for one task. The engine takes its half of that bargain too: it commits a `starting`
 * delegation record BEFORE calling `start`, and a replay that finds one polls by correlation
 * instead of dispatching again.
 */
export interface DelegatedExecutor {
  start(brief: DelegationBrief, credentials: Record<string, string>): Promise<DelegationStart>
  poll(handle: DelegationHandle, credentials: Record<string, string>): Promise<DelegationUpdate>
  /**
   * Stop the external work. Optional, and its ABSENCE is recorded rather than assumed away: a
   * cancelled run whose executor cannot cancel leaves the external job alive, and the delegation
   * record says so instead of reading as a clean teardown.
   */
  cancel?(handle: DelegationHandle, credentials: Record<string, string>): Promise<void>
}

/**
 * The HTTP seam an executor reaches its system through, declared STRUCTURALLY rather than as
 * `typeof fetch`.
 *
 * Kernel compiles against `lib: ES2022` alone, with neither DOM nor a runtime's own globals, which
 * is what keeps it honestly runtime-neutral. A real `fetch` (Node's, workerd's, a test double)
 * satisfies this by construction; nothing here needs more of a response than the four members
 * every one of them has.
 */
export type DelegatedFetch = (
  url: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: unknown
  },
) => Promise<DelegatedFetchResponse>

/** The response shape {@link DelegatedFetch} answers with: the subset every runtime's `Response` has. */
export interface DelegatedFetchResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
  json(): Promise<unknown>
}

/** Checkout-free repo access for one run, for an executor that stages its own context layer. */
export type DelegatedRepoFilesResolver = (input: {
  workspaceId: string
  blockId: string
}) => Promise<RepoFiles | null>

/** The small, bound dependency set an executor factory is handed. */
export interface DelegatedExecutorDeps {
  logger: Logger
  clock: Clock
  /** The runtime's fetch, so an executor never reaches for a global workerd shapes differently. */
  fetchImpl: DelegatedFetch
  /**
   * The deployment's outbound-URL policy, the same one the notification webhook sender is held to.
   * An executor is an outbound HTTP surface the deployment configured, so it answers to the same
   * SSRF rules rather than to a second set nobody maintains.
   */
  urlSafetyPolicy?: UrlSafetyPolicy
  /**
   * Checkout-free repo access for a run, for an executor that wants to commit its own context
   * layer onto the work branch before starting. Absent when the facade wired no VCS client.
   */
  repoFiles?: DelegatedRepoFilesResolver
}

/**
 * Whether an executor files its own LLM telemetry, declared rather than inferred.
 *
 * A delegated step bypasses the LLM proxy, the harness call recorder and the tool-trajectory
 * drain, so by default it has no spend, no calls and no trajectory. The two values are two
 * different facts and the platform renders them differently: `not-reported` puts "usage not
 * reported by <executor>" on the step and counts it in the run rollup's
 * `delegatedStepsWithoutUsage`, so a run total is never read as the whole cost.
 *
 * `self-reported` says the executor fills {@link DelegationResult.usage} on completion, which the
 * engine meters exactly as it meters a harness result's usage: the spend ledger, the budget gate
 * and the run totals all see it, and the surfaces stop saying the data is missing. It is a claim
 * about the EXECUTOR, so declaring it and then reporting nothing leaves the step reading as free,
 * which is why the run-level gap is computed from what actually LANDED on each step rather than
 * from this declaration (`llmReportingGaps`).
 *
 * Per-CALL telemetry (individual prompts, tool trajectories) has no channel yet: it needs an
 * authenticated ingest route, and there is no executor to call one. See the initiative tracker's
 * open slice.
 */
export type DelegatedExecutorTelemetry = 'not-reported' | 'self-reported'

/** How a delegated step is polled: per executor, never the harness's job defaults. */
export interface DelegatedPollPolicy {
  /**
   * Milliseconds between polls. An Actions run polled on the harness's 15s cadence spends hundreds
   * of polls saying "queued"; a build system with a webhook-fast turnaround wants the opposite.
   * Neither is a platform default.
   */
  intervalMs: number
  /**
   * The longest this executor's work may run before the step is failed as un-settled. An hour of
   * an external run is ordinary where an hour of a harness job is a stall, which is exactly why
   * this is per-executor: the driver derives its poll budget from the pair.
   */
  maxDurationMs: number
}

/** How a registered executor presents itself in the palette and on a step. */
export interface DelegatedExecutorPresentation {
  label: string
  /** An icon id the SPA resolves, the same vocabulary an agent kind's presentation uses. */
  icon: string
  description: string
}

/** An external executor a DEPLOYMENT defines in code. */
export interface DelegatedExecutorDefinition {
  /**
   * Stable, NAMESPACED id (`acme:executor`). It is persisted on every delegated step's record and
   * named by every kind that runs on it, so it is constrained rather than normalised.
   */
  id: string
  presentation: DelegatedExecutorPresentation
  /**
   * Credential key NAMES this executor needs. Resolved through the `ToolSecretResolver` port under
   * a `delegated-executor` subject, once per dispatch AND once per poll, and handed to the call.
   * The values never touch the brief, the handle, the step or the agent-context snapshot.
   */
  credentials?: CapabilityCredential[]
  poll: DelegatedPollPolicy
  telemetry: DelegatedExecutorTelemetry
  /** Build the executor once, over the bound deps the composition root supplies. */
  create(deps: DelegatedExecutorDeps): DelegatedExecutor
}

/**
 * A registration this platform refuses outright. Thrown at REGISTRATION rather than collected, for
 * the reason `BinaryStoreRegistrationError` is: the deployment is holding the registry when it
 * happens, and the alternative is an agent kind naming an executor that can never be built.
 */
export class DelegatedExecutorRegistrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DelegatedExecutorRegistrationError'
  }
}
