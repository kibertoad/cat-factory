import type {
  ConnectionTestResult,
  EnvironmentAccessHandle,
  EnvironmentAddress,
  EnvironmentFailureReason,
  EnvironmentManifest,
  EnvironmentStatus,
  PreflightRef,
  PreflightResult,
  ProviderConfigField,
} from '../domain/types.js'
import type { EnvironmentDiagnosticsCapability } from './environment-diagnostics.js'
import type { RunRepoContext } from './repo-files.js'
import type { RunnerDispatchOptions, RunnerJobRef, RunnerJobView } from './runner-transport.js'

// Port for an ephemeral-environment provider: the thing that actually calls an
// org's self-rolled management API to provision/observe/destroy environments.
// The worker supplies a single generic `fetch`-based adapter that *interprets a
// manifest*, so one stateless instance serves every workspace. Credentials are
// passed per call (resolved from the workspace's decrypted secret bundle) so the
// core never holds raw secrets at rest — mirroring the Confluence client.

/** Resolve a manifest `secretRef.key` to its value, or undefined if unset. */
export type SecretResolver = (key: string) => string | undefined

/** Fields extracted from an earlier provision response, for status/teardown. */
export type ProvisionFields = Record<string, string>

/**
 * Typed build context for a provision call, derived from the block under deployment.
 * A PR-environment provider needs the git ref + repo identity to target the right
 * environment; the same values are also flattened into `inputs` as `{{input.*}}`
 * strings for the manifest path. Every field is optional — a manual provision or a
 * non-PR block may carry none.
 */
export interface ProvisionContext {
  blockId?: string
  /** The head branch the agent pushed its work to, when known. */
  branch?: string
  /** The pull request number within the repo, when known. */
  pullNumber?: number
  /** The pull request web URL, when known. */
  pullUrl?: string
  /** The repo owner (org/user login), when resolvable. */
  repoOwner?: string
  /** The repo name, when resolvable. */
  repoName?: string
}

/** Coordinates for resolving a RepoFiles bound to an arbitrary repo (separate manifests). */
interface RepoFilesCoords {
  owner: string
  repo: string
  /** Branch/tag/sha to read at; absent ⇒ that repo's default branch. */
  ref?: string
  provider?: 'github' | 'gitlab'
}

/**
 * Concrete clone coordinates the deploy container uses to fetch the manifests repo (the
 * block's own PR repo for `colocated`, or the separate manifests repo for `separate`),
 * resolved by the provisioning service BEFORE dispatch. `buildProvisionJob` plugs these
 * straight into the deploy job — it can't mint a token or build a clone URL itself (that is
 * VCS-specific, server-layer work). The token is short-lived and redacted in any job output.
 */
export interface DeployCloneTarget {
  /** HTTPS clone URL of the manifests repo (e.g. `https://github.com/owner/repo.git`). */
  cloneUrl: string
  /** Branch/tag/sha the deploy container checks out (the PR head branch, or the source ref). */
  ref: string
  /** Short-lived git token for cloning a private repo; absent ⇒ a public repo. */
  token?: string
}

/**
 * The inputs an ASYNC, container-backed provision needs that the stateless provider can't
 * derive itself: the deploy job's identity ({@link RunnerJobRef} — the run + the deployer
 * step's job id) and the manifests-repo clone target. Resolved by the provisioning service
 * before dispatch and handed to {@link AsyncProvisionCapability.buildProvisionJob}.
 */
export interface DeployProvisionInputs {
  ref: RunnerJobRef
  clone: DeployCloneTarget
}

