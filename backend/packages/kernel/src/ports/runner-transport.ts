import type { CloudProvider, InstanceSize, StepSubtasks } from '../domain/types.js'
import type { HarnessFailureCause } from '../domain/harness-failure.js'
import type { LlmToolSpan } from './llm-trace-sink.js'
import type { AgentEffortReport, PlatformImageVariant } from '@cat-factory/contracts'
import {
  isImageVariantName,
  isPlatformImageVariant,
  PLATFORM_IMAGE_VARIANTS,
} from '@cat-factory/contracts'
import { UnavailableError, ValidationError } from '../domain/errors.js'

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
 * How a transport classifies a container eviction on a failed {@link RunnerJobView}: a
 * `crash` (OOM / a genuine crash / a vanished per-run container) recovers on the small
 * crash-eviction budget, while a `transient` one — infrastructure churn a facade flags as
 * expected (a Cloudflare new-version rollout, a node drain) — recovers on the larger transient
 * budget (see orchestration's `MAX_EVICTION_RECOVERIES` / `MAX_TRANSIENT_EVICTION_RECOVERIES`).
 * This is the STRUCTURED
 * successor to matching the `(container evicted or crashed)` sentinel + the transient marker in
 * the error string: consumers read {@link RunnerJobView.evicted} and only fall back to the
 * regexes for an older producer that reports no field. The mapping from a runtime's own signal
 * to `crash`/`transient` stays the facade's call — the engine knows only these two.
 */
export type ContainerEvictionKind = 'crash' | 'transient'

/**
 * The one-line `error` a transport reports beside `evicted` when the job's container/runner is
 * simply GONE — the poll found no such job. Owned here rather than copied per transport because
 * it is a CONTRACT, not a message: orchestration's dispatch-time `isContainerEvictionError`
 * matches the `evicted or crashed` substring to route a view-less throw to a fresh-container
 * retry, so a transport that drifts from this wording silently loses that recovery. A transport
 * with something more specific to say prefixes it (`Runner pool poll → 404: …`) rather than
 * replacing it.
 */
export const CONTAINER_EVICTION_ERROR = 'Job not found (container evicted or crashed)'

/**
 * The one-line `error` a transport reports beside {@link RunnerJobView.harnessShutdown}: the
 * harness that was running this job did not crash or vanish, it EXITED CLEANLY while the job was
 * still in flight, which means something asked it to stop.
 *
 * Deliberately worded without the eviction sentinel, because the two need opposite handling and
 * the dispatch-time `isContainerEvictionError` matches that substring: an eviction is worth one
 * fresh container, whereas a shutdown mid-job is caused by whatever shut it down and a retry
 * walks back into it. The incident that named this: an agent scaffolding a Node service ran
 * `pkill -f 'node dist/server.js'` to stop the service it had just smoke-tested and matched the
 * harness's own PID 1, so the engine spent its whole eviction budget re-running an agent that
 * killed its container each time and reported infrastructure churn.
 */
export const HARNESS_SHUTDOWN_ERROR =
  'The executor-harness shut down while this job was still running'

/**
 * One forward-looking item the Coder streamed (a loose end / side-task / question), as the
 * harness reports it on a poll (drain-on-read). Structurally the harness's `FollowUpLine` /
 * the contracts' `StreamedFollowUp`; kept as a local shape so this port stays schema-free.
 */
interface RunnerJobFollowUp {
  kind: 'follow_up' | 'question'
  title: string
  detail?: string
  suggestedAction?: string
}

/**
 * One model call a subscription harness (Claude Code / Codex) lifted from its CLI
 * event stream, shaped so the backend can record it into the same `llm_call_metrics`
 * telemetry the LLM proxy writes for the Pi harness. These harnesses talk direct to
 * the vendor and bypass the proxy, so this is the only place their per-call bodies are
 * observable. `promptText` is an OpenAI-style chat array (`[{role, content}, …]`)
 * serialised as JSON, matching the proxy's shape; `responseText`/`reasoningText` are
 * plain strings. Claude Code carries full request/response bodies; Codex is thinner
 * (flat assistant text + per-turn tokens, no request transcript). See the harness's
 * `HarnessCallMetric` (the JSON producer this mirrors).
 */
export interface HarnessCallMetric {
  model?: string
  promptText: string
  messageCount: number
  responseText: string
  reasoningText: string
  /** FRESH (uncached) input tokens — exclusive of both cache classes below. */
  inputTokens: number
  /** Input tokens served from the vendor's prompt cache. */
  cacheReadTokens: number
  /** Input tokens written into the vendor's cache (0 where the CLI reports no write class). */
  cacheWriteTokens: number
  outputTokens: number
  finishReason: string | null
  /**
   * The call's position in the JOB's telemetry sequence, stamped by the harness. A call reaches
   * the backend twice — live on a poll ({@link RunnerJobView.callMetrics}) and again in the
   * terminal {@link RunnerJobResult.callMetrics} — and this is what makes both mint the SAME
   * row id, so the second write is a no-op rather than a duplicate row. Absent on an older
   * harness image (which streams nothing), where the recorder falls back to the array index.
   */
  seq?: number
  /**
   * The run phase that spent this call (`agent` / `validation-repair` / `reproduction-repair` /
   * …), stamped by the job registry from the marker the handlers set as they ENTER each phase —
   * the point of truth, since the harness is what drives the repair loops. Rides the SAME object
   * as {@link seq}, so the live drain and the terminal list can never disagree about it.
   *
   * Absent on an older harness image; the recorder then stores the unattributed `''` phase.
   */
  phase?: string
  /**
   * This row is not a TURN: it stands for the JOB, carrying spend the CLI reported in its terminal
   * cumulative total and attributed to no turn it narrated. It has no bodies, since there was no
   * request to capture, and it is recorded with a NULL `turnIndex` for the same reason — a
   * fabricated turn among measured ones is indistinguishable from a measured one, which is the
   * whole point of keeping it apart. Its row id still derives from {@link seq}, so a replayed poll
   * re-records rather than duplicating. Absent on every real turn.
   */
  standsForJob?: boolean
  /**
   * This row carries only TOKENS and stands for no model call of its own — the fact
   * {@link LlmCallMetric.spendOnly} persists, decided by the producer that built the row.
   *
   * Distinct from {@link standsForJob}, which is only about the TURN ordinal, and the two answers
   * genuinely differ: the shortfall row never occupies a turn, but it IS the job's call record
   * when the CLI narrated no turns at all — nothing else recorded that call, so a `calls` figure
   * excluding it would report a step that spent tokens on zero calls. Only the producer can tell
   * the two apart, because a downstream reader sees one BATCH of a job's calls (the live drain
   * splits them across polls) and cannot ask whether any turn was narrated.
   *
   * Absent on every real turn, where it is false either way.
   */
  spendOnly?: boolean
}

/** The structured work product a finished job records. */
export interface RunnerJobResult {
  prUrl?: string
  branch?: string
  /**
   * PRs a multi-repo coding job opened in CONNECTED services' repos (service-connections
   * phase 3): one per involved-service repo it actually changed, beside the own-service
   * `prUrl`/`branch`. The executor's `toRunResult` lifts these onto `AgentRunResult`. Absent
   * for a single-repo run.
   *
   * `frameIds` echoes back the involved frames the DISPATCH attributed to that checkout: the
   * fan-out clones one checkout per repo, so a monorepo hosting several of the run's involved
   * services yields ONE pull request carrying all of their frames.
   */
  peerPullRequests?: { repo: string; frameIds?: string[]; prUrl: string; branch: string }[]
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
   * A `ralph` iteration's validation verdict: whether the configured completion command
   * exited 0, its exit code, and a bounded output tail. Computed by the harness (it runs
   * the command after the coding agent commits), so the loop's exit condition is a real
   * programmatic check rather than a model self-report. The executor's `toRunResult`
   * forwards it onto {@link AgentRunResult.ralphVerdict}. Absent for non-`ralph` kinds.
   */
  ralphVerdict?: {
    validationPassed: boolean
    exitCode: number
    validationOutputTail?: string
    iteration?: number
    /**
     * The work-branch HEAD the completion command was judged against. The engine compares it
     * across consecutive failing iterations to end a loop that has stopped committing anything.
     * Absent for an older harness image, which the engine's check treats as "unknown", never as
     * "unchanged".
     */
    headSha?: string
  }
  /**
   * A coding job's PRE-PR validation report: the outcome of running the service's configured
   * check commands against the checkout after the agent settled and BEFORE opening a PR, plus
   * how many repair rounds the harness spent. Computed by the harness (it runs the commands and
   * reads the exit codes), so the gate is a real programmatic check rather than a model
   * self-report. A failed report means NO PR was opened and the job failed. The executor's
   * `toRunResult` forwards it onto {@link AgentRunResult.validationReport}. Absent when the
   * service configured no checks. See `docs/initiatives/pre-pr-validation.md`.
   */
  validationReport?: RunnerValidationReport
  /**
   * A coding job's BUGFIX REPRODUCTION PROOF: the declared reproduction command run against the
   * pre-fix tree and the final tree, with both exit codes and captured output — or the agent's
   * structural declaration that reproduction was infeasible. Computed by the harness from exit
   * codes, so it is real evidence rather than the model's own claim about its test. Unlike a
   * failed validation report this never fails the job (see the initiative's D6): the fix may
   * well be correct, and how much the weak evidence matters is a reviewer's call. The executor's
   * `toRunResult` forwards it onto {@link AgentRunResult.reproductionReport}. Absent when the
   * run carried no declaration. See `backend/docs/adr/0033-bugfix-reproduction-proof.md`.
   */
  reproductionReport?: RunnerReproductionReport
  /**
   * Token usage the harness lifted from the agent CLI's own event stream. Reported
   * by the subscription harnesses (Claude Code / Codex), whose traffic bypasses the
   * LLM proxy — so this is the only usage signal for them. The dispatch path folds
   * it into the leased subscription token's rolling-window counters (usage-aware
   * rotation) and the telemetry sink. Absent for the proxy-metered Pi harness.
   */
  usage?: { inputTokens: number; outputTokens: number }
  /**
   * Per-model-call telemetry the harness lifted from the agent CLI's event stream
   * (Claude Code / Codex), recorded by the backend into `llm_call_metrics` — the
   * proxy-bypassing analogue of the per-call rows the LLM proxy writes for Pi. Absent
   * for the proxy-metered Pi harness. See {@link HarnessCallMetric}.
   */
  callMetrics?: HarnessCallMetric[]
  /**
   * The container agent's self-assessment of the work — how hard/easy it was, what reduced its
   * effectiveness, the key obstacles — lifted by the harness from the agent's sentinel-file
   * report (`.cat-effort.json`). The executor's `toRunResult` forwards it onto
   * {@link AgentRunResult.effortReport}; the engine records it on the step for run details.
   * Absent when the agent wrote no report (or on an older harness image).
   */
  effortReport?: AgentEffortReport
}

/**
 * A tester run's in-container docker-compose stand-up record (see
 * {@link RunnerJobResult.infraSetup}). Mirrors the harness's `InfraSetupRecord`; the engine
 * persists it on the Tester step (the contracts `testerInfraSetupSchema`) for the test window.
 */
interface RunnerInfraSetup {
  /** Whether `docker compose up --wait` succeeded (the dependencies are up). */
  started: boolean
  /**
   * Whether the executor container had a Docker daemon at all, when it knows. Absent on an image
   * that predates the probe — never read as `false`, which would report a stack that failed to
   * come up as an executor with no daemon.
   */
  dockerAvailable?: boolean
  /**
   * What a real container DID on that daemon, when the harness measured it. Kept apart from
   * `dockerAvailable` because a daemon that ANSWERS is not a daemon that can run a container, and
   * reporting the second as an absence of the first sends a human to restart a daemon that is up.
   */
  dockerWorkload?: 'usable' | 'unusable' | 'undetermined'
  /**
   * What a container started ON that daemon could REACH, when the platform measured it.
   *
   * The fourth diagnosis, and the one `dockerWorkload: 'usable'` structurally cannot carry: a
   * rootless daemon started with `--iptables=false` installs no MASQUERADE rule for its bridge,
   * so it runs containers perfectly and none of them has a route out. The stack comes up and
   * every `docker build` that fetches a dependency fails, slowly. Present only alongside
   * `usable`, which is the one verdict with an egress half; absent means nothing measured it.
   */
  dockerEgress?: 'reachable' | 'blocked' | 'undetermined'
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
 * same executor-harness image, so runtime parity is automatic. Kept as a multi-member type
 * so the transport seam stays explicit. `deploy` is the second kind: it targets the
 * container-backed deploy adapter (real `kubectl`/`kustomize`/`helm`) on a SEPARATE image
 * (`image: 'deploy'`), used to render + apply a service's Kubernetes manifests.
 */
export type RunnerDispatchKind = 'agent' | 'deploy'

/**
 * Which executor image a job runs on, by NAME.
 *
 * Three names are the PLATFORM's, because it publishes those images ({@link
 * PLATFORM_IMAGE_VARIANTS}): `default` is the standard harness image; `ui` is the heavier
 * UI-tester image that bundles Playwright + a browser (the `tester-ui` kind needs it, and only
 * it, so the browser never bloats every other kind's cold-start); `deploy` is the separate
 * deploy-harness image (slim base + `kubectl`/`kustomize`/`helm`).
 *
 * Anything else is a DEPLOYMENT's own variant: a slug one of its agent kinds declares
 * (`AgentStepSpec.image`) and its runner backend maps to an image. That is the whole reason the
 * type is open rather than a union of the three. The split exists because different kinds need
 * different images, and a deployment whose own agent needs a tool the harness image has no
 * reason to carry had two options: install it inside every run, or put it in every kind's cold
 * start. The platform cannot enumerate those names, and it does not have to: what it owns is the
 * ROUTING (a variant is part of the container's identity, {@link containerKeyForRef}) and the
 * REFUSAL below.
 *
 * A backend that cannot serve a declared variant REFUSES the dispatch rather than running the
 * job on its default image. The two are not interchangeable in the direction that matters: a
 * browser-driven tester on the plain image has no browser, and it discovers that only after a
 * checkout, an install and a model's first turns have been paid for, then reports an `abort`
 * indistinguishable from an app that would not boot. A deployment's own variant is worse still,
 * because nothing in the platform knows what it carried, so the job would report a missing
 * artifact with no cause anywhere. Naming the missing wiring at dispatch costs nothing and says
 * which knob to set.
 */
export type RunnerImageVariant = string

// The reserved-name half of the vocabulary lives on the WIRE (`@cat-factory/contracts`), because
// a runner backend's variant map is edited in the SPA and an agent kind's declaration is written
// by a deployment: both must be held to one list of names the platform has already claimed.
export { PLATFORM_IMAGE_VARIANTS, isPlatformImageVariant, isImageVariantName }
export type { PlatformImageVariant }

/**
 * The `default:` arm of a backend's exhaustive switch over {@link PlatformImageVariant}: it takes
 * `never`, so publishing a fourth platform image fails the BUILD in every backend until each
 * decides what to do with it, and it still refuses honestly at RUN time for the case the type
 * cannot see, a value an older job body or a stored step still carries after this build retired it.
 *
 * The compile-time half is the load-bearing one, because the alternative is silent in the worst
 * direction: a backend that fell through would run the job on its default image, and nothing
 * downstream can say what the variant was supposed to carry. The DEPLOYMENT-owned half of the
 * vocabulary is open and gets {@link deploymentImageVariantMessage} instead; this arm is only ever
 * reached by a name the platform itself claimed.
 */
export function unservablePlatformImageVariant(variant: never): never {
  throw new UnavailableError(
    `This step declared the '${String(variant)}' executor image, which this backend does not ` +
      'serve. It is a platform image this build does not know: re-pick the executor image on the ' +
      "agent kind's registration.",
    RUNNER_IMAGE_UNWIRED_REASON,
    { image: String(variant) },
  )
}

/**
 * The refusal a DEPLOYMENT-named image variant earns when the resolved runner backend maps it to
 * nothing, with the per-backend knob named by the caller.
 *
 * One message, in kernel, because three backends refuse it and an operator reading three
 * wordings for one misconfiguration learns three things instead of one. The platform's own
 * variants keep their bespoke messages: the platform knows what `ui` is FOR, so it can say what
 * a deployment loses by leaving it unwired and what to do instead, and this one cannot say
 * anything about a variant it has never heard of beyond where the mapping goes.
 */
export function deploymentImageVariantMessage(variant: string, setting: string): string {
  return (
    `This step's agent kind declares the "${variant}" executor image, which this deployment's ` +
    `runner backend maps to no image. Add "${variant}" to ${setting}, or drop the kind's ` +
    `\`image\` declaration if the default harness image is enough: running the default instead ` +
    `would produce a job without whatever "${variant}" carries, and a step reporting a missing ` +
    `result with nothing naming the cause.`
  )
}

/** The `details.reason` every unwired-image refusal carries, whoever raises it. */
export const RUNNER_IMAGE_UNWIRED_REASON = 'runner_image_unwired'

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
   * Which executor image variant this job needs ({@link RunnerImageVariant}). A transport
   * maps it to a distinct container class (Cloudflare) or image tag (a self-hosted pool,
   * local Docker), and refuses when it has none wired for the variant.
   *
   * The dispatch site sets it from the agent kind's DECLARED image, and the same value rides
   * {@link RunnerJobRef.image} so the poll/release site addresses the container it started.
   */
  image?: RunnerImageVariant
  /**
   * Every ephemeral environment this job is being handed: the frame's own provisioned
   * environment, a live peer service's environment for a cross-service test, and a frontend
   * flow's resolved backend bindings. Empty/absent for a job handed none.
   *
   * Declared HERE rather than read back out of the job body, and that is the load-bearing part.
   * The body is a `Record<string, unknown>` whose environment URLs sit at three different depths
   * under a wire shape the harness owns, so a transport reaching into it is one silent typo or one
   * renamed field away from bridging nothing at all and saying nothing about it. That is not
   * hypothetical: the first cut of the local host bridge read `spec.environmentUrl`, which the
   * engine has never emitted (it emits `body.infra.environmentUrl`), so the bridge could not fire
   * in production while its tests passed against a hand-written spec.
   *
   * Only the container transports act on it, because what it feeds is a hosts entry inside the
   * container (`--add-host`, or a pod's `hostAliases`); every other transport ignores it.
   */
  environments?: readonly DispatchEnvironment[]
}

/**
 * One environment a dispatch hands a job: where it is, and (when the platform proved one) the
 * address that carries traffic for it.
 *
 * A PAIR rather than two parallel lists, and that pairing is a security property rather than an
 * ergonomic one. A bridge re-points a NAME inside the container, so the host side has to be a host
 * the job was actually handed; carrying the address beside the URL it belongs to makes that
 * structural, where a free-form `Record<host, address>` would let a provider name any host it
 * liked, including the harness's own alias for reaching back to its host.
 *
 * A URL rather than a hostname because deciding which host needs what is the reader's rule, not
 * the dispatcher's, and a URL keeps the scheme and port a diagnostic needs to quote.
 */
export interface DispatchEnvironment {
  url: string
  /**
   * The address PROVED to carry traffic for `url`'s host, when the name itself did not. Absent for
   * the ordinary case where the name resolves and for an environment nothing has probed; never a
   * provider's unverified claim (see `EnvironmentRouteProof.via`).
   */
  address?: string
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
   * Epoch ms of the harness's LAST sign of life (job start, then every stdout chunk / subagent
   * transcript tail — pure liveness, forwarded verbatim from the harness {@link JobView.heartbeatAt}).
   * Distinct from {@link progress}: a long, quiet phase (a reviewer reading files without ticking its
   * todo list) advances the heartbeat but not the subtask counts, so this is what tells a
   * genuinely-active-but-quiet job apart from a wedged one. The engine persists it as the step's
   * throttled `lastActivityAt`, keeping the run's `updated_at` fresh (so the stale-run sweeper doesn't
   * treat a live-but-quiet run as orphaned) and surfacing "active Ns ago" in the UI. Absent on an
   * older harness image (or a pool/transport that doesn't forward it).
   */
  heartbeatAt?: number
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
   * Present on a failed view: the harness's STRUCTURED failure cause (the shared
   * {@link HarnessFailureCause} union), so the engine can classify the failure via
   * `failureKindFromHarnessCause` without regex-matching {@link error}. Absent on an older
   * harness image — the consumer falls back to the (still-stable) error-string regex.
   * Container EVICTION is NOT represented here: that is detected by the runtime facade from a
   * vanished container (a `(container evicted or crashed)` error), never emitted by the
   * harness.
   */
  failureCause?: HarnessFailureCause
  /**
   * Present on a failed view minted by a TRANSPORT for a container eviction (the per-run
   * container vanished / was drained): the STRUCTURED eviction classification, so the engine
   * recovers it on the right budget without regex-matching {@link error}. `crash` for a genuine
   * crash/OOM/vanished container, `transient` for infrastructure churn the facade flags as
   * expected (a Cloudflare rollout, a node drain). Absent on a non-eviction failure and on an
   * older producer — the consumer then falls back to the (still-stable) `(container evicted or
   * crashed)` + transient-marker regexes. See {@link ContainerEvictionKind}. NOT a harness
   * signal: the harness never emits it (an eviction is the transport observing a gone container),
   * which is why it lives beside — not inside — {@link failureCause}.
   */
  evicted?: ContainerEvictionKind
  /**
   * Present on a failed view minted by a TRANSPORT that watched the harness exit CLEANLY (exit
   * code 0, no signal) while this job was still running: it was shut down, not evicted. Never set
   * beside {@link evicted}: they are the two readings of a backend that stopped answering, and
   * this one is the reading that says a retry is pointless.
   *
   * The distinction is only available where the runtime reports an exit CODE. A runtime that
   * reports a coarse status (Apple `container`) answers "unknown", which stays an eviction: an
   * absent code is not a zero, and reading it as one would report every container death there as
   * a shutdown. See {@link HARNESS_SHUTDOWN_ERROR} for what makes the two need opposite handling.
   */
  harnessShutdown?: true
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
  /**
   * Per-model-call telemetry the harness lifted from its CLI event stream SINCE THE LAST POLL
   * (drain-on-read, like {@link spans}). The executor records these into `llm_call_metrics` on
   * every poll, so a run's token spend and prompt/response bodies are queryable WHILE it runs
   * — and, more importantly, survive it dying before it can produce a terminal result. The
   * same calls ride {@link RunnerJobResult.callMetrics} at the end (each carrying a stable
   * {@link HarnessCallMetric.seq}), so the terminal write completes the record without
   * duplicating what already landed. Absent on most polls, on the proxy-metered Pi harness,
   * and on an older harness image.
   */
  callMetrics?: HarnessCallMetric[]
  /**
   * Which runner backend actually served this job — `local-native` (host process),
   * `local-container`, `runner-pool`, `cloudflare-container`. Reported so the engine can record
   * it in the run's diagnostics (a native host-process run vs. a sandboxed container is otherwise
   * indistinguishable after the fact). Stamped by {@link RunnerTransport.backend} via the shared
   * job client, or overridden by a composite router that picks a leg per job. Free-form; absent
   * on a transport that doesn't declare one.
   */
  backend?: string
  /**
   * The LATEST pre-PR validation attempt's report, republished on every poll once the harness
   * has run the configured checks at least once (see `docs/initiatives/pre-pr-validation.md`).
   * Lets the run surface "lint failed, repairing (attempt 2 of 3)" WHILE the loop is still
   * running, instead of only at the end. The same report rides
   * {@link RunnerJobResult.validationReport} terminally. A published attempt is FINAL — the
   * harness republishes a NEW attempt rather than mutating the last one. Absent for a job whose
   * service configured no checks (and on an older harness image).
   */
  validationReport?: RunnerValidationReport
  /**
   * The reproduction proof as it stands, republished on every poll once the harness has run a
   * verification pass. Lets the run surface a failed verification WHILE the repair loop is still
   * running instead of only at the end; the same report rides
   * {@link RunnerJobResult.reproductionReport} terminally. A published pass is FINAL — the
   * harness republishes rather than mutating. Absent for a job carrying no declaration (and on
   * an older harness image).
   */
  reproductionReport?: RunnerReproductionReport
  /**
   * A parallel PR review's per-slice reviews as they stand, republished whole on every poll as
   * each slice's subagent returns. Latest-wins like the two reports above, but for a stronger
   * reason: the reviewer emits its `slices`/`findings` only in the TERMINAL structured output, so
   * this is the sole channel that makes finished slices durable while the run is still going — and
   * therefore the sole thing a manual resume of a wedged review has to work from. Absent for a job
   * that dispatched no subagents (and on an older harness image).
   */
  sliceReviews?: RunnerSliceReview[]
  /**
   * What the agent's CLI reported about the tool servers (MCP) it loaded, republished whole on
   * every poll once the CLI has announced its session. Latest-wins like the reports above, and
   * republished rather than drained for a reason specific to it: the CLI announces its servers
   * ONCE, near the start of the run, so a drain would put the whole fact on one poll response and
   * lose it if that response were dropped.
   *
   * The observed complement of what the dispatch DECIDED (`AgentJobHandle.toolServers`): that
   * says why the platform withheld a tool, this says a server it wired failed to start anyway.
   * Absent for a job that wired none, for a harness whose CLI publishes no such report (codex),
   * and on an older image — which is why the engine records absence as "not observed" rather than
   * as a failure.
   */
  toolServers?: RunnerObservedToolServer[]
}

