import * as v from 'valibot'
import { frameRepoTypeSchema } from './primitives.js'
import { stepSubtasksSchema } from './execution.js'
import { bootstrapStatusSchema } from './bootstrap.js'
import { agentFailureKindSchema } from './agent-failure-kinds.js'
import { vcsProviderSchema } from './routes/auth.js'
import { vcsConnectMethodSchema } from './routes/vcs.js'
import { workspaceRoleSchema } from './workspace-members.js'

// ---------------------------------------------------------------------------
// DEPLOYMENT PROVISIONING on `/api/v1`: what a headless caller needs to bring a workspace from
// "connected" to "able to run a pipeline", which until now had no public counterpart at all.
//
// Four groups, and they are four because each answers a different question a caller asks BEFORE it
// has anything to file work against: make me a repository; connect me to the infrastructure a run
// deploys onto; tell one service where its manifests live; and tell me what this deployment has
// actually wired.
//
// **Every STRUCTURAL shape here is a PROJECTION, never a re-export of the internal one**, and that
// is the load-bearing decision in this file. The internal shapes it projects from
// (`infraHandlerConfig`'s five-engine variant, `serviceProvisioning`'s per-engine bag,
// `kubernetesManifestSource`, `kubernetesUrlSource`, `modelOption`, `githubConnection`,
// `riskPolicy`) are INTERNAL wire shapes, which this repo evolves freely and deliberately without
// migrations. `/api/v1` is the opposite: frozen, and broken only through a version change plus a
// migration path (ADR 0034). Re-exporting one onto the other would silently bind the frozen surface
// to a shape someone is expected to change, so the next ordinary field rename becomes a public
// break nobody reviewed as one. The projections cost a mapper each, in
// `PublicProvisioningController`, and that mapper is exactly where the two vocabularies are allowed
// to differ.
//
// **The shared closed VOCABULARIES are the stated exception, and they are pinned rather than
// copied**: `bootstrapStatus`, `agentFailureKind`, `vcsProvider`, `vcsConnectMethod`,
// `workspaceRole` and the three counters of `stepSubtasks` are imported and used as they are. A
// second copy of a picklist buys nothing a projection buys: the members ARE meant to be the same
// set, and duplicating them creates the stale-value hazard the repo warns about (a value a stored
// row still holds, mapped through a lookup that no longer has it). What a projection would have
// caught is caught instead by `public-provisioning.test.ts`, which pins each published member list,
// so editing one of these internally fails a test that names the public break rather than
// regenerating four SDKs quietly.
//
// **A secret goes IN and never comes back.** The connection calls accept a secret bundle because
// reaching an apiserver requires one; every response projects the KEYS that were supplied and no
// value, so a caller can confirm what it sent without the surface ever becoming a way to read a
// credential back out.
// ---------------------------------------------------------------------------

const slugField = v.pipe(
  v.string(),
  v.trim(),
  v.regex(/^[A-Za-z0-9_.-]+$/, "Only letters, digits, '.', '_' and '-' are allowed"),
  v.minLength(1),
  v.maxLength(100),
)
const descriptionField = v.pipe(v.string(), v.maxLength(2000))
const instructionsField = v.pipe(v.string(), v.maxLength(8000))
const labelField = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))

// ---- 1. Repo bootstrap ------------------------------------------------------
// **A request field carries no valibot DEFAULT**, here or in any of the bodies below, and the
// omitted-value rule is applied by the controller instead. A default means "always present" on the
// way out and "may be omitted" on the way in, and one schema cannot say both to a generator that
// emits a request type and a response type from it (`scripts/sdk/ir.mjs` refuses the ambiguity
// outright). The documented default is stated in each field's own comment, which is what a caller
// reads, and applied once where the internal input is built.

/**
 * Create a repository from scratch (or from a reference architecture) and adapt it with an agent.
 *
 * The one act of board setup with no public counterpart at all: `POST /api/v1/services` can back a
 * service with a repository that already EXISTS, and nothing on this surface could make one, so a
 * deployment automating itself had to open a browser exactly once, at the very first step.
 *
 * Mirrors the internal bootstrap body's own rule rather than relaxing it: a run needs either a
 * reference architecture to clone or a brief to scaffold from, and a request carrying neither
 * describes no work.
 */