export interface ProvisionEnvironmentRequest {
  manifest: EnvironmentManifest
  /** Provision inputs (`{{input.*}}` in templates). */
  inputs: Record<string, string>
  /**
   * Typed git/PR/repo context for a code adapter. The same values are also present
   * in `inputs` as strings, so the manifest-HTTP path needs nothing extra.
   */
  provisionContext?: ProvisionContext
  resolveSecret: SecretResolver
  /**
   * The block's own run repo, checkout-free + bound to the PR head branch — for a
   * native adapter that reads co-located manifests from the deployed repo. Absent for
   * a block-less manual provision or when GitHub isn't connected. The generic HTTP
   * provider ignores it.
   */
  runRepo?: RunRepoContext
  /**
   * Resolve a checkout-free RepoFiles bound to an ARBITRARY repo — for a native adapter
   * that reads manifests from a SEPARATE repo. Returns null when the repo can't be
   * resolved (no VCS connection). The generic HTTP provider ignores it.
   */
  resolveRepoFiles?: (coords: RepoFilesCoords) => Promise<RunRepoContext | null>
  /**
   * Inputs for an ASYNC, container-backed provision: the deploy job identity + the manifests
   * repo clone target. Resolved by the provisioning service before dispatch and consumed by
   * {@link AsyncProvisionCapability.buildProvisionJob}. Absent ⇒ the async inputs aren't wired
   * (the synchronous REST `provision()` path runs).
   */
  deploy?: DeployProvisionInputs
  /**
   * LAZY clone-target resolver (HTTPS URL + short-lived token + ref) for a SYNCHRONOUS provider
   * that needs a working tree — the Docker Compose backend's build-from-source mode clones the PR
   * head so `build:` contexts, in-checkout bind mounts, and relative `env_file`s resolve. It is a
   * thunk, not an eager value, so ONLY a provider that actually needs a checkout pays the token
   * mint: image-mode compose / custom / k8s-sync provisions never call it. Backed by the same
   * `resolveDeployCloneTarget` seam the async deploy path uses (memoized, and reused from the
   * deploy inputs when present, so one provision never mints twice). Resolves to `undefined` when
   * no clone target is available (no VCS connection / block-less manual provision); a build-mode
   * provision then fails deterministically. Absent ⇒ the caller doesn't offer a clone at all.
   */
  clone?: () => Promise<DeployCloneTarget | undefined>
  /**
   * Best-effort per-step provisioning-log sink for a multi-step STACK RECIPE (the Docker Compose
   * complex-monolith bring-up). The compose provider calls it once per recipe step (and per engine
   * phase) with the step name + verdict + duration; absent ⇒ steps aren't individually logged (the
   * simple single-file compose path, or a facade with no provisioning log wired). Never throws.
   */
  recordStep?: RecipeStepRecorder
  /**
   * Bring the SHARED STACKS a stack recipe references (`recipe.sharedStackRefs`) UP before the
   * per-PR consumer project is stood up (provider-before-consumer), returning the managed Docker
   * networks those stacks own so the consumer can be attached to them as `external: true` (the
   * acme `acme-net` shape). Given the shared-stack ids, it ensures each idempotently, IN ORDER (a
   * later stack may depend on an earlier one's network), and returns the deduped union of their
   * managed networks — or a blocking `error` (never throws) when a ref names no stack in the
   * workspace or a stack's bring-up fails, so the provider surfaces it as a deterministic provision
   * failure. Wired by the provisioning service (which owns the workspace + the shared-stack
   * lifecycle); the provider only names the refs. Absent ⇒ the shared-stack lifecycle isn't wired
   * (no host daemon), so a recipe that declares refs fails loudly instead of silently ignoring them.
   */
  ensureSharedStacks?: (refs: string[]) => Promise<SharedStackEnsureResult>
  /**
   * Run a stack recipe's machine PREREQUISITE checks (`recipe.prerequisites`) at provision start and
   * return one verdict per ref — the compose provider streams each to the provisioning log and fails
   * the provision fast (before the daemon / clone work) when any REQUIRED check fails, surfacing its
   * remediation instead of a mystery deep inside a 40-image pull. Given the refs, it runs the host
   * probes (docker daemon / disk / RAM / registry login / reachability / mkcert / hosts / secrets
   * marker) and returns their results; it never throws (a probe error is a `fail` verdict). Bound by
   * the provisioning service (which owns the workspace); the provider only names the refs. Absent ⇒
   * the preflight host-probe runtime isn't wired (no host daemon), so a recipe that declares
   * prerequisites fails loudly rather than silently skipping a declared safety gate.
   */
  runPreflights?: (refs: PreflightRef[]) => Promise<PreflightResult[]>
}