/**
 * One tool server's line in the agent CLI's startup report. Mirrors the contracts
 * `observedToolServerSchema` structurally (the kernel stays free of the contracts dependency for
 * transport shapes). See {@link RunnerJobView.toolServers}.
 */
export interface RunnerObservedToolServer {
  /** The server id the CLI named — the id the backend declared. */
  id: string
  /** The CLI's state for it, normalised by the harness onto a closed vocabulary. */
  status: 'ready' | 'failed' | 'needs_auth' | 'unknown'
  /** Tools the CLI exposed for it. ABSENT (nothing counted) and `0` (counted none) differ. */
  toolCount?: number
}

/**
 * One slice's live review off a parallel PR reviewer. Mirrors the contracts
 * `prReviewSliceReviewSchema` structurally (the kernel stays free of the contracts dependency).
 * See {@link RunnerJobView.sliceReviews}.
 */
export interface RunnerSliceReview {
  /** The slice label the reviewer dispatched its subagent with. */
  label: string
  /** Whether that subagent returned. An `in_progress` slice is one a resume must redo. */
  status: 'in_progress' | 'completed'
  /** The subagent's verbatim report; null while in flight, or when it returned no readable text. */
  report?: string | null
}

/**
 * The harness-computed reproduction proof of a bugfix coding job. Mirrors the contracts
 * `reproductionReportSchema` structurally (the kernel stays free of the contracts dependency).
 * See {@link RunnerJobResult.reproductionReport}.
 */