export const publicBootstrapRepoSchema = v.pipe(
  v.object({
    /** Name for the new repository, under the owner the workspace's VCS connection names. */
    repoName: slugField,
    /** The repository's role on the board. Omitted ⇒ `service`. */
    type: v.optional(frameRepoTypeSchema),
    description: v.optional(descriptionField),
    /** Whether the new repository is private. Omitted ⇒ private, which is the safe default. */
    private: v.optional(v.boolean()),
    /**
     * The brief for the bootstrapper agent. With a reference architecture these are appended to
     * its stored defaults; with none they are the whole brief.
     */
    instructions: v.optional(instructionsField),
    /** A reference architecture to clone from; omit to scaffold from `instructions` alone. */
    referenceArchitectureId: v.optional(v.pipe(v.string(), v.minLength(1))),
  }),
  v.check(
    (input) =>
      Boolean(input.referenceArchitectureId) || (input.instructions ?? '').trim().length > 0,
    'Provide a reference architecture or freeform instructions to bootstrap from.',
  ),
)
export type PublicBootstrapRepoInput = v.InferOutput<typeof publicBootstrapRepoSchema>

/**
 * One bootstrap run, as this surface reports it.
 *
 * `serviceId` is the board service frame the run materialises, named as this surface names a
 * service everywhere else rather than as the `blockId` the engine calls it: a caller joins it
 * straight onto `POST /api/v1/services/:serviceId` and `/api/v1/services/:serviceId/tasks`.
 *
 * `failureKind` is projected beside `error` because the two answer different questions: the string
 * says what went wrong, the kind says whether a retry could plausibly help (a `preflight` refusal
 * cannot be retried into success, an `evicted` container can).
 *
 * `failureDetail` and `failureHint` ride beside it because both are diagnostic PROSE the platform
 * wrote for this moment, not engine internals: the hint is literally "where to look next". Omitting
 * them would leave a headless caller re-deriving a worse version of a sentence the deployment
 * already produced, which is the same reason the deployment's own config problems are relayed
 * verbatim rather than paraphrased. What stays off is the structured remainder whose shape is
 * genuinely internal (`reason`, kind-scoped and open-ended; `stepIndex`, documented as absent on a
 * bootstrap; `occurredAt` and `lastSubtasks`, already answerable from the fields above).
 *
 * `failureKind` carries the FULL agent-failure vocabulary rather than the narrower list a bootstrap run is
 * documented to produce, and deliberately so. The stored value is the shared `agentFailure`, so the
 * narrow list is a claim about which members are REACHED, not a constraint on what a row can hold.
 * Projecting through the narrow one would leave this mapper with a value outside its own type on
 * exactly the path whose job is to name what went wrong, and the only ways out of that are to drop
 * the kind (reporting a failure as having no classification) or to guess it onto a member nothing
 * knows was meant. Reporting the recorded value is the honest third option, and a new internal kind
 * reaches this surface as an additive enum member, which the SDKs tolerate by design.
 */