/**
 * The outcome of a provision-time {@link ProvisionEnvironmentRequest.ensureSharedStacks} call:
 * either the referenced shared stacks are all up (`networks` = the deduped union of the Docker
 * networks they own, for the consumer to attach to as `external: true`) or a blocking `error` (a
 * missing ref / a stack whose bring-up failed). Never thrown — the compose provider turns a
 * failure into a deterministic `status: 'failed'` provision, like every other recipe-step verdict.
 */
export type SharedStackEnsureResult =
  | { ok: true; networks: string[] }
  | { ok: false; error: string }

export interface EnvironmentStatusRequest {
  manifest: EnvironmentManifest
  externalId: string | null
  /** Fields captured at provision time (`{{provision.*}}` in templates). */
  provisionFields: ProvisionFields
  resolveSecret: SecretResolver
}

export interface EnvironmentTeardownRequest {
  manifest: EnvironmentManifest
  externalId: string | null
  provisionFields: ProvisionFields
  resolveSecret: SecretResolver
}

/**
 * What a provider found when asked, AFTER a successful teardown, whether the environment is
 * actually gone. A three-way answer rather than a boolean, because "I looked and it is still
 * there" and "I cannot look" are different facts that need different people to do different
 * things, and collapsing them is what lets an environment nobody can see be reported as
 * reclaimed (see {@link EnvironmentProvider.confirmTeardown}).
 *
 *  - `gone`:    the resource is not there. This is the ONLY answer that proves a teardown.
 *  - `present`: the resource is still there. Either the teardown destroyed nothing, or it is
 *               mid-flight; `terminating` says which, because a namespace with finalizers
 *               running is on its way out and an `Active` one is not.
 *  - `unknown`: the provider could not establish either — it has no endpoint to ask, the probe
 *               errored, or there was no addressable resource to ask about. `reason` is
 *               surfaced verbatim to an operator, so it must name what could not be done.
 *
 * `retryable` on the unknown answer is what keeps a deployment's PERMANENT inability to verify
 * (no `status:` template in the manifest, a provider with nothing to observe) from reading like a
 * blip. The two want opposite reactions: a blip is worth re-probing on the next sweep, and a
 * configuration fact will answer identically forever and is only ever fixed by a human editing
 * the manifest. Without the split, an operator watching a permanently unverifiable environment
 * waits for a confirmation that is never coming.
 */
export type TeardownProbe =
  | { state: 'gone' }
  | { state: 'present'; terminating: boolean; detail?: string }
  | { state: 'unknown'; reason: string; retryable: boolean }

/**
 * OPTIONALLY confirm that a torn-down environment is really gone.
 *
 * This exists because {@link EnvironmentProvider.teardown} returning without throwing does not
 * mean anything was destroyed. The generic manifest provider whose manifest omits a `teardown:`
 * template calls nothing and reports `torn_down`; a Kubernetes namespace `DELETE` returns while
 * the namespace is still `Terminating`. A platform that records the call's success as the
 * environment's death reports reclaimed infrastructure that is still running and still billing,
 * on the very pull request a reviewer trusts for that fact.
 *
 * Deliberately NOT folded into {@link EnvironmentProvider.status}: `status` answers "how is my
 * environment doing" and every implementation is written to describe a LIVE one, so its answers
 * for a destroyed resource are incidental — the generic provider with no `status` template
 * returns `ready` forever, which as a teardown verdict is a confident lie in the direction that
 * matters most. A separate method makes the question explicit and lets a provider that cannot
 * answer it say so, rather than having an answer inferred from a call meant for something else.
 *
 * Absent ⇒ the provider offers no confirmation and the platform records the teardown as
 * `unverifiable`, which is reported as such and never as a reclaim.
 */
export type ConfirmTeardown = (req: EnvironmentTeardownRequest) => Promise<TeardownProbe>

/**
 * One STACK-RECIPE step's outcome, streamed to the provisioning log as it completes (a
 * multi-step compose bring-up — env-file materialization, `up`, `composer install`, seed
 * import, migrations, index builds, the health gate). Each entry is best-effort: a log-write
 * failure never breaks the provision (the recorder swallows it), and a step that succeeds or
 * fails writes exactly one entry, so the "View logs" drawer shows which step is running / died.
 */