export interface RunnerReproductionReport {
  /**
   * `reproduced` — RED on the pre-fix tree, GREEN on the final tree (the only shape that is
   * proof); `inconclusive` — any other shape, recorded honestly; `declared_infeasible` — the
   * agent structurally declared reproduction impossible and nothing was run.
   */
  status: 'reproduced' | 'inconclusive' | 'declared_infeasible'
  /** The command run against BOTH trees (empty for `declared_infeasible`). */
  command: string
  /** The declared test file(s) constituting the reproduction. */
  testPaths: string[]
  /**
   * How many declared paths were dropped before the proof ran. Non-zero means the pre-fix tree
   * was rebuilt from an INCOMPLETE reproduction, which the report states rather than implies.
   */
  omittedTestPaths?: number
  /** The pre-fix tree's run; absent for `declared_infeasible`. */
  base?: RunnerReproductionPhase
  /** The final tree's run; absent for `declared_infeasible`. */
  final?: RunnerReproductionPhase
  /** How many agent+verify rounds ran (1 = settled on the first pass). */
  attempts: number
  maxAttempts: number
  /** For `declared_infeasible`: WHY, verbatim from the agent. */
  reason?: string
  /** For `declared_infeasible`: what the agent verified INSTEAD, verbatim. */
  alternativeVerification?: string
  /** For `inconclusive`: which shape was observed, in one line. */
  note?: string
  /** Epoch ms the report was produced. */
  at?: number
}