export const publicBootstrapJobSchema = v.object({
  jobId: v.string(),
  status: bootstrapStatusSchema,
  repoName: v.string(),
  /** The owner the repository was created under, resolved at run time; null until known. */
  repoOwner: v.nullable(v.string()),
  /** Web URL of the created repository; null until it succeeds. */
  repoUrl: v.nullable(v.string()),
  /** The board service frame this run materialises; null when none was created. */
  serviceId: v.nullable(v.string()),
  /** Live subtask counts from the agent's todo list; null until it first reports. */
  progress: v.nullable(stepSubtasksSchema),
  /** One-line failure reason when `status` is `failed`; null otherwise. */
  error: v.nullable(v.string()),
  /** How the run faulted, when it did: the part that says whether a retry is worth it. */
  failureKind: v.nullable(agentFailureKindSchema),
  /** Extended detail behind `error` when the platform captured any (a harness reason, an HTTP body). */
  failureDetail: v.nullable(v.string()),
  /** The platform's own "where to look next", relayed verbatim; null when it had none to offer. */
  failureHint: v.nullable(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type PublicBootstrapJob = v.InferOutput<typeof publicBootstrapJobSchema>

// ---- 2. The environment connection (the ENGINE half) ------------------------

/**
 * How the manifests at `path` are rendered. `raw` (the default) treats the path as a manifest file
 * or a flat directory of valid YAML; `kustomize` treats it as an overlay directory, which only the
 * container-backed deploy adapter can build.
 *
 * A projection of the internal renderer picklist rather than the picklist itself, for the reason
 * the header states: these two Kubernetes shapes are the largest STRUCTURAL surfaces this file
 * publishes, and a renderer the internal adapter grows is a public member only once someone adds it
 * here.
 */
export const publicKubernetesRendererSchema = v.picklist(['raw', 'kustomize'])
export type PublicKubernetesRenderer = v.InferOutput<typeof publicKubernetesRendererSchema>

/**
 * Where a service's per-PR manifests are read from. `colocated` reads them from the service's own
 * repository at the pull request's head; `separate` reads them from another repository, which is
 * where a platform team's manifests usually live.
 */
export const publicKubernetesManifestSourceSchema = v.variant('type', [
  v.object({
    type: v.literal('colocated'),
    /** File or directory path within the pull request's repository. */
    path: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
    /** Omitted ⇒ `raw`. */
    renderer: v.optional(publicKubernetesRendererSchema),
  }),
  v.object({
    type: v.literal('separate'),
    /** `owner/repo` of the manifests repository. */
    repo: v.pipe(v.string(), v.trim(), v.regex(/^[^/\s]+\/[^/\s]+$/, 'must be "owner/repo"')),
    /** Branch, tag or sha to read at; omitted ⇒ that repository's default branch. */
    ref: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
    /** File or directory path within the manifests repository. */
    path: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
    /** Omitted ⇒ `raw`. */
    renderer: v.optional(publicKubernetesRendererSchema),
  }),
])
export type PublicKubernetesManifestSource = v.InferOutput<
  typeof publicKubernetesManifestSourceSchema
>

/**
 * How the environment's URL is derived once the manifests are applied: from a host template the
 * platform renders itself, or by reading the address back off one of four applied objects.
 */
export const publicKubernetesUrlSourceSchema = v.variant('source', [
  v.object({
    source: v.literal('ingressTemplate'),
    /** Host template, e.g. `{{branch}}.preview.example.com`, rendered with the provision vars. */
    hostTemplate: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
    scheme: v.optional(v.picklist(['http', 'https'])),
  }),
  v.object({
    source: v.literal('ingressStatus'),
    /** Ingress to read `.status.loadBalancer` from; omitted ⇒ the only Ingress applied. */
    ingressName: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
    scheme: v.optional(v.picklist(['http', 'https'])),
  }),
  v.object({
    source: v.literal('serviceStatus'),
    /** Service to read `.status.loadBalancer` from. */
    serviceName: v.pipe(v.string(), v.trim(), v.minLength(1)),
    port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535))),
    scheme: v.optional(v.picklist(['http', 'https'])),
  }),
  v.object({
    source: v.literal('gatewayStatus'),
    /** Gateway-API `Gateway` to read `.status.addresses[]` from; omitted ⇒ the only one applied. */
    gatewayName: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
    scheme: v.optional(v.picklist(['http', 'https'])),
  }),
  v.object({
    source: v.literal('httpRouteStatus'),
    /** `HTTPRoute` whose `parentRefs` resolve the address; omitted ⇒ the only one applied. */
    httpRouteName: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
    scheme: v.optional(v.picklist(['http', 'https'])),
  }),
])
export type PublicKubernetesUrlSource = v.InferOutput<typeof publicKubernetesUrlSourceSchema>

/**
 * A Kubernetes cluster the platform provisions per-run environments against.
 *
 * Narrower than the internal engine config on purpose. Left off are the fields that only mean
 * something to a specific execution shape the caller is not choosing here (`rolloutTimeoutSeconds`,
 * belonging to the container deploy adapter; `helmReleases`, a cluster-singleton concern an
 * operator owns). They can be ADDED later as optional fields, which is the additive direction this
 * surface allows; they could never be removed once shipped, which is why they are not here now.
 */