export interface RecipeStepLog {
  /** The step's human label (the recipe step `name`, or a synthetic label for an engine phase). */
  name: string
  outcome: 'success' | 'failure'
  /** Wall-clock duration of the step (ms). */
  durationMs: number
  /** A short output tail / structured note for the log, when useful. */
  detail?: string
  /** The failure message when `outcome === 'failure'`. */
  error?: string
}

/**
 * Best-effort sink a provider calls once per recipe step, so a long multi-step bring-up streams
 * per-step entries into the provisioning log instead of a single opaque provision result. The
 * provisioning service builds the closure (it owns the workspace/block/run/provider ids); the
 * provider only names the step + its verdict. Absent ⇒ steps aren't individually logged.
 */
export type RecipeStepRecorder = (log: RecipeStepLog) => Promise<void>

/** The provider's view of a provisioned environment (mapped from its response). */
export interface ProvisionedEnvironment {
  externalId: string | null
  url: string | null
  /**
   * Addresses this provider states carry traffic for {@link url}'s host, in ITS preference order.
   *
   * The half of addressing a URL cannot express, and the reason it is a first-class field rather
   * than a {@link ProvisionFields} key. `fields` is free-form and a provider can already write an
   * address there, but it buys nothing: the fields are persisted encrypted as teardown state, they
   * are absent from `EnvironmentHandle`, and the engine projects a fixed handful of keys into agent
   * context. An address that reaches nobody is not an address.
   *
   * Absent (the ordinary case) means the name in `url` is the only thing anyone has to try. Stating
   * one is a CLAIM, never a conclusion: what the platform publishes downstream is the candidate
   * that was PROVED to carry (see `EnvironmentRouteProof`).
   */
  addresses?: readonly EnvironmentAddress[] | null
  status: EnvironmentStatus
  expiresAt: number | null
  access: EnvironmentAccessHandle | null
  /** All fields the response mapping captured, for later status/teardown calls. */
  fields: ProvisionFields
  /**
   * The verbatim provider error, set when a provider reports `status: 'failed'` WITHOUT
   * throwing (a deterministic rejection — quota exceeded, invalid manifest, …). Surfaced
   * verbatim as the deployer step's `step.environment.lastError`, so a non-throwing failure
   * carries a real root cause instead of a generic "Provisioning failed". Absent on success
   * (and on a throw, where the thrown error is the root cause instead).
   */
  error?: string | null
  /**
   * The MACHINE-READABLE cause beside {@link error}, and the non-throwing half of the
   * classification contract in `domain/environment-failure.ts`. A provider that throws states its
   * cause on the `DomainError`'s `details.reason`; one that reports `status: 'failed'` instead has
   * no error to carry it, and this is where it goes.
   *
   * It has to be stated HERE rather than re-derived downstream. The engine reads the class to
   * decide whether an automated fixer may be dispatched at the failure, and by the time a failed
   * environment reaches that decision the only thing left is prose, which is exactly the evidence
   * that is not good enough to spend a container on. So a provider that cannot classify leaves
   * this absent, and absent means unclassified, which is never repo-fixable.
   */
  reason?: EnvironmentFailureReason | null
  /**
   * One sentence saying WHERE the environment is, for a report that is NOT a failure: the
   * channel a provider answering `provisioning` has and {@link error} is not.
   *
   * `error` is read only on `failed`, and the two persistence sites null it on anything else, so
   * before this field a provider that knew exactly why an environment was not ready yet had
   * nowhere to put it. Within one readiness wait every poll that keeps the wait alive is a
   * `provisioning` one, so the platform's whole account of a 20-minute wait was how long it
   * waited. The one workaround left was to report `failed` early, purely because `failed` was the
   * only status whose reason survived persistence: a truthful lifecycle state traded for an
   * explainable one.
   *
   * Deliberately NOT `error` widened to every status. The name would then be wrong for the case
   * it exists for, and the value is rendered: a healthy environment mid-rollout would show an
   * operator a "last error" it does not have.
   *
   * It is the CURRENT account and never a log: like `error` it is re-read from the provider and
   * rewritten on every poll, so a note a provider stops saying stops being persisted. Say what
   * distinguishes this poll from the last one ("the deploy job has not started", "the deploy
   * succeeded and no target is healthy yet"). Both are `provisioning`, and which one it is
   * decides who fixes it. Absent ⇒ nothing to add, which is byte-for-byte the prior behaviour.
   */
  statusNote?: string | null
}