/** One tree's run of the reproduction command. */
export interface RunnerReproductionPhase {
  /** Exit code (0 = pass); 124 on watchdog timeout, 127 on spawn failure, 130 on abort. */
  exitCode: number
  passed: boolean
  /** Bounded, secret-scrubbed tail of the command's combined stdout+stderr. */
  outputTail?: string
  durationMs?: number
  timedOut?: boolean
  /** Set when this phase's setup command failed, so the tree never ran the check meaningfully. */
  setupFailed?: boolean
}

/**
 * The harness-computed report of a coding job's pre-PR validation loop: whether the latest
 * attempt's commands all passed, how many agent+check rounds ran, and each command's outcome.
 * Mirrors the contracts `validationReportSchema` structurally (the kernel stays free of the
 * contracts dependency). See {@link RunnerJobResult.validationReport}.
 */
export interface RunnerValidationReport {
  /** Whether every command in the latest attempt exited 0 (⇒ the PR was allowed to open). */
  passed: boolean
  /** How many agent+check rounds ran (1 = the checks settled on the first pass). */
  attempts: number
  /** The budget the loop ran under. */
  maxAttempts: number
  /** Per-command outcomes of the LATEST attempt, in configured order. */
  outcomes: {
    label: string
    command: string
    exitCode: number
    passed: boolean
    /** Bounded, secret-scrubbed tail of the command's combined stdout+stderr. */
    outputTail?: string
    durationMs?: number
    timedOut?: boolean
  }[]
  /** Epoch ms the latest attempt finished. */
  at?: number
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
  /**
   * The executor image this job runs on, when it is not the default one. A per-run container
   * backend hosts a whole run's steps in ONE container, so a step declaring a different image
   * needs a container of its own: the variant is part of the container's identity, not just a
   * dispatch-time hint (see {@link containerKeyForRef}).
   *
   * It is DERIVED from the step's agent kind at the dispatch site AND at the poll site, never
   * remembered in memory between them. The poll site rebuilds the ref from the persisted step
   * alone, on another isolate and possibly another process, so an in-memory routing map would
   * send the first poll after a replay at the wrong container and read the run as evicted.
   */
  image?: RunnerImageVariant
}

