import type {
  ConnectionTestResult,
  EnvironmentAccessHandle,
  EnvironmentManifest,
  EnvironmentStatus,
  ProviderConfigField,
} from '../domain/types.js'
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
export interface RepoFilesCoords {
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
   * Clone coordinates (HTTPS URL + short-lived token + ref) for a SYNCHRONOUS provider that
   * needs a working tree — the Docker Compose backend's build-from-source mode clones the PR
   * head so `build:` contexts, in-checkout bind mounts, and relative `env_file`s resolve.
   * Resolved by the provisioning service (the same `resolveDeployCloneTarget` the async deploy
   * path uses) when a repo-bound block is known. Absent ⇒ no clone was resolvable (no VCS
   * connection / block-less manual provision); a build-mode provision then fails deterministically.
   */
  clone?: DeployCloneTarget
}

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

/** The provider's view of a provisioned environment (mapped from its response). */
export interface ProvisionedEnvironment {
  externalId: string | null
  url: string | null
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
// the TARGET repo (e.g. a Kargo `.kargo.yml`). Some providers (Kargo) require a
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
  /** The repo-relative path the issue concerns, when applicable (e.g. `.kargo.yml`). */
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
   */
  buildProvisionJob(req: ProvisionEnvironmentRequest): DeployProvisionJob | null
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
