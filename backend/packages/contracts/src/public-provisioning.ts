import * as v from 'valibot'
import { frameRepoTypeSchema } from './primitives.js'
import { stepSubtasksSchema } from './execution.js'
import { bootstrapStatusSchema } from './bootstrap.js'
import { agentFailureKindSchema } from './agent-failure-kinds.js'
import { runAutonomySchema } from './merge.js'
import { vcsProviderSchema } from './routes/auth.js'
import { vcsConnectMethodSchema } from './routes/vcs.js'
import { workspaceRoleSchema } from './workspace-members.js'

// ---------------------------------------------------------------------------
// DEPLOYMENT PROVISIONING on `/api/v1`: what a headless caller needs to bring a workspace from
// "connected" to "able to run a pipeline", which until now had no public counterpart at all.
//
// Five groups, and they are five because each answers a different question a caller asks BEFORE it
// has anything to file work against: make me a repository; ADOPT one that already exists; connect me
// to the infrastructure a run deploys onto; tell one service where its manifests live; and tell me
// what this deployment has actually wired.
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
// `workspaceRole`, `runAutonomy` and the three counters of `stepSubtasks` are imported and used as
// they are. A
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
/**
 * A repository OWNER, which is a slug on GitHub and a `/`-separated namespace PATH on GitLab.
 *
 * Separate from {@link slugField} because a GitLab project can live under nested groups, and its
 * owner is then `group/subgroup`: the value the available-repos read publishes and the one a caller
 * feeds straight back into the adopt. Refusing the slash there made a nested-group project
 * unadoptable through this surface at all, with no id-taking alternative to fall back on.
 *
 * Still segment-by-segment the same character set, and no empty segment, so it stays a name rather
 * than a path expression: no `.` or `..` segment, no leading, trailing or doubled separator.
 */
const repoOwnerField = v.pipe(
  v.string(),
  v.trim(),
  v.regex(
    /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/,
    "Only letters, digits, '.', '_', '-' and '/' between segments are allowed",
  ),
  v.check(
    (value) => !value.split('/').some((segment) => segment === '.' || segment === '..'),
    "No path segment may be '.' or '..'",
  ),
  v.minLength(1),
  v.maxLength(255),
)
/**
 * A custom-manifest-type id, as this surface accepts it.
 *
 * Restated rather than importing `manifestIdSchema`, which is this file's rule for a STRUCTURAL
 * shape: the internal one is a format this repo may tighten freely, and a tightening inherited here
 * would refuse a value a live integration is already pinning, which is a break nobody reviewed as
 * one. The two grammars are meant to agree, so `public-provisioning.test.ts` pins that they do.
 */