export const publicKubernetesConnectionSchema = v.object({
  /** Human label for the connection, shown wherever the platform names the engine. */
  label: labelField,
  /** kube-apiserver root URL, e.g. `https://cluster.example:6443`. */
  apiServerUrl: v.pipe(v.string(), v.url(), v.maxLength(500)),
  /** PEM CA bundle verifying the apiserver certificate. Omit only for a publicly-trusted CA. */
  caCertPem: v.optional(v.string()),
  /**
   * Skip apiserver TLS verification. Throwaway clusters only, and stated as its own field rather
   * than inferred from an absent CA, so turning verification off is always something a caller
   * asked for in writing.
   */
  insecureSkipTlsVerify: v.optional(v.boolean()),
  /** Namespace template for the per-run environment, e.g. `env-{{pullNumber}}`. */
  namespaceTemplate: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))),
  /** How the environment URL is derived once the manifests are applied. */
  url: publicKubernetesUrlSourceSchema,
  /** Image reference exposed to the manifests as `{{image}}`. */
  imageTemplate: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
  /** Backstop TTL (ms) after which an environment is swept and torn down. */
  defaultTtlMs: v.optional(v.pipe(v.number(), v.minValue(60000))),
  /** Extra labels stamped on the namespace and every applied resource. */
  labels: v.optional(v.record(v.string(), v.string())),
  /** Extra annotations stamped on the namespace. */
  annotations: v.optional(v.record(v.string(), v.string())),
})
export type PublicKubernetesConnection = v.InferOutput<typeof publicKubernetesConnectionSchema>

/**
 * The engine a workspace provisions environments through, discriminated by `engine`.
 *
 * A one-member variant rather than a bare object, which is the whole point: `kubernetes` is the
 * engine that is automatable today, and a second member is an additive enum value the SDKs already
 * tolerate by design. A bare object would have to be RESHAPED to gain a sibling, and reshaping is
 * the thing this surface may not do.
 *
 * The internal engine vocabulary splits Kubernetes in two (`local-k3s` and `remote-kubernetes`,
 * which differ in how the deployment reaches the cluster, not in what a caller supplies). That
 * split is not a public fact, and it is not a public DECISION either: one backend serves both
 * names, both lower to the same provision type and the same config, so a connection made here is
 * registered under the one name the controller states (`remote-kubernetes`) and nothing a run does
 * can observe the difference. A caller describes its cluster; which internal name that is stored
 * under is the platform's business.
 */
export const publicEnvironmentConnectionSchema = v.variant('engine', [
  v.object({ engine: v.literal('kubernetes'), kubernetes: publicKubernetesConnectionSchema }),
])
export type PublicEnvironmentConnection = v.InferOutput<typeof publicEnvironmentConnectionSchema>

/** Probe a candidate connection. Persists nothing, which is the reason it is its own call. */
export const testPublicEnvironmentConnectionSchema = v.object({
  connection: publicEnvironmentConnectionSchema,
  /** Secret bundle the engine authenticates with, e.g. `{ apiToken: '...' }`. */
  secrets: v.optional(v.record(v.string(), v.string())),
})
export type TestPublicEnvironmentConnectionInput = v.InferOutput<
  typeof testPublicEnvironmentConnectionSchema
>

/** The verdict of a probe. `ok: false` is an ANSWER, so it is a 200 rather than an error. */
export const publicEnvironmentConnectionTestSchema = v.object({
  ok: v.boolean(),
  /** What the probe read back, whether it succeeded or not; null when it had nothing to add. */
  message: v.nullable(v.string()),
})
export type PublicEnvironmentConnectionTest = v.InferOutput<
  typeof publicEnvironmentConnectionTestSchema
>

/**
 * Bind a provision type to an engine connection. Idempotent: re-connecting REPLACES, so a caller
 * re-running its own setup converges instead of accumulating handlers or having to delete first.
 */
export const connectPublicEnvironmentSchema = v.object({
  connection: publicEnvironmentConnectionSchema,
  secrets: v.record(v.string(), v.string()),
})
export type ConnectPublicEnvironmentInput = v.InferOutput<typeof connectPublicEnvironmentSchema>

/**
 * A registered connection, as this surface reports it back.
 *
 * `secretKeys` and not the secrets: a caller confirming its own setup needs to know WHICH keys
 * landed, and nothing on a read surface should be able to return a credential value. That holds
 * even though the caller supplied it moments earlier, because the read is repeatable by anyone
 * holding the key afterwards.
 */
export const publicEnvironmentConnectionViewSchema = v.object({
  /** The provision type this connection serves. */
  provisionType: v.string(),
  engine: v.literal('kubernetes'),
  label: v.string(),
  apiServerUrl: v.string(),
  /** The secret-bundle keys this connection holds, never their values. */
  secretKeys: v.array(v.string()),
})
export type PublicEnvironmentConnectionView = v.InferOutput<
  typeof publicEnvironmentConnectionViewSchema
>

// ---- 3. A service's provisioning (the SOURCE half) --------------------------