/**
 * A container-backed provision job, returned by {@link AsyncProvisionCapability.buildProvisionJob}
 * when a provider stands the environment up asynchronously in a deploy container (real
 * `kubectl`/`kustomize`/`helm`) instead of inline over REST. The engine dispatches it
 * through the shared runner transport, parks the deployer step, polls, then settles via
 * {@link AsyncProvisionCapability.finalizeProvision}. The `spec` is the opaque (redacted) job
 * body the deploy harness consumes.
 */
export interface DeployProvisionJob {
  ref: RunnerJobRef
  spec: Record<string, unknown>
  kind: 'deploy'
  options?: RunnerDispatchOptions
}

/**
 * Test a provider connection before it is saved. A manifest-driven provider gets
 * the candidate manifest; a native provider gets its non-secret `config`. Both get
 * a `resolveSecret` over the supplied (unpersisted) secret values.
 */
export interface EnvironmentConnectionTestRequest {
  manifest?: EnvironmentManifest
  config: Record<string, string>
  resolveSecret: SecretResolver
}

// ---------------------------------------------------------------------------
// Repo lifecycle: validate / bootstrap / agent-repair the provider's config in
// the TARGET repo (e.g. a `.deploy.yml`). Some providers require a
// config file to exist in the deployed repo before they can provision. These
// OPTIONAL capabilities let a native adapter (a) mechanically verify that file is
// present + well-formed, (b) mechanically generate it from UI-collected variables,
// and (c) supply an agent prompt to fix a malformed/partial one when mechanical
// generation can't. The provider supplies the EXPECTATIONS / generation / prompt;
// the engine supplies the VCS-neutral read+write and the agent runtime — so the
// provider never sees a VCS host or a token (GitHub today, GitLab later).
// ---------------------------------------------------------------------------

/**
 * A VCS-neutral, already-bound file reader handed to a provider so it can inspect a
 * target repo WITHOUT knowing the VCS host. The engine builds it from the workspace's
 * resolved RepoFiles (GitHub today, GitLab later); the provider only names paths.
 * Returns null when the path is absent on the ref.
 */
export type RepoFileReader = (
  path: string,
  gitRef?: string,
) => Promise<{ content: string; sha: string } | null>

/** Severity of a single repo-validation finding. */
export type RepoValidationSeverity = 'error' | 'warning'

/** One finding from a repo validation (a missing/invalid file, a bad field, etc.). */
export interface RepoValidationIssue {
  severity: RepoValidationSeverity
  /** Human-readable explanation, safe to surface to an operator. */
  message: string
  /** The repo-relative path the issue concerns, when applicable (e.g. `.deploy.yml`). */
  path?: string
}

/**
 * Ask a provider to mechanically verify a target repo contains the files it needs
 * BEFORE provisioning. The engine supplies the neutral reader (already bound to the
 * workspace's repo + connection); the provider supplies the expectations.
 */
export interface RepoValidationRequest {
  /** VCS-neutral read of a file on `defaultGitRef` (or an explicit ref). */
  readRepoFile: RepoFileReader
  /** The ref to read at when a call omits one (PR head branch / default branch). */
  defaultGitRef?: string
  /** Display-only repo coordinates, for messages. NOT used to build a client. */
  repoOwner?: string
  repoName?: string
  /** Per-workspace native config (the manifest's `providerConfig` bag), when known. */
  config?: Record<string, string>
  resolveSecret: SecretResolver
}

/** The outcome of a repo validation: ok plus structured issues. */
export interface RepoValidationResult {
  ok: boolean
  issues: RepoValidationIssue[]
}

/** One file the bootstrap op will write into the repo (create or update). */
export interface BootstrapConfigFile {
  path: string
  content: string
}