const publicManifestIdSchema = v.pipe(
  v.string(),
  v.trim(),
  v.regex(/^[a-z0-9][a-z0-9-]*$/, 'Only lowercase letters, digits and hyphens are allowed'),
  v.minLength(1),
  v.maxLength(64),
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

// ---- 2. Adopting a repository that already exists ---------------------------
//
// The other half of "give me something to file work against", and the half that was missing: a
// caller could make a NEW repository here (section 1) but could not adopt one it already had.
//
// The gap is not obvious from `GET /api/v1/repos`, and that is the point. That read serves the
// repositories this workspace has LINKED, which is a set someone assembles in the app: repositories
// are linked explicitly per workspace, the provider webhook for an added repository does not project
// one, and a resync refreshes what is already linked rather than rediscovering the installation. So a
// repository the connection can reach perfectly well is absent from every public read until a human
// opens the picker, and `POST /api/v1/services` answers 404 for its `repoId`, which is
// indistinguishable from a repository that does not exist. These two operations close that:
// {@link publicAvailableRepoSchema} is what the connection can REACH, and
// {@link linkPublicRepoSchema} adopts one by name.

/**
 * A repository the workspace's connection can reach, whether or not this workspace links it yet.
 *
 * The discovery read for adoption, and a superset of {@link publicRepoSchema}'s population by
 * design: that one lists what is linked (so every row carries a `repoId` a service can be created
 * against), this one lists what COULD be. `linked` is the join between them.
 *
 * A small projection, like every other shape here: enough to recognise a repository, decide whether
 * to adopt it, and name it in the adopt call. It carries `serviceId` and `linkedElsewhere` for the
 * same reason `GET /api/v1/repos` does, and derived by the same account-scoped judgement: whether a
 * repository is SPOKEN FOR is the question a caller asks immediately after "can I reach it", and the
 * answer does not depend on this workspace having linked it. A repository already backing a service
 * on another board of the account is unusable here, so a discovery read that could not say so would
 * green-light an adopt whose next call fails.
 */
export const publicAvailableRepoSchema = v.object({
  /** The provider's id for the repo, as `GET /api/v1/repos` reports it once linked. */
  repoId: v.number(),
  provider: vcsProviderSchema,
  owner: v.string(),
  name: v.string(),
  /** The branch a run would base its work on. Empty when the provider reports none. */
  defaultBranch: v.string(),
  private: v.boolean(),
  /** Whether THIS workspace already links it, i.e. whether it appears in `GET /api/v1/repos`. */
  linked: v.boolean(),
  /**
   * Whether it is flagged as hosting several services.
   *
   * A board-owned flag carried on the linked projection, so an unlinked repository answers false
   * because nobody has flagged it, not because it was examined. `linked` is what says which of the
   * two this is.
   */
  monorepo: v.boolean(),
  /**
   * The service on THIS board that the repository already backs, or null.
   *
   * Null means "no service here holds it", which is not the same as free: read it with
   * `linkedElsewhere`, exactly as on `GET /api/v1/repos`.
   */
  serviceId: v.nullable(v.string()),
  /**
   * True when a service homed on ANOTHER board of this account already backs it, so
   * `POST /api/v1/services` will refuse it here.
   *
   * That service's id is withheld rather than reported, because it names a block this key cannot
   * read. The flag is what stops the withholding reading as availability.
   */
  linkedElsewhere: v.boolean(),
  /**
   * True when it is reachable only through the SIGNED-IN USER's own token rather than the
   * workspace's connection.
   *
   * Always false on this surface, and published rather than omitted because it is the one field that
   * says why a repository a person can see in the app may be missing here: an API key authenticates
   * as the workspace, so a repository only somebody's personal token reaches is not reachable by a
   * key at all. A caller comparing this list against what a colleague sees needs that stated.
   */
  personal: v.boolean(),
})
export type PublicAvailableRepo = v.InferOutput<typeof publicAvailableRepoSchema>

export const publicAvailableRepoListSchema = v.object({
  repos: v.array(publicAvailableRepoSchema),
  /**
   * True when a provider read behind this list stopped at a cap, so repositories the connection can
   * reach are missing from `repos`.
   *
   * Published because an absent row is the one observation this read exists to make actionable, and
   * a capped browse produces an absent row for a repository that exists, is reachable, and would
   * link fine. Without this flag those two are the same answer, and a caller told "one that does not
   * exist appears in neither read" would conclude the wrong one.
   *
   * A point-read (`q=owner/name`) is never truncated: it resolves the exact slug directly, which is
   * why it is the authoritative way to ask about ONE repository, and why a truncated browse is a
   * reason to narrow the query rather than to give up.
   */
  truncated: v.boolean(),
})
export type PublicAvailableRepoList = v.InferOutput<typeof publicAvailableRepoListSchema>

/**
 * Adopt a repository into this workspace, by name.
 *
 * By NAME rather than by the `repoId` its sibling reads report, and that asymmetry is deliberate: a
 * caller setting a workspace up from configuration knows `owner/name` (a person typed it, or a
 * template holds it) and cannot know a provider's numeric id for a repository no public read lists.
 * Taking the name makes this one call sufficient, so a headless setup never has to search first, and
 * the response carries the `repoId` for the `POST /api/v1/services` call that follows.
 *
 * The owner is required rather than defaulted to the connected account, because an installation can
 * reach several owners and a request that guessed one would silently adopt a look-alike.
 */
export const linkPublicRepoSchema = v.object({
  /**
   * The account the repository lives under, exactly as `GET /api/v1/repos/available` reports it:
   * a user or organisation on GitHub, and on GitLab a namespace PATH, which may name a group and
   * its subgroups (`group/subgroup`).
   */
  owner: repoOwnerField,
  /** The repository's name, matched case-insensitively as both providers treat it. */
  name: slugField,
})
export type LinkPublicRepoInput = v.InferOutput<typeof linkPublicRepoSchema>

/**
 * Characters ONE file read may answer with, past which it is REFUSED rather than truncated.
 *
 * A caller reading a file to grade what an agent committed is joining on its exact bytes, and a
 * silently shortened answer is indistinguishable from an agent that wrote a shorter file. So the
 * cap refuses (`413`, `details.reason: 'file_too_large'`) and names the size, which is a fact the
 * caller can act on where a truncation is not. Generous enough for source: 256 KiB is past any
 * hand-written manifest, workflow or module.
 */
export const MAX_REPO_FILE_CHARS = 262_144

/**
 * A repo-root-relative file path, refused here rather than left to the provider's 404.
 *
 * The provider would answer "no such file" for a traversal or an absolute path anyway, so this is
 * not a security boundary and does not claim to be one: the resolution is already scoped to a
 * repository this workspace LINKED, which is what actually bounds the read. What it buys is an
 * honest refusal. `..` and a leading `/` are the two ways a caller means something other than what
 * it typed, and answering both as `file_not_found` sends someone hunting for a file that is right
 * where they left it.
 */
export const publicRepoFilePathSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(1000),
  v.check((value) => !value.startsWith('/'), 'A path is relative to the repository root'),
  v.check((value) => !value.split('/').includes('..'), "No path segment may be '..'"),
)