/**
 * Where ONE service's per-run manifests live: the half the engine connection does not carry.
 *
 * The platform keeps these two apart deliberately (one cluster, many services, each with its own
 * manifests), and this surface keeps the same seam rather than collapsing them into one call, so a
 * caller adding a second service to an existing cluster changes one thing.
 */
export const publicServiceProvisioningSchema = v.variant('type', [
  v.object({ type: v.literal('kubernetes'), manifestSource: publicKubernetesManifestSourceSchema }),
])
export type PublicServiceProvisioning = v.InferOutput<typeof publicServiceProvisioningSchema>

/**
 * Patch a service. Only the supplied fields change, and an omitted `provisioning` LEAVES the stored
 * one alone rather than clearing it: a caller renaming a service must not silently un-deploy it.
 *
 * At least one field is REQUIRED, on the same reading as the bootstrap body above: a patch naming
 * nothing describes no edit, and admitting it would spend a write, a re-read and a board-wide
 * event broadcast on a request whose only possible outcome is the state it started in. The generated
 * clients default the body, so an empty one is a call a caller makes by accident rather than on
 * purpose.
 */
export const updatePublicServiceSchema = v.pipe(
  v.object({
    title: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))),
    description: v.optional(descriptionField),
    provisioning: v.optional(publicServiceProvisioningSchema),
  }),
  v.check(
    (input) =>
      input.title !== undefined ||
      input.description !== undefined ||
      input.provisioning !== undefined,
    'Supply at least one of title, description or provisioning.',
  ),
)
export type UpdatePublicServiceInput = v.InferOutput<typeof updatePublicServiceSchema>

// ---- 4. What this deployment has WIRED --------------------------------------

/**
 * One model in the workspace's catalog, reduced to the question a caller actually has: can a run
 * dispatch to this, and if not, is that because nobody configured it or because a policy refuses it?
 *
 * Those two are separated because they need OPPOSITE fixes, and conflating them is the specific
 * failure this projection exists to prevent: telling an operator to add a provider key when every
 * model is already configured and blocked by their account's model-family policy sends them to
 * change a setting that is already correct.
 */
export const publicWiredModelSchema = v.object({
  modelId: v.string(),
  label: v.string(),
  /** Provider label for the flavour actually in use, e.g. `Cloudflare`, `Bedrock`. */
  provider: v.string(),
  /** Whether a run can dispatch to it right now. */
  available: v.boolean(),
  /** Whether it is unavailable specifically because an account model policy refuses its family. */
  policyBlocked: v.boolean(),
})
export type PublicWiredModel = v.InferOutput<typeof publicWiredModelSchema>

/**
 * The catalog, plus the one thing the catalog itself cannot say.
 *
 * `excludesUserScopedModels` reports that this deployment serves per-user locally-run model
 * endpoints, which a key-authenticated read does not see: they are one developer's own machine, and
 * an API key has no developer, so folding them in would attribute someone else's endpoints to the
 * caller. Without this flag their absence is byte-for-byte "this deployment has nothing wired", and
 * those two need OPPOSITE remedies: the first is a run that must be started by a signed-in user,
 * the second is a provider key. That is the same conflation `policyBlocked` exists to prevent, one
 * level up: a third state, stated rather than collapsed into a false.
 */
export const publicWiredModelListSchema = v.object({
  models: v.array(publicWiredModelSchema),
  /** Whether per-user locally-run endpoints exist here that this read cannot enumerate. */
  excludesUserScopedModels: v.boolean(),
})
export type PublicWiredModelList = v.InferOutput<typeof publicWiredModelListSchema>

/**
 * The workspace's VCS connection, reduced to what it may DO.
 *
 * The two permission flags are the whole reason this is on the surface. Both are refused by the
 * provider at PUSH time rather than at connect time, so a caller that cannot read them discovers a
 * missing `workflows: write` as a repository that bootstrapped and then failed to gain its CI
 * workflow, which reads like a broken bootstrap rather than a missing permission.
 */
export const publicVcsConnectionSchema = v.object({
  provider: vcsProviderSchema,
  /** The account (user or organisation) the workspace is connected to. */
  accountLogin: v.string(),
  /** How the workspace authenticates: an app installation, or a pasted token. */
  method: vcsConnectMethodSchema,
  /** Whether the platform can create repositories under this account itself. */
  canCreateRepos: v.boolean(),
  /** Whether the connection may write `.github/workflows/*`, which a CI gate depends on. */
  canManageWorkflows: v.boolean(),
})
export type PublicVcsConnection = v.InferOutput<typeof publicVcsConnectionSchema>

