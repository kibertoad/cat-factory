import type { CloudProvider, InstanceSize, StepSubtasks } from '../domain/types.js'
import type { LlmToolSpan } from './llm-trace-sink.js'

// Port for "where a repo-operating coding job actually runs". The
// ContainerAgentExecutor dispatches each job and polls it through this transport
// rather than talking to a concrete backend, so the same executor drives either:
//   - CloudflareContainerTransport — a per-run Cloudflare Container (the default)
//   - RunnerPoolTransport          — an org's self-hosted runner pool (BYO infra)
//
// A job is addressed by a {@link RunnerJobRef} that names TWO distinct things:
//   - `runId`  — the run (execution) the job belongs to. On backends that share one
//                container across a run (Cloudflare, local Docker) this addresses
//                that per-run container, and `release(runId)` reclaims it.
//   - `jobId`  — the job itself, UNIQUE WITHIN THE RUN. A run executes a SEQUENCE of
//                jobs (one per pipeline step: spec-writer, architect, coder, …), all
//                in the one per-run container, so each needs its own id — the harness
//                keys its per-kind job registries by it. Conflating the two (keying a
//                job by the bare run id) makes sibling steps collide: a poll for one
//                step reads back another step's finished result (the bug where an
//                `architect` /explore poll returned the `spec-writer`'s /spec doc,
//                since both were keyed by the execution id).
//
// Splitting them keeps the run-scoped container reclaim intact while giving every
// step its own job identity. A single-job flow (a repo bootstrap, a repo scan) simply
// uses the same value for both — its run IS its one job.

/** Live subtask counts a running job reports (from the coding tool's todo list). */
export type RunnerJobProgress = StepSubtasks

/**
 * One forward-looking item the Coder streamed (a loose end / side-task / question), as the
 * harness reports it on a poll (drain-on-read). Structurally the harness's `FollowUpLine` /
 * the contracts' `StreamedFollowUp`; kept as a local shape so this port stays schema-free.
 */
export interface RunnerJobFollowUp {
  kind: 'follow_up' | 'question'
  title: string
  detail?: string
  suggestedAction?: string
}

/** The structured work product a finished job records. */
export interface RunnerJobResult {
  prUrl?: string
  branch?: string
  summary?: string
  error?: string
  /** A repo-bootstrap job's pushed default branch (the bootstrap coding flow's product). */
  defaultBranch?: string
  /** A coding job's outcome: whether it pushed a change (the in-place fixers / conflict-resolver). */
  pushed?: boolean
  /**
   * A generic `agent` (explore, structured-output) job's parsed JSON result. The
   * backend's post-op / `toRunResult` coerces, validates + renders artifact files from
   * it — this is the single channel every structured agent (built-in or custom) uses
   * (the migrated blueprints/spec-writer/merger/on-call/tester all return their JSON here,
   * coerced into the well-known engine field kind-aware in the executor's `toRunResult`).
   */
  custom?: unknown
  /**
   * A tester job's docker-compose dependency stand-up record (explore mode, local infra),
   * forwarded verbatim from the harness. The stand-up happens INSIDE the container, so its
   * output never reaches the orchestrator-side provisioning-log store; this carries the
   * captured (redacted, bounded) logs back so the Tester step can surface WHY the
   * dependencies failed to come up. Absent for ephemeral / no-infra runs (and any non-tester
   * kind). See {@link RunnerInfraSetup}.
   */
  infraSetup?: RunnerInfraSetup
  /**
   * Token usage the harness lifted from the agent CLI's own event stream. Reported
   * by the subscription harnesses (Claude Code / Codex), whose traffic bypasses the
   * LLM proxy — so this is the only usage signal for them. The dispatch path folds
   * it into the leased subscription token's rolling-window counters (usage-aware
   * rotation) and the telemetry sink. Absent for the proxy-metered Pi harness.
   */
  usage?: { inputTokens: number; outputTokens: number }
}

/**
 * A tester run's in-container docker-compose stand-up record (see
 * {@link RunnerJobResult.infraSetup}). Mirrors the harness's `InfraSetupRecord`; the engine
 * persists it on the Tester step (the contracts `testerInfraSetupSchema`) for the test window.
 */
export interface RunnerInfraSetup {
  /** Whether `docker compose up --wait` succeeded (the dependencies are up). */
  started: boolean
  /** The repo-relative compose file that was stood up. */
  composePath?: string
  /** Epoch ms the stand-up attempt finished. */
  at: number
  /** Wall-clock of the stand-up attempt, ms. */
  durationMs?: number
  /** Captured (redacted, tail-bounded) stdout+stderr of the stand-up command. */
  logs?: string
  /** The verbatim (redacted) failure message when stand-up failed, else absent. */
  error?: string
}

/**
 * Which harness agent a dispatch targets. The strangler is complete: every built-in
 * agent (coder, blueprints, spec-writer, the read-only design agents, the fixers, merger,
 * on-call, tester, conflict-resolver, bootstrap) is now expressed as the SINGLE,
 * manifest-driven `agent` kind — the job body's `mode` (explore | coding) and its data
 * select the flow. `kind` travels in the job body to the harness's single `POST /jobs`
 * endpoint. The Cloudflare backend and a self-hosted runner pool both serve it from the
 * same executor-harness image, so runtime parity is automatic. Kept as a (now single-member)
 * type so the transport seam stays explicit and a future second kind has a home.
 */
export type RunnerDispatchKind = 'agent'

/**
 * Optional, transport-level provisioning hints resolved per-service at dispatch.
 * A self-hosted pool forwards `instanceTypeId` (and `provider`) so it can provision
 * the right size on its own cloud; the local Docker backend maps `instanceSize` to
 * container resource limits. The Cloudflare backend ignores these — its Container
 * instance type is fixed per class by `wrangler.toml` (no per-dispatch sizing).
 */