/**
 * ONE file from a repository this workspace has LINKED, at a ref.
 *
 * The read that closes the loop on everything else this surface can start: a caller can create a
 * repository, adopt one, file work against it and watch a run merge, and then had no way to see WHAT
 * the run committed. The only alternative was grepping the agent's final reply, which is asserting on
 * model prose (swap the model and it goes red having found nothing wrong), so anything that wanted a
 * real answer had to hold a VCS credential of its own: a second token in an operator's config, with
 * its own scopes to get right, for data the workspace's own connection can already read.
 *
 * **A single file, deliberately, and no directory listing.** A listing is a separate decision with
 * its own frozen-forever questions (pagination, recursion, what a large tree does), and this surface
 * may not answer one badly and then keep answering it. `GET /api/v1/services/:id/spec` remains the
 * structured read for the one tree the platform itself understands.
 *
 * **Only what the workspace has LINKED.** The scope is the same one every other read here takes, so
 * this publishes nothing a caller could not already reach through the board, and a repository the
 * connection can see but this workspace has not adopted is a `404` exactly as it is everywhere else.
 */
export const publicRepoFileSchema = v.object({
  owner: v.string(),
  name: v.string(),
  /** The repo-root-relative path that was read, as the request gave it. */
  path: v.string(),
  /**
   * The ref the read resolved against: the requested one, or the repository's default branch when
   * the request named none. Stated rather than echoed, so a caller can record what it graded.
   */
  ref: v.string(),
  /** The file's blob sha, for a caller comparing two reads without diffing their bodies. */
  sha: v.string(),
  /** The file's decoded UTF-8 content. */
  content: v.string(),
})
export type PublicRepoFile = v.InferOutput<typeof publicRepoFileSchema>

// ---- 3. The environment connection (the ENGINE half) ------------------------

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
    /**
     * Host port the ingress controller answers on, when it is not the scheme's default. Kept out
     * of `hostTemplate` because the rendered template is also the Ingress `host` the manifests
     * declare, and a Kubernetes `host` may not carry a port.
     */
    port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535))),
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