/**
 * Ask a provider to mechanically GENERATE its config file(s) for a target repo from
 * variables collected via the UI bootstrapping form. The provider returns the file
 * bytes; the ENGINE commits them through the VCS-neutral writer (so the provider stays
 * side-effect-free). The provider may also read existing files (to detect/merge an
 * existing config) via `readRepoFile`.
 */
export interface BootstrapConfigRequest {
  /** Variables collected from the UI form (keyed by `describeBootstrapInputs` keys). */
  inputs: Record<string, string>
  /** VCS-neutral read, to detect/merge an existing config. */
  readRepoFile: RepoFileReader
  defaultGitRef?: string
  repoOwner?: string
  repoName?: string
  config?: Record<string, string>
  resolveSecret: SecretResolver
}

/** The provider's mechanical-bootstrap output: files to write, or "needs an agent". */
export interface BootstrapConfigResult {
  /** Files the engine should create/update. Empty ⇒ nothing to write. */
  files: BootstrapConfigFile[]
  /** Suggested commit message / PR title for the write. */
  commitMessage?: string
  /**
   * The provider could NOT safely produce the config mechanically (e.g. an existing
   * config is present but malformed and merging is ambiguous). The engine falls back
   * to the repair agent (`describeRepairAgent`) when allowed.
   */
  needsAgent?: boolean
  /** Diagnostics explaining a `needsAgent` outcome (or non-fatal warnings). */
  issues?: RepoValidationIssue[]
}

/**
 * Context for building the repair-agent prompt: the validation issues that triggered
 * the repair, plus the bootstrap variables/coords (so the prompt can be specific).
 */
export interface RepairAgentRequest {
  issues: RepoValidationIssue[]
  inputs?: Record<string, string>
  repoOwner?: string
  repoName?: string
  config?: Record<string, string>
}

/** The prompt a coding agent is dispatched with to fix a malformed provider config. */
export interface RepairAgentSpec {
  /** The user prompt handed to the coding agent. */
  prompt: string
  /** Optional extra system guidance appended to the base coding role. */
  systemPromptAddendum?: string
}

/**
 * The asynchronous, container-backed provisioning capability: the paired job-builder +
 * finalizer a provider exposes when it stands environments up in a deploy container (real
 * `kubectl`/`kustomize`/`helm`) instead of inline over REST. Grouped into ONE optional
 * member on {@link EnvironmentProvider} so the build⇒finalize invariant is enforced by the
 * type system — a provider cannot supply a job-builder without the matching finalizer.
 */
export interface AsyncProvisionCapability {
  /**
   * Build an asynchronous, container-backed provision job instead of provisioning inline in
   * {@link EnvironmentProvider.provision}. Returns a job for the engine to dispatch + park on
   * (then settle via {@link finalizeProvision}), or `null` to use the synchronous
   * `provision()` path. The Kubernetes adapter returns a job only when the manifest source
   * needs rendering (`renderer: 'kustomize'`) or helm releases are declared; raw manifests
   * keep the in-Worker REST path.
   *
   * ASYNC because a provider may also have to PREPARE the target for the job it is handing
   * over: the Kubernetes adapter creates the namespace and wires its registry pull credential
   * here, because those are cluster writes the render container cannot make for itself without
   * the platform's own credentials. A throw is a provision failure, exactly as an inline one is.
   */
  buildProvisionJob(req: ProvisionEnvironmentRequest): Promise<DeployProvisionJob | null>
  /**
   * Map a finished deploy job's view (namespace, URL, status) into a
   * {@link ProvisionedEnvironment}. Called by the engine when a job built by
   * {@link buildProvisionJob} reaches a terminal state.
   */
  finalizeProvision(view: RunnerJobView, req: ProvisionEnvironmentRequest): ProvisionedEnvironment
}