export interface RunnerDispatchOptions {
  /** Concrete instance-type id for the target (see `resolveInstanceTypeId`). */
  instanceTypeId?: string
  /** The cloud provider the service selected, for a self-provisioning pool. */
  provider?: CloudProvider
  /**
   * The abstract t-shirt size the service selected, forwarded verbatim so a
   * resource-sizing transport (the local Docker/Podman backend) can map it to
   * concrete `--memory` / `--cpus` limits without reverse-engineering a cloud
   * instance-type id.
   */
  instanceSize?: InstanceSize
  /**
   * Which executor image variant this job needs. `default` is the standard harness
   * image; `ui` is the heavier UI-tester image that bundles Playwright + a browser
   * (the `tester-ui` kind needs it, and only it — every other kind uses `default`, so
   * the browser never bloats their cold-start). A transport maps this to a distinct
   * container class (Cloudflare) or image tag (a self-hosted pool / local Docker).
   */
  image?: 'default' | 'ui'
}

/**
 * Where a run's container is reachable + how to identify it, surfaced by the transport
 * (NOT the harness — the harness doesn't know its own external address). Both fields are
 * best-effort and transport-specific: the Cloudflare per-run Container reports an `id` (the
 * Durable Object id) but no public `url`; the local Docker transport reports both the
 * container id and the published host URL; a self-hosted pool reports neither (the runner
 * lives inside the workspace's own trust domain). The engine surfaces these in a run's
 * details once the container is up.
 */
export interface RunnerJobContainer {
  /** Provider container/runner identifier (Cloudflare DO id, docker container id). */
  id?: string
  /** A reachable address for the running container (the local docker host URL), when one exists. */
  url?: string
}

/** A job's current state, as the harness/pool reports it. */
export interface RunnerJobView {
  state: 'running' | 'done' | 'failed'
  /**
   * The coarse lifecycle phase the job is CURRENTLY in (`starting` → `clone` → `agent`
   * → `push`), forwarded verbatim from the harness so the engine can show WHAT the
   * container is doing — still preparing the checkout, or has the agent begun making
   * calls — instead of a blank "working" state. Absent on an older harness image (or a
   * pool/transport that doesn't forward it). Free-form; unknown phases show verbatim.
   */
  phase?: string
  /**
   * The container's identity/address once it is up, attached by the TRANSPORT (the
   * harness can't know its own external address). Best-effort + transport-specific; see
   * {@link RunnerJobContainer}. Absent when the transport has nothing to surface.
   */
  container?: RunnerJobContainer
  /** Present while running once the agent has touched its todo list. */
  progress?: RunnerJobProgress
  result?: RunnerJobResult
  error?: string
  /**
   * Present on a failed view: the harness's STRUCTURED failure cause (e.g.
   * `inactivity-timeout`, `max-duration`, `no-usable-output`, `agent`), so the engine can
   * classify the failure without regex-matching {@link error}. Absent on an older harness
   * image — the consumer falls back to the (still-stable) error-string regex. Container
   * EVICTION is NOT represented here: that is detected by the runtime facade from a vanished
   * container (a `(container evicted or crashed)` error), never emitted by the harness.
   */
  failureCause?: string
  /**
   * Present on a failed view: an extended, redacted diagnostic (phase-timing breakdown,
   * last-tool breadcrumb) distinct from the one-line {@link error}. The engine surfaces it
   * as the failure `detail` on the board. Best-effort.
   */
  detail?: string
  /**
   * Tool spans the harness buffered SINCE THE LAST POLL (drain-on-read): the executor
   * forwards them to the optional trace sink as child spans under the run trace. Empty/
   * absent on most polls. Best-effort observability — never affects the job lifecycle.
   */
  spans?: LlmToolSpan[]
  /**
   * Forward-looking follow-up / question items the Coder streamed SINCE THE LAST POLL
   * (drain-on-read). The executor forwards them to the engine, which appends them to the
   * run's step (the Follow-up companion). Absent on most polls / non-coder jobs.
   */
  followUps?: RunnerJobFollowUp[]
}

/**
 * Addresses one runner job: the run (execution) it belongs to plus the job's own id.
 * See the file header for why the two are distinct — `runId` scopes the per-run
 * container, `jobId` identifies the step's job uniquely within that run.
 */
export interface RunnerJobRef {
  /** The run (execution) the job belongs to; addresses the per-run container. */
  runId: string
  /** The job's own id, unique within the run (one per pipeline step). */
  jobId: string
}

export interface RunnerTransport {
  /**
   * Start the job `ref.jobId` (in run `ref.runId`) with the harness job `spec`, or
   * re-attach to one already running for that ref. Must be idempotent per ref so a
   * replayed dispatch never starts a duplicate. `kind` is the single manifest-driven
   * `agent` kind (carried in the job body; the body's `mode` + data select the flow);
   * the job is polled via {@link poll}.
   */
  dispatch(
    ref: RunnerJobRef,
    spec: Record<string, unknown>,
    kind?: RunnerDispatchKind,
    options?: RunnerDispatchOptions,
  ): Promise<void>
  /** Poll the job's current state. */
  poll(ref: RunnerJobRef): Promise<RunnerJobView>
  /**
   * Optionally reclaim a run's runner resources: the per-run container on backends
   * that share one across the run (Cloudflare, local Docker), and any of the run's
   * still-running jobs on a per-job backend (a self-hosted pool cancels `ref.jobId`).
   * Best-effort and idempotent — releasing an already-gone run/job is a no-op.
   */
  release?(ref: RunnerJobRef): Promise<void>
}