/**
 * One registered handler as the LIST reports it, whatever engine services it.
 *
 * Its own shape rather than a reuse of {@link publicEnvironmentConnectionViewSchema}, and the reason
 * is the difference between the two calls. That one answers a `POST` this surface only ever makes
 * with `engine: 'kubernetes'`, so its literal is exactly true. A list has to report every handler a
 * workspace holds, including the `remote-custom` ones a deployment SEEDS from its composition root,
 * and widening the shipped literal to a string would retype a field a released client already
 * narrows on. Additive beats a retype (ADR 0034), so the list gets its own view.
 *
 * `endpoint` and not `apiServerUrl`: the noun is only true of Kubernetes, and the same mistake in a
 * shared reduction is what makes an operator whose environment is a VM go looking for an apiserver.
 *
 * The write is what makes this read worth having. Handlers are the one half of provisioning a
 * headless caller could WRITE and never READ, so a deployment that seeds them programmatically (the
 * documented path for a multi-tenant Node deployment, and the one local mode takes) had no way for
 * any caller to confirm the seed landed. "Kargo accepts our token" and "this workspace has a Kargo
 * handler" are different failures with different fixes, and only one of them was checkable.
 */
export const publicEnvironmentHandlerSchema = v.object({
  /** The provision type this handler serves (`kubernetes`, `docker-compose`, `custom`, …). */
  provisionType: v.string(),
  /** For a `custom` handler, the manifest id it declares it ACCEPTS; null for every other type. */
  acceptsManifestId: v.nullable(v.string()),
  /** The internal engine servicing it, as an open string: a deployment may register its own. */
  engine: v.string(),
  /** The registry backend kind that builds this handler's provider. */
  backendKind: v.string(),
  label: v.string(),
  /** The connection's own endpoint (an apiserver for Kubernetes, the management API otherwise). */
  endpoint: v.string(),
  /** The secret-bundle keys this handler holds, never their values. */
  secretKeys: v.array(v.string()),
  connectedAt: v.number(),
})
export type PublicEnvironmentHandler = v.InferOutput<typeof publicEnvironmentHandlerSchema>

export const publicEnvironmentHandlerListSchema = v.object({
  connections: v.array(publicEnvironmentHandlerSchema),
})
export type PublicEnvironmentHandlerList = v.InferOutput<typeof publicEnvironmentHandlerListSchema>

// ---- 4. A service's provisioning (the SOURCE half) --------------------------

/**
 * Where ONE service's per-run manifests live: the half the engine connection does not carry.
 *
 * The platform keeps these two apart deliberately (one cluster, many services, each with its own
 * manifests), and this surface keeps the same seam rather than collapsing them into one call, so a
 * caller adding a second service to an existing cluster changes one thing.
 *
 * **`custom` is here because a deployment that ships its OWN environment backend could not say so.**
 * The registry model exists precisely so one can (`EnvironmentBackendRegistry`,
 * `CustomManifestTypeRegistry`, `seedEnvironmentHandlers`), and everything such a backend needs is
 * reachable from a composition root; none of it was reachable from this surface. A Kargo-backed or
 * Nomad-backed service could therefore neither be pinned nor READ BACK here, and that second half is
 * the one that hurts: the projection omitted what it could not describe, so a pinned service and an
 * unpinned one answered identically (`provisioning: undefined`) and a headless caller could not
 * report the state, let alone check it.
 *
 * **It pins by `manifestId` and carries no backend config**, and that is deliberate rather than
 * partial. The engine side of a custom backend is an `environmentManifest` whose `providerConfig` is
 * an open `Record<string, unknown>` by design, so publishing it would freeze a shape this repo
 * evolves freely onto a surface that may never be reshaped (ADR 0034). What a caller pins here is an
 * id the DEPLOYMENT already registered, which is a closed, stable value; registering the handler
 * behind it stays a composition-root act, and `GET /api/v1/environments/connections` is how a caller
 * confirms one landed.
 */