/**
 * The container identity a ref addresses on a per-run container backend: the run id for the
 * default image, qualified by the variant for anything else.
 *
 * ONE function, because two callers have to agree on it exactly: the transport, which starts
 * and addresses the container, and the live-container inventory the reaper kills leaked ones
 * through. Derived rather than stored so a replayed dispatch, a poll from a fresh process and
 * a reap from a cron all land on the same container with nothing passed between them.
 */
export function containerKeyForRef(ref: RunnerJobRef): string {
  const key = ref.image && ref.image !== 'default' ? `${ref.image}:${ref.runId}` : ref.runId
  // The two must be EXACT inverses, and the PRODUCER is the only side that can check it:
  // `parseContainerKey` reads keys with no ref in hand, so it cannot tell a run id that merely
  // LOOKS variant-qualified from one that is (see its own doc for why the test it makes is a shape
  // and not a lookup). Checking here converts the one input class that would break the inverse into
  // a refused dispatch that NAMES the cause, instead of a key the reaper later maps to no run and
  // kills a live container for.
  //
  // Unreachable for every run-id scheme the platform mints today (all `[A-Za-z0-9_-]`, which cannot
  // contain the separator), which is exactly why this is a guard and not an escaping scheme: the
  // invariant the pair rests on is "a run id carries no `:`", and it was previously assumed rather
  // than stated anywhere. A future scheme that wants one has to pick a different separator, and this
  // is where it finds out: at the first dispatch, in one place, rather than as a sweep deleting
  // containers weeks later.
  const parsed = parseContainerKey(key)
  if (parsed.runId !== ref.runId || (parsed.image ?? 'default') !== (ref.image || 'default')) {
    throw new ValidationError(
      `Cannot address a container for run "${ref.runId}"${ref.image ? ` on the "${ref.image}" executor image` : ''}: ` +
        `the container key "${key}" does not read back as the run and image it was built from, so ` +
        `every reader of it (the dispatch, the poll, the orphan sweep) would disagree about which ` +
        `run owns the container. A run id may not put a variant-shaped segment before a ":", and a ` +
        `variant name must be a lower-kebab slug.`,
      {
        reason: 'container_key_not_reversible',
        runId: ref.runId,
        ...(ref.image ? { image: ref.image } : {}),
      },
    )
  }
  return key
}