/**
 * `connection: null` is a real, reportable state (nothing connected), not an absence to 404 on: a
 * caller setting a workspace up asks this question precisely when the answer may be "nothing yet".
 */
export const publicVcsConnectionViewSchema = v.object({
  connection: v.nullable(publicVcsConnectionSchema),
})
export type PublicVcsConnectionView = v.InferOutput<typeof publicVcsConnectionViewSchema>

/**
 * One merge preset, reduced to what decides whether a run can LAND without a person.
 *
 * `dryRunRoles` is projected even though a caller cannot resolve which role its own key runs
 * under: a non-empty list is the difference between "this preset merges" and "this preset merges
 * for everyone except the role you might be", and stating it lets a caller report the caveat
 * rather than assert a verdict it has not earned.
 *
 * `submissionRestrictedRoles` is the SECOND such caveat and rides for the same reason. A preset
 * carries two role-scoped bars on LANDING (ADR 0039's per-role change-class allowlist, enforced at
 * both merge exits, and the dry-run list), and publishing one of them made the other read as
 * absent: `autoMergeEnabled: true` with an empty `dryRunRoles` says "this preset merges" while a
 * role allowlist holds every run outside its classes for a human. What is deliberately NOT here is
 * the per-role narrowing of the score CEILINGS (`classRulesByRole`), on the same line this
 * projection already draws for the ceilings themselves: it decides how much review landing takes,
 * where these two decide whether landing happens at all.
 */
export const publicMergePresetSchema = v.object({
  presetId: v.string(),
  name: v.string(),
  /** Whether a task that pins no preset resolves this one. */
  isDefault: v.boolean(),
  /** The master switch: false holds every pull request for a person. */
  autoMergeEnabled: v.boolean(),
  /** How many times the `ci-fixer` may try to turn CI green before giving up. */
  ciMaxAttempts: v.number(),
  /** Workspace roles whose runs this preset forces into dry-run mode. */
  dryRunRoles: v.array(workspaceRoleSchema),
  /**
   * Workspace roles whose runs may land only the change classes an allowlist names, so a run
   * outside them is held for a person however good its scores are. A role absent from this list is
   * unrestricted; the classes themselves are internal vocabulary and stay off this surface.
   */
  submissionRestrictedRoles: v.array(workspaceRoleSchema),
})
export type PublicMergePreset = v.InferOutput<typeof publicMergePresetSchema>

export const publicMergePresetListSchema = v.object({ presets: v.array(publicMergePresetSchema) })
export type PublicMergePresetList = v.InferOutput<typeof publicMergePresetListSchema>

/**
 * One model preset: which model a task pinning it runs its agent steps on.
 *
 * Published so a caller can PICK one by id rather than guess at it, which is the same reason the
 * pipeline list exists beside a `start` that takes a `pipelineId`. The ids are the workspace's own
 * (`mdp_*` for the built-ins), so a caller reads them here rather than hard-coding a vocabulary
 * this surface would then owe forever.
 *
 * **Availability is deliberately NOT here.** Whether a preset's model can actually be dispatched to
 * is a fact about wiring and account policy, and `GET /api/v1/models` already answers it with the
 * two causes kept apart (unconfigured, versus refused by the account model-family policy) because
 * they need opposite fixes. Repeating a derived yes/no here would be a second place to keep honest,
 * and the first one to go stale. Join on `baseModelId`.
 */
export const publicModelPresetSchema = v.object({
  presetId: v.string(),
  name: v.string(),
  /** Whether a task that pins no preset resolves this one. */
  isDefault: v.boolean(),
  /** The model every agent kind runs on under this preset, unless overridden below. */
  baseModelId: v.string(),
  /**
   * Per-agent-kind model overrides on top of the base, keyed by agent kind.
   *
   * Published because a preset is not always uniform, and a caller choosing between two of them is
   * choosing what the CODER runs on more than what the base is. The keys are an open set (a
   * deployment's custom agent kinds appear here too), so a reader matches what it knows and ignores
   * the rest rather than switching exhaustively.
   */
  overrides: v.record(v.string(), v.string()),
})
export type PublicModelPreset = v.InferOutput<typeof publicModelPresetSchema>

export const publicModelPresetListSchema = v.object({ presets: v.array(publicModelPresetSchema) })
export type PublicModelPresetList = v.InferOutput<typeof publicModelPresetListSchema>