export const publicServiceProvisioningSchema = v.variant('type', [
  v.object({ type: v.literal('kubernetes'), manifestSource: publicKubernetesManifestSourceSchema }),
  v.object({
    type: v.literal('custom'),
    /**
     * The custom-manifest-type id this service produces, matched to a `remote-custom` handler that
     * declares it accepts the same one.
     */
    manifestId: publicManifestIdSchema,
    /** Where the manifest lives in the repository; omitted ⇒ the manifest type's own default. */
    manifestPath: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
  }),
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

// ---- 5. What this deployment has WIRED --------------------------------------

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
  /**
   * Whether this model can be authenticated by a credential belonging to a PERSON rather than to
   * the workspace: it runs on a subscription vendor, and any member may hold their own personal
   * subscription for one.
   *
   * It is the row-level half of `excludesUserScopedModels`, and it is what makes an `available:
   * false` here READABLE. A key that resolves no user consults no personal store, so for such a
   * model "false" means "nobody's credential was consulted", which is a different fact from "no
   * provider is wired" and takes the opposite remedy: bind a key to the subscription owner (or
   * start the run from the app) rather than add a provider key. A caller cannot derive this from
   * the rest of the row, which is why it is stated rather than left to be inferred from a label.
   *
   * SUPERSEDED by `personalSubscription`, and kept answering exactly as it always has: the
   * subscription route is the one IN FORCE for this model. That reading has two faults this field
   * cannot be corrected for without breaking a caller already branching on it. It is true of a
   * POOLABLE vendor, whose token belongs to the workspace and which any key can therefore see; and
   * it is false of a model that merely DECLARES a subscription beside a metered gateway, which is
   * what `claude-opus` resolves to on a deployment with nothing configured. `personalSubscription`
   * answers both correctly. Prefer it; this field will be removed in a future major version.
   */
  userScoped: v.boolean(),
  /**
   * Whether this model runs on a credential that belongs to a PERSON: it declares a subscription
   * route whose vendor is licensed for individual use only (Claude, Codex, GLM), so the credential
   * is stored per user and no key that resolves no user can see it.
   *
   * Read off what the model DECLARES rather than off the route in force. A model reachable both by
   * subscription and by a metered gateway resolves, with nothing configured, to the gateway, so
   * reading the route in force reports the commonest personal credential of all (`claude-opus` on
   * a Claude subscription) as plainly unwired.
   *
   * A POOLABLE vendor is deliberately NOT included, and that is the other half of the correction.
   * Its token is held by the WORKSPACE, so a system token can see it and no identity is missing:
   * reporting such a model as personal sends an operator to re-mint a key when the fix is a pooled
   * token or a provider key.
   */
  personalSubscription: v.boolean(),
  /**
   * Whether a personal subscription for this model's vendor IS stored for the person this key
   * belongs to: its `actsAsUserId` when bound, else its minter. `null` when the question was not
   * answered at all: there is no such person (a key provisioned headlessly through
   * `POST /api/v1/keys`), the deployment stores no personal subscriptions, or the row is not
   * `personalSubscription` and so has no vendor to ask about. `null` is NOT `false` and must not be
   * read as one: "nobody was asked" and "asked, and there is none" send an operator to different
   * screens.
   *
   * Only ever a statement about EXISTENCE, which is a row lookup: opening the credential needs the
   * owner's personal password, and nothing here holds or wants one. That is what lets a system
   * token be told the truth about a model it cannot run: `available: false` with
   * `subscriptionConfigured: true` means the subscription is there and this token is not bound to
   * it, so the remedy is to mint a personal key rather than to wire a provider.
   *
   * DISCLOSURE, stated because it is a deliberate trade rather than an oversight. When the key is
   * unbound the person asked about is its MINTER, who need not be whoever holds the key: an
   * `admin`-scoped key handed to CI or to a contractor learns one bit (a live personal subscription
   * for this vendor exists / does not) about a named colleague, and about one who has since left
   * the workspace too, since provenance is never re-validated against current membership. What
   * contains it is that the bit is EXISTENCE only, never the person, never the vendor account and
   * never the credential, and that the route floors at `admin` scope. The alternative, reporting
   * for the workspace's members at large, is strictly more leakage for the same remedy.
   */
  subscriptionConfigured: v.nullable(v.boolean()),
})
export type PublicWiredModel = v.InferOutput<typeof publicWiredModelSchema>