/**
 * The parts a container key encodes, the exact inverse of {@link containerKeyForRef}.
 *
 * The prefix is stripped ONLY when it is SHAPED like a variant name. A bare "everything before
 * the first colon is a variant" split is lossy in the direction that destroys data: a key
 * carrying a colon for any OTHER reason (a job-id scheme, an operator-created label) would be
 * truncated to a run id that matches no run, and the orphan sweep below then kills a live
 * container for being unrecognised, the very misread this inverse exists to prevent. A prefix
 * that is not variant-shaped therefore answers "the whole key is the run id", which at worst
 * leaves a container for the next sweep.
 *
 * SHAPE rather than membership, because variant names are open: a deployment's own is a slug
 * only its runner backend can map, and this function is read by a reaper that holds no backend
 * config. The rule is the one every declaring boundary already enforces (`checkAgentImageVariants`
 * at boot, the backends' variant-map schemas), so a prefix this rejects is one no registration
 * could have produced.
 *
 * What that leaves is a prefix which IS slug-shaped and was never a variant. Open names make that
 * case unknowable HERE, so it is not decided here: {@link containerKeyForRef} refuses to mint a key
 * this function would read back differently, which is what makes the pair exact rather than merely
 * careful. Every key the inventory holds was written by that producer, so a prefix reaching this
 * point and passing the shape test came from a variant a registration declared. The split of
 * responsibility is the point: the reader refuses anything UNSHAPED, and the writer refuses
 * anything AMBIGUOUS, because only one of them holds the ref to compare against.
 */