export interface EnvironmentProvider {
  provision(req: ProvisionEnvironmentRequest): Promise<ProvisionedEnvironment>
  status(req: EnvironmentStatusRequest): Promise<ProvisionedEnvironment>
  teardown(req: EnvironmentTeardownRequest): Promise<{ status: EnvironmentStatus }>
  /**
   * Positively confirm a torn-down environment is gone. Optional — absent ⇒ this provider
   * cannot verify its own teardowns and they are recorded `unverifiable`. See
   * {@link ConfirmTeardown} for why this is not `status()`.
   */
  confirmTeardown?: ConfirmTeardown
  /**
   * OPTIONALLY describe what is wrong with an environment, and act on it in place. Present ⇒ the
   * platform's environment investigation is handed the provider's own account of the environment
   * (its control-plane facts, its logs, and the reads it could not make) beside the evidence the
   * platform holds itself; absent ⇒ the investigation runs on the platform's evidence alone, which
   * is byte-for-byte what it would have had anyway. See {@link EnvironmentDiagnosticsCapability}.
   */
  diagnostics?: EnvironmentDiagnosticsCapability
  /**
   * Optional asynchronous, container-backed provisioning. Present ⇒ the provider stands
   * environments up in a deploy container ({@link AsyncProvisionCapability}); absent ⇒ it is
   * synchronous-only (the in-Worker REST `provision()` path). The two methods are paired into
   * this single member so neither can be implemented without the other.
   */
  asyncProvision?: AsyncProvisionCapability
  /**
   * Declare the config fields this provider expects, so the UI can render a connect
   * form. A native adapter returns its own fields; the generic manifest adapter returns
   * the secret-key fields implied by a supplied manifest (or none). Optional — absent ⇒
   * the SPA falls back to the manifest editor.
   */
  describeConfig?(manifest?: EnvironmentManifest): ProviderConfigField[]
  /**
   * The base manifest a NATIVE adapter is configured through, so the SPA can render the
   * flat `describeConfig` form yet still persist a full manifest (the single storage
   * path — see `backend/docs/native-environment-adapter.md`). The SPA overlays each
   * field value onto this scaffold: a `secret` field goes into the secret bundle (the
   * scaffold's `auth` already references its key), a non-secret field into
   * `providerConfig[key]` (a `baseUrl` field onto `baseUrl`). The scaffold supplies the
   * parts no flat field carries — `auth` scheme, the `provision`/`status`/`teardown`
   * request templates (which a native adapter ignores at run time but the schema
   * requires), and `response`. Absent ⇒ a manifest-authored provider; the SPA edits the
   * manifest directly. Carries NO secret values — only the shape + secret-ref keys.
   */
  describeManifestTemplate?(): EnvironmentManifest
  /** Probe the connection without persisting. Optional — absent ⇒ "nothing to test". */
  testConnection?(req: EnvironmentConnectionTestRequest): Promise<ConnectionTestResult>
  /**
   * Mechanically verify a target repo satisfies this provider's expectations
   * (required files present + well-formed) BEFORE provisioning. The engine hands a
   * VCS-neutral `readRepoFile`; the provider declares what it needs. Optional —
   * absent ⇒ "no repo validation" (the engine skips the pre-flight gate).
   */
  validateRepo?(req: RepoValidationRequest): Promise<RepoValidationResult>
  /**
   * Declare the variables the UI bootstrapping form should collect to generate this
   * provider's config file. Reuses {@link ProviderConfigField} so the SPA renders the
   * form generically (like `describeConfig`). Optional — absent ⇒ no bootstrap form.
   */
  describeBootstrapInputs?(): ProviderConfigField[]
  /**
   * Mechanically generate this provider's config file(s) for a target repo from the
   * collected `inputs`. Returns the file bytes (the engine commits them) or
   * `needsAgent: true` when it can't be done safely. Optional — absent ⇒ no mechanical
   * bootstrap (the engine may still offer the agent-repair path).
   */
  bootstrapProviderConfiguration?(req: BootstrapConfigRequest): Promise<BootstrapConfigResult>
  /**
   * Supply the prompt for a coding agent to FIX a malformed/partial provider config
   * when mechanical bootstrap can't (e.g. a config exists in the wrong form). The
   * engine dispatches a container coding agent with this prompt against the repo.
   * Optional — absent ⇒ no agent fallback.
   */
  describeRepairAgent?(req: RepairAgentRequest): RepairAgentSpec
}