/**
 * The catalog, plus the one thing the catalog itself cannot say.
 *
 * `excludesUserScopedModels` reports that this deployment serves per-user locally-run model
 * endpoints which THIS read could not enumerate: they are one developer's own machine, so a read
 * that resolved no user (an unbound key) cannot fold them in without attributing someone else's
 * endpoints to the caller. Without the flag their absence is byte-for-byte "this deployment has
 * nothing wired", and those two need OPPOSITE remedies: the first is a run started by (or a key
 * bound to) the person whose machine serves them, the second is a provider key. That is the same
 * conflation `policyBlocked` exists to prevent, one level up: a third state, stated rather than
 * collapsed into a false.
 *
 * It answers for the models this read OMITS. The ones it lists but could not run are the row-level
 * `personalSubscription` / `subscriptionConfigured` pair's job, and the split is deliberate: a personal
 * subscription's model IS in this catalog (as unavailable), so reporting it here would say
 * "something is missing" about an entry the caller can see, while saying nothing about WHICH. A
 * caller diagnosing one model wants the row; a caller deciding whether the whole answer is complete
 * wants the flag.
 */
export const publicWiredModelListSchema = v.object({
  models: v.array(publicWiredModelSchema),
  /** Whether per-user locally-run endpoints exist here that this read could not enumerate. */
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
 * One risk policy, reduced to what decides whether a run can LAND without a person.
 *
 * **The name is the product's**, and it is broader than merging on purpose: one policy row also
 * caps CI-fixer attempts, requirement and tester iteration rounds, judge scores and the
 * release-health watch window. This surface first shipped it as a "merge preset", which was the
 * name the platform had already moved off, and the id a caller reads here is the one it pins as
 * `riskPolicyId` on task create, so the two spellings met on one wire. See
 * `backend/docs/public-api-versions.md` for why the correction is a rename rather than a
 * dual-served migration.
 *
 * `dryRunRoles` is projected even though a caller cannot resolve which role its own key runs
 * under: a non-empty list is the difference between "this policy merges" and "this policy merges
 * for everyone except the role you might be", and stating it lets a caller report the caveat
 * rather than assert a verdict it has not earned.
 *
 * `submissionRestrictedRoles` is the SECOND such caveat and rides for the same reason. A policy
 * carries two role-scoped bars on LANDING (ADR 0039's per-role change-class allowlist, enforced at
 * both merge exits, and the dry-run list), and publishing one of them made the other read as
 * absent: `autoMergeEnabled: true` with an empty `dryRunRoles` says "this policy merges" while a
 * role allowlist holds every run outside its classes for a human. What is deliberately NOT here is
 * the per-role narrowing of the score CEILINGS (`classRulesByRole`), on the same line this
 * projection already draws for the ceilings themselves: it decides how much review landing takes,
 * where these two decide whether landing happens at all.
 */
export const publicRiskPolicySchema = v.object({
  policyId: v.string(),
  name: v.string(),
  /** Whether a task that pins no policy resolves this one when a person starts it IN THE APP. */
  isDefault: v.boolean(),
  /**
   * Whether a task that pins no policy resolves this one when NOTHING is watching the run: every
   * start through this API, a tracker dispatch, a schedule fire.
   *
   * The field a caller of this API actually wants, and the reason `isDefault` alone could not stay
   * the whole answer: a workspace holds one default per scope, and the runs a key starts are
   * governed by this one. A single row may hold both flags.
   */
  isUnattendedDefault: v.boolean(),
  /**
   * Whether a run under this policy ANSWERS the parks its own automatic loops raise when they give
   * up (a companion at its rework cap, an iterative review at its pass cap, untriaged follow-ups),
   * or stops for a person: `attended` | `unattended`.
   *
   * Published because it decides whether a headless caller can expect a run to reach a terminal
   * state on its own. Under `attended` a run can park on a decision this API can list but only a
   * judgement call can settle, and a caller with nobody to escalate to waits forever. It never
   * covers a gate the PIPELINE asked for: a human-test step, a review gate or an approval gate
   * stops the run under either value.
   */
  autonomy: runAutonomySchema,
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
export type PublicRiskPolicy = v.InferOutput<typeof publicRiskPolicySchema>

export const publicRiskPolicyListSchema = v.object({ policies: v.array(publicRiskPolicySchema) })
export type PublicRiskPolicyList = v.InferOutput<typeof publicRiskPolicyListSchema>

/**
 * One model preset: which model a task pinning it runs its agent steps on.
 *
 * Published so a caller can PICK one by id rather than guess at it, which is the same reason the
 * pipeline list exists beside a `start` that takes a `pipelineId`. The ids are the workspace's own
 * (`mdp_*` for the built-ins), so a caller reads them here rather than hard-coding a vocabulary
 * this surface would then owe forever. A caller pins what it reads here as `modelPresetId`, the
 * same word: unlike the risk-policy list beside it, this one is a preset all the way down.
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

// ---- the workspace's tracker WRITEBACK disposition ----------------------------

/**
 * What the platform does to a task's linked tracker issue as its pull request progresses.
 *
 * Three independent actions rather than one switch, because they are answerable separately: a
 * workspace can want the merge recorded on the ticket without wanting a parked review's questions
 * asked there. Each is `true`/`false` here and not the internal `'on' | 'off'` override vocabulary,
 * which belongs to the PER-TASK field this setting is the default for.
 *
 * The names drop the internal `writeback` prefix, which the nesting already says.
 */
export const publicTrackerWritebackSchema = v.object({
  /** Comment on the linked issue when a task's pull request opens. */
  commentOnPrOpen: v.boolean(),
  /** Comment and CLOSE the linked issue when the pull request merges. */
  resolveOnMerge: v.boolean(),
  /**
   * Post a headless run's parked requirements-review findings on the linked issue, so the
   * reporter can answer where they filed. Only consulted for runs started through this API or
   * dispatched from a ticket (`backend/docs/adr/0047-headless-clarification-loop.md`).
   */
  questionsOnPark: v.boolean(),
})
export type PublicTrackerWriteback = v.InferOutput<typeof publicTrackerWritebackSchema>

/**
 * The workspace's writeback disposition, and whether anyone has ever chosen it.
 *
 * **Writeback only, deliberately, though the row it reads holds more.** The rest of
 * `tracker_settings` is the FILING selection (which tracker the tech-debt recurring pipeline raises
 * its ticket on, plus that vendor's target: a Jira project key, a Linear team). That is a different
 * decision with its own cross-field rules, and it is not what writeback keys off: the writeback
 * follows each LINKED issue's own source, so a workspace with no filing tracker selected still
 * writes back to the GitHub issue a task was filed from. Publishing the two together would invite
 * exactly the misreading that one gates the other. The filing half can be added here later, which
 * is why the path is `/tracker/writeback` under a `tracker` group rather than the whole row.
 */
export const publicTrackerWritebackSettingsSchema = v.object({
  writeback: publicTrackerWritebackSchema,
  /**
   * When the workspace last saved its writeback disposition, or NULL when it never has, in which
   * case the values above are this deployment's defaults rather than anyone's choice.
   *
   * Null rather than a `0`, which is what the internal read spells an absent row as: an epoch
   * timestamp is a value a caller can format, print and compare, and every one of those reads as a
   * setting saved in 1970 rather than as one nobody has touched.
   */
  updatedAt: v.nullable(v.number()),
})
export type PublicTrackerWritebackSettings = v.InferOutput<
  typeof publicTrackerWritebackSettingsSchema
>

/**
 * Change one or more writeback actions, leaving the rest as they are.
 *
 * A genuine PATCH, unlike the internal `PUT /tracker-settings` it writes through, which replaces
 * the row wholesale and resets an omitted flag to the default. The SPA's panel can send all three
 * every time because it has just rendered all three; a caller here is acting on one decision, and a
 * merge is the only semantics under which doing so cannot silently move the other two.
 *
 * An empty patch is a harmless no-op, exactly as it is on task update.
 */
export const updatePublicTrackerWritebackSchema = v.object({
  writeback: v.optional(
    v.object({
      commentOnPrOpen: v.optional(v.boolean()),
      resolveOnMerge: v.optional(v.boolean()),
      questionsOnPark: v.optional(v.boolean()),
    }),
  ),
})
export type UpdatePublicTrackerWritebackInput = v.InferOutput<
  typeof updatePublicTrackerWritebackSchema
>