export function parseContainerKey(containerKey: string): {
  runId: string
  image?: RunnerImageVariant
} {
  const separator = containerKey.indexOf(':')
  if (separator <= 0) return { runId: containerKey }
  const prefix = containerKey.slice(0, separator)
  // `default` is never a prefix (`containerKeyForRef` emits the bare run id for it), so a key
  // spelling it out is not one this function produced and is left whole.
  if (prefix === 'default' || !isImageVariantName(prefix)) return { runId: containerKey }
  return { runId: containerKey.slice(separator + 1), image: prefix }
}

/**
 * The run a container key belongs to (see {@link parseContainerKey}).
 *
 * A backend that reaps by asking "is this run still live?" has to ask about the RUN, not the
 * key: a `tester-ui` container is keyed `ui:<runId>`, which matches no run, so an orphan sweep
 * reading the key directly answers "no such run" for a container whose run is mid-step and
 * kills the browser out from under it.
 */
export function runIdFromContainerKey(containerKey: string): string {
  return parseContainerKey(containerKey).runId
}

/**
 * What the harness said when it ACCEPTED a job. Read at the dispatch site, where the body that
 * was just sent is still in scope, which is the only place the answer can be acted on before
 * the agent starts working from a prompt the body may not be able to back up.
 *
 * Everything on it is optional and everything absent means "this backend could not tell",
 * never "no". See `domain/harness-capabilities.ts` for why that distinction is load-bearing.
 */
export interface RunnerDispatchAck {
  /**
   * The optional job-body capability fields the running image parses, verbatim off the wire
   * (`HarnessBodyCapability[]` once narrowed). Absent on an image older than the handshake.
   */
  capabilities?: readonly string[]
}

/**
 * What a request to stop ONE in-flight job actually achieved, which is a different question from
 * whether the request returned.
 *
 * A job that has already been ACCEPTED is doing work: a harness starts on acceptance, so a caller
 * that has decided the job must not run (the capability refusal) has to stop it, and a caller that
 * cannot stop it must say so rather than let the silence read as a stop. That is the same rule the
 * environment-disposal flow learned the hard way (a teardown call returning is not the environment
 * being gone), so the outcome is REPORTED rather than assumed:
 *
 *   - `stopped`: the job is confirmed no longer running. Either the harness acknowledged the abort
 *     and the job left `running`, or the thing that held it (the container, the pod) was destroyed.
 *   - `requested`: a cancel was handed to a control plane this backend cannot see through (a
 *     self-hosted pool's scheduler) and accepted. Better than nothing and worse than proof.
 *   - `unsupported`: there is no mechanism at all: a transport with no {@link RunnerTransport.stopJob},
 *     or a pool whose manifest declares no `release` template. Nothing was even attempted.
 *
 * A stop that was attempted and ERRORED is not a member: it throws, so the caller can log the cause
 * and report the fourth fact (the attempt failed) instead of picking one of these to stand in for it.
 */
export type RunnerJobStopOutcome = 'stopped' | 'requested' | 'unsupported'

export interface RunnerTransport {
  /**
   * A stable identifier for this backend (`local-native` / `local-container` / `runner-pool` /
   * `cloudflare-container`), stamped onto every {@link RunnerJobView} by the shared job client so
   * the engine can record which backend a run's step executed on. A composite router that picks a
   * leg per job leaves this undefined and stamps the leg's id on the view itself. Optional so a
   * transport that doesn't care is unaffected.
   */
  readonly backend?: string
  /**
   * Start the job `ref.jobId` (in run `ref.runId`) with the harness job `spec`, or
   * re-attach to one already running for that ref. Must be idempotent per ref so a
   * replayed dispatch never starts a duplicate. `kind` is the single manifest-driven
   * `agent` kind (carried in the job body; the body's `mode` + data select the flow);
   * the job is polled via {@link poll}.
   *
   * Returns the harness's {@link RunnerDispatchAck} when the backend can see it. `void` is a
   * first-class answer, not a stub: a transport whose control plane does not forward the
   * harness's own response (a self-hosted pool's job API, a deploy backend that runs no agent)
   * genuinely does not know, and the capability handshake reads that as `unknown` rather than as
   * a refusal. See `domain/harness-capabilities.ts`.
   */
  dispatch(
    ref: RunnerJobRef,
    spec: Record<string, unknown>,
    kind?: RunnerDispatchKind,
    options?: RunnerDispatchOptions,
  ): Promise<RunnerDispatchAck | void>
  /** Poll the job's current state. */
  poll(ref: RunnerJobRef): Promise<RunnerJobView>
  /**
   * Optionally reclaim a run's runner resources: the per-run container on backends
   * that share one across the run (Cloudflare, local Docker), and any of the run's
   * still-running jobs on a per-job backend (a self-hosted pool cancels `ref.jobId`).
   * Best-effort and idempotent — releasing an already-gone run/job is a no-op.
   *
   * NOT a way to stop a job. On a backend that shares one container across a run this reclaims
   * (and so kills) whatever is inside it, but on a POOLED backend it does the opposite: a warm
   * pool member is handed back for the next run to lease, job and all. Use {@link stopJob} where
   * the job itself must die.
   */
  release?(ref: RunnerJobRef): Promise<void>
  /**
   * Optionally stop the single in-flight job `ref.jobId`, and report what that achieved (see
   * {@link RunnerJobStopOutcome}). Idempotent: stopping a job that already settled is `stopped`.
   *
   * Distinct from {@link release} because the intents differ and so do the correct behaviours: a
   * release hands a pool member BACK, which is exactly wrong for a job that must not keep running,
   * and a release on a per-job pool is frequently a no-op. A transport that owns the container the
   * job runs in may ESCALATE (destroy the container) when the graceful abort fails, since that is
   * still a confirmed stop.
   *
   * Absent ⇒ the caller reads `unsupported`: this backend has no way to stop an accepted job, which
   * is a fact to report, never one to assume away.
   */
  stopJob?(ref: RunnerJobRef): Promise<RunnerJobStopOutcome>
}
