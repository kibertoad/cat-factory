import * as v from 'valibot'
import {
  customBackendKindSchema,
  environmentSecretRefSchema,
  nonEmpty,
  urlString,
} from './primitives.js'
import { environmentReachabilitySchema } from './environment-reachability.js'
import { stackRecipeSchema } from './stack-recipes.js'
import {
  eksProvisionConfigSchema,
  kubernetesHelmReleaseSchema,
  kubernetesImageOverrideSchema,
  kubernetesManifestSourceSchema,
  kubernetesProvisionConfigSchema,
  kubernetesRendererSchema,
  kubernetesSecretInjectionSchema,
  kubernetesUrlSourceSchema,
} from './environments-kubernetes.js'

// ---------------------------------------------------------------------------
// Ephemeral environment provider wire contracts. Every organization rolls its
// own preview/ephemeral-env tooling with bespoke internal auth, so rather than
// integrating against a fixed SaaS we let an org describe its *own* HTTP-based
// management API declaratively: a manifest of request templates for
// provision/status/teardown, the auth scheme for calling it, and a mapping from
// that API's (arbitrary) response shape onto a canonical environment handle.
//
// A single generic adapter in the worker interprets any manifest — there are no
// per-provider presets and no per-org code. After a "deployer" step provisions
// an environment, the resulting handle is surfaced to downstream tester agents
// so they can run against the live URL.
//
// Secret handling: the manifest references credentials by *logical key* only —
// never values. The actual per-tenant secret values are supplied separately at
// registration, stored encrypted-at-rest in D1, and resolved in-memory at call
// time. Nothing here ever carries a raw secret on the wire.
// ---------------------------------------------------------------------------

/**
 * How the worker authenticates to the org's *management* API (the one we call to
 * provision/status/teardown). Covers the common schemes; each references its
 * secret(s) by logical key.
 */
export const environmentAuthSchemeSchema = v.variant('type', [
  v.object({ type: v.literal('none') }),
  v.object({
    type: v.literal('api_key'),
    headerName: nonEmpty,
    secretRef: environmentSecretRefSchema,
    /** Optional prefix prepended to the secret value, e.g. `Token `. */
    valuePrefix: v.optional(v.string()),
  }),
  v.object({ type: v.literal('bearer'), secretRef: environmentSecretRefSchema }),
  v.object({
    type: v.literal('basic'),
    usernameSecretRef: environmentSecretRefSchema,
    passwordSecretRef: environmentSecretRefSchema,
  }),
  v.object({
    type: v.literal('oauth2_client_credentials'),
    tokenUrl: urlString,
    clientIdSecretRef: environmentSecretRefSchema,
    clientSecretSecretRef: environmentSecretRefSchema,
    scope: v.optional(v.string()),
    audience: v.optional(v.string()),
  }),
  v.object({
    type: v.literal('custom_headers'),
    headers: v.array(v.object({ name: nonEmpty, secretRef: environmentSecretRefSchema })),
  }),
])
export type EnvironmentAuthScheme = v.InferOutput<typeof environmentAuthSchemeSchema>

export const environmentHttpMethodSchema = v.picklist(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
export type EnvironmentHttpMethod = v.InferOutput<typeof environmentHttpMethodSchema>

/**
 * One HTTP call against the management API. Fully generic: any method, an
 * arbitrary path appended to the manifest `baseUrl`, optional query/headers and
 * a body, all supporting `{{var}}` interpolation. Variables come from a bounded
 * namespace: `{{input.*}}` (provision inputs) and `{{provision.*}}` (fields
 * extracted from an earlier provision response, available to status/teardown).
 */
export const environmentRequestTemplateSchema = v.object({
  method: environmentHttpMethodSchema,
  pathTemplate: v.pipe(v.string(), v.maxLength(2000)),
  query: v.optional(v.array(v.object({ key: v.string(), value: v.string() }))),
  headers: v.optional(v.array(v.object({ name: nonEmpty, value: v.string() }))),
  bodyTemplate: v.optional(v.string()),
  /** Per-call timeout (ms). Bounded; defaults applied by the adapter. */
  timeoutMs: v.optional(v.pipe(v.number(), v.minValue(1), v.maxValue(60000))),
})
export type EnvironmentRequestTemplate = v.InferOutput<typeof environmentRequestTemplateSchema>

/** The lifecycle states a provisioned environment moves through. */
export const environmentStatusSchema = v.picklist([
  'provisioning',
  'ready',
  'failed',
  'expired',
  'tearing_down',
  'torn_down',
])
export type EnvironmentStatus = v.InferOutput<typeof environmentStatusSchema>

/**
 * What an INDEPENDENT probe found after a teardown call succeeded — the difference between
 * "the provider accepted the destroy request" and "the environment is gone".
 *
 * The two are routinely not the same thing, which is why this exists as a computed observation
 * rather than a boolean read off the teardown call's own return value. A manifest-driven
 * provider whose manifest declares no `teardown:` template destroys nothing and reports
 * `torn_down`; a Kubernetes namespace `DELETE` returns immediately while the namespace sits in
 * `Terminating` for however long its finalizers take. Recording either as a reclaimed
 * environment is how a still-running, still-billing environment comes to be reported as torn
 * down on a pull request.
 *
 * The four are kept apart because each is a different person's problem:
 *  - `confirmed`:     the probe says the environment is gone. The only state that proves it.
 *  - `still_standing`: the probe says it is STILL THERE. The teardown was a no-op (typically a
 *                       manifest with no `teardown:` template) and somebody has to reclaim it
 *                       AND fix the provider config, or every future run leaks one too.
 *  - `unverifiable`:   the provider offers no way to check (its probe is not implemented, or it
 *                       cannot describe a resource that no longer exists). A CONFIGURATION
 *                       fact, unchanged between runs, and not something a retry fixes.
 *  - `unconfirmed`:    the probe ran and could not settle the question — it errored, or the
 *                       resource is mid-`Terminating`. TRANSIENT: the TTL sweep re-probes, and
 *                       the answer may well be `confirmed` next pass.
 */
export const teardownConfirmationSchema = v.picklist([
  'confirmed',
  'still_standing',
  'unverifiable',
  'unconfirmed',
])
export type TeardownConfirmation = v.InferOutput<typeof teardownConfirmationSchema>

export const environmentAccessSchemeSchema = v.picklist([
  'none',
  'bearer',
  'basic',
  'custom_header',
])
export type EnvironmentAccessScheme = v.InferOutput<typeof environmentAccessSchemeSchema>

/**
 * How to read the *provisioned environment's own* access credentials out of the
 * management API's response. These are per-environment, ephemeral creds the
 * tester uses to reach the env — distinct from the management-API auth above.
 */
export const environmentAccessMappingSchema = v.object({
  scheme: environmentAccessSchemeSchema,
  tokenPath: v.optional(v.string()),
  usernamePath: v.optional(v.string()),
  passwordPath: v.optional(v.string()),
  headerName: v.optional(v.string()),
  headerValuePath: v.optional(v.string()),
})
export type EnvironmentAccessMapping = v.InferOutput<typeof environmentAccessMappingSchema>

/**
 * Maps an arbitrary self-rolled response onto the canonical handle via dot-path
 * field extraction (e.g. `data.url`). `statusMap` translates the provider's own
 * status strings onto our lifecycle states.
 */
export const environmentResponseMappingSchema = v.object({
  urlPath: v.optional(v.string()),
  /**
   * Where the response states the ADDRESSES that carry traffic for `urlPath`'s host: a string, or
   * an array of strings, or an array of `{ address, label }` objects.
   *
   * The half of addressing a URL cannot express. An org whose per-environment DNS record lives in
   * an internal view publishes a name that resolves nowhere from the deployment while the
   * balancers fronting it are perfectly reachable, and this is how such a provider says so
   * without the platform having to know its topology. Absent (the ordinary case) means the name
   * is the only thing to try.
   */
  addressesPath: v.optional(v.string()),
  statusPath: v.optional(v.string()),
  statusMap: v.optional(v.array(v.object({ from: v.string(), to: environmentStatusSchema }))),
  expiresAtPath: v.optional(v.string()),
  externalIdPath: v.optional(v.string()),
  access: v.optional(environmentAccessMappingSchema),
})
export type EnvironmentResponseMapping = v.InferOutput<typeof environmentResponseMappingSchema>

/** The full declarative description of an org's ephemeral-env management API. */
export const environmentManifestSchema = v.object({
  providerId: v.pipe(v.string(), v.regex(/^[a-z0-9-]+$/), v.minLength(1), v.maxLength(64)),
  label: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  /** Management API root; provision/status/teardown paths are appended to it. */
  baseUrl: urlString,
  auth: environmentAuthSchemeSchema,
  provision: environmentRequestTemplateSchema,
  /** Optional: polled to observe async provisioning progress. */
  status: v.optional(environmentRequestTemplateSchema),
  /** Optional: called to destroy the environment (manual or on TTL expiry). */
  teardown: v.optional(environmentRequestTemplateSchema),
  response: environmentResponseMappingSchema,
  /** Fallback TTL (ms) when the response carries no explicit expiry. */
  defaultTtlMs: v.optional(v.pipe(v.number(), v.minValue(60000))),
  /**
   * Opaque, provider-specific configuration for a CUSTOM backend (e.g. a project
   * reference, link-selection key, status map). The generic HttpEnvironmentProvider ignores it
   * entirely; a custom backend — registered by reference into the app-owned
   * `EnvironmentBackendRegistry` (see `backend/docs/native-environment-adapter.md`) — reads
   * + validates it off the per-call
   * `manifest`. This is the per-WORKSPACE config carrier: a custom backend rides the generic
   * manifest member of `environmentBackendConfigSchema`, so its bespoke settings live here and
   * its credentials in the secret bundle. NOT covered by the manifest URL/SSRF checks (which
   * only guard `baseUrl`/`tokenUrl`); a backend that puts a URL here must guard it itself
   * (reuse the exported `UrlSafetyPolicy`).
   */
  providerConfig: v.optional(v.record(v.string(), v.unknown())),
})
export type EnvironmentManifest = v.InferOutput<typeof environmentManifestSchema>

// ---------------------------------------------------------------------------
// Per-service provision type + per-type infra handlers (the what/where ÷ how split).
//
// A SERVICE (repo) owns its provisioning config — the "what + where": which provision
// TYPE it produces and the in-repo specifics (where its k8s manifests live, its compose
// path, its custom manifest id). The WORKSPACE (and, in local mode, the user) owns HOW
// each type is handled — the engine + connection. Resolution matches the service's type
// to a workspace handler; a `remote-custom` handler declares the manifest id it accepts.
// See docs/initiatives/per-service-provision-types.md.
// ---------------------------------------------------------------------------

/**
 * The provision type a service declares — the INPUT SHAPE it produces. `infraless` means
 * the service stands up no environment (the Tester runs with no infra). A `custom` service
 * additionally pins a `manifestId` (see {@link serviceProvisioningSchema}).
 *
 * `cloudflare` is the per-PR Cloudflare Workers preview: unlike every other type the service
 * declares NOTHING repo-specific here, because the recipe lives in the repo's own preview
 * workflow rather than in a compose file or a manifest tree the platform reads. Declaring the
 * type is the whole service side of it.
 */
export const provisionTypeSchema = v.picklist([
  'kubernetes',
  'docker-compose',
  'cloudflare',
  'custom',
  'infraless',
])
export type ProvisionType = v.InferOutput<typeof provisionTypeSchema>

/**
 * Machine-readable cause of an environment-provisioning failure, surfaced on the run's
 * {@link AgentFailure.reason} so the SPA can render precise, actionable guidance instead of
 * string-matching the provider prose (the failure analogue of {@link ConflictReason}).
 *
 * It is also what decides whether an automated `deploy-fixer` may be dispatched at all (see
 * {@link isRepoFixableEnvironmentFailure}), which is the reason this vocabulary earns its keep
 * rather than staying a single member beside a verbatim provider string. A coding agent handed a
 * checkout will always find something to change; the classification is what stops it being asked
 * to, for a cause no edit in that checkout could address.
 *
 *  - `deploy_runner_unwired` — the service's provider needs a container-backed deploy (a real
 *    render/apply) but no deploy runner is wired on this deployment. The fix is deployment-level
 *    config (a runner pool / `LOCAL_DEPLOY_RUNTIME` / the Cloudflare DeployContainer binding), so
 *    the SPA gates its runtime-specific hint on this reason rather than on the prose.
 *  - `config_incomplete` — the manifests are fine and the PLATFORM did not fill them in: a
 *    `{{placeholder}}` the connection was meant to supply rendered empty, or a required handler
 *    field is unset. The repository is not at fault and editing it is actively harmful, because
 *    the only edit available is to hard-code the value the substitution exists to vary.
 *  - `manifest_invalid` — the manifests the repo supplied were rejected on their own merits
 *    (a malformed document, a missing required field, an unknown kind, a schema violation) with
 *    every substitution resolved. The ONE cause a checkout edit can actually fix.
 *  - `image_unavailable` — the workload's image could not be pulled (absent tag, private
 *    registry, no pull secret). Not repo-fixable: the image is published by CI, so an agent
 *    "fixing" this in the checkout is one step from editing the workflow that builds it.
 *  - `workload_unhealthy` — the objects applied cleanly and the workload never became ready
 *    (crash loop, OOM kill, unschedulable). This is the deployed CODE or the cluster's capacity,
 *    which is the tester's subject and the operator's, not a manifest repair.
 *  - `permission_denied` — the cluster refused the credentials (401/403, missing RBAC).
 *  - `cluster_unreachable` — the provider could not be reached at all.
 *  - `timeout` — the provision ran past its deadline with no terminal cause observed. This is
 *    what a `deployer` records when its readiness wait expires: the provider kept answering
 *    `provisioning` and never said why.
 *  - `environment_not_ready` — the environment settled in a state it will not leave on its own
 *    (`expired`, torn down under the run) or is still coming up when a step that needs it is
 *    about to be dispatched. Distinct from `timeout` because nothing waited: there is a live
 *    verdict, and it is not `ready`.
 *  - `environment_missing` — a service whose steps run against an ephemeral environment has
 *    none at all. The fix is the CHAIN (a tester with no `deployer` ahead of it) rather than the
 *    provider, which is why it does not share `environment_not_ready`'s code.
 *  - `environment_unreachable`: the provider called it `ready`, and neither the URL's own name
 *    nor any address the provider stated for it carried. The one member of this vocabulary that
 *    is about REACHING rather than provisioning, and it is here rather than in
 *    `EnvironmentUnreachableReason` because this is the vocabulary the deployer settles a frame
 *    in. Which LAYER failed is the sibling vocabulary's answer and rides the environment's own
 *    `reachability.proof.reason`.
 */
export const environmentFailureReasonSchema = v.picklist([
  'deploy_runner_unwired',
  'config_incomplete',
  'manifest_invalid',
  'image_unavailable',
  'workload_unhealthy',
  'permission_denied',
  'cluster_unreachable',
  'timeout',
  'environment_not_ready',
  'environment_missing',
  'environment_unreachable',
])
export type EnvironmentFailureReason = v.InferOutput<typeof environmentFailureReasonSchema>

/**
 * Whether a failure of this cause could be fixed by editing the repository the run has checked
 * out, and therefore whether an automated fixer may be dispatched against it.
 *
 * An exhaustive `Record` rather than a set membership test, so a new cause fails the build until
 * somebody decides this about it. The default a new member would otherwise silently inherit is
 * the dangerous one in both directions: `true` spends a container and invites a plausible-looking
 * edit to code that was never wrong, and `false` quietly removes a class from remediation with
 * nothing recording that anyone chose to.
 *
 * ONLY `manifest_invalid` is true, and the bar is deliberately that high. The motivating failure
 * (`exec_194b231198454c7785f29589`) was a `Deployment` rejected for `spec.template.spec.
 * containers[0].image: Required value` where the manifest correctly said `image: "{{image}}"`
 * and the workspace connection carried no `imageTemplate` to fill it. An agent given that error
 * and that checkout has exactly one move: hard-code an image. The run goes green, per-PR image
 * substitution is permanently defeated, and the unwired connection the failure was reporting is
 * hidden. Classification is what makes the difference between a repair and a plausible guess.
 *
 * An UNCLASSIFIED failure (no reason recorded at all) is not fixable either: the callers treat
 * an absent reason as false, because "we could not tell what went wrong" is not evidence that a
 * checkout edit would help.
 */
const REPO_FIXABLE_ENVIRONMENT_FAILURES: Record<EnvironmentFailureReason, boolean> = {
  deploy_runner_unwired: false,
  config_incomplete: false,
  manifest_invalid: true,
  image_unavailable: false,
  workload_unhealthy: false,
  permission_denied: false,
  cluster_unreachable: false,
  timeout: false,
  environment_not_ready: false,
  environment_missing: false,
  // A route that does not carry is a DNS zone, a security group or a load balancer, none of
  // which is in the checkout. An agent handed "nothing could reach it" and a repo has exactly
  // one move, which is to change the address the manifest publishes, and that is the fact the
  // failure was reporting rather than the fault.
  environment_unreachable: false,
}

/** See {@link REPO_FIXABLE_ENVIRONMENT_FAILURES}. An absent/unknown reason is never fixable. */
export function isRepoFixableEnvironmentFailure(
  reason: string | null | undefined,
): reason is EnvironmentFailureReason {
  if (!reason) return false
  return REPO_FIXABLE_ENVIRONMENT_FAILURES[reason as EnvironmentFailureReason] === true
}

/**
 * The engine a workspace/user handler uses to stand up / connect to an environment for a
 * provision type. `none` is the synthetic engine for `infraless`. `local-docker` runs a
 * compose stack locally; `local-k3s`/`remote-kubernetes` drive a kube apiserver;
 * `cloudflare` drives a repo's preview workflow over the VCS deployments API;
 * `remote-custom` is the generic BYO HTTP management API.
 */
export const infraEngineSchema = v.picklist([
  'local-docker',
  'local-k3s',
  'remote-kubernetes',
  'cloudflare',
  'remote-custom',
  'none',
])
export type InfraEngine = v.InferOutput<typeof infraEngineSchema>

/** A custom-manifest-type identifier (lower-kebab slug). */
export const manifestIdSchema = v.pipe(
  v.string(),
  v.regex(/^[a-z0-9][a-z0-9-]*$/),
  v.minLength(1),
  v.maxLength(64),
)
export type ManifestId = v.InferOutput<typeof manifestIdSchema>

// ---------------------------------------------------------------------------
// Cloudflare Workers preview environment backend.
//
// A native backend that stands up a per-PR Cloudflare Worker (its own D1 databases, its own
// SPA preview) by driving the TARGET REPOSITORY'S OWN preview workflow over the VCS
// Deployments API. The platform never talks to Cloudflare: it creates a deployment, reads
// that deployment's statuses for readiness, and posts an `inactive` status to tear down.
//
// Why the deployments API and not the Cloudflare API. Standing a Worker up means BUILDING it
// — installing a pnpm workspace, running migrations, uploading a bundle. That needs a CI
// runner, which no facade has (and the Cloudflare facade has neither a filesystem nor a
// container). The repository already has a runner; the deployments API is the smallest
// possible control plane over it, and it is plain outbound HTTPS, so this backend works
// identically on every facade. See `deploy/preview/README.md` for the reference workflow.
// ---------------------------------------------------------------------------

/** The secret-bundle key the Cloudflare env backend reads its VCS API token from. */
export const CLOUDFLARE_ENV_TOKEN_SECRET_KEY = 'githubToken'

/** Default templates, exported so the provider, the UI hints and the docs cannot drift apart. */
export const CLOUDFLARE_DEFAULT_WORKER_NAME_TEMPLATE = 'cat-factory-pr-{{pullNumber}}'
export const CLOUDFLARE_DEFAULT_ENVIRONMENT_NAME_TEMPLATE = 'pr-{{pullNumber}}'

/**
 * A `{{pullNumber}}`/`{{branch}}`/`{{blockId}}`-templated resource name. Constrained to the
 * characters a Worker name and a deployment environment name both accept ONCE RENDERED, so a
 * bad template fails at the write boundary rather than producing an unreachable URL.
 */
const cloudflareNameTemplate = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(120),
  v.regex(
    /^[a-z0-9{}-]+$/,
    'may contain only lowercase letters, digits, hyphens and {{placeholders}}',
  ),
)

/**
 * What it takes to REACH the VCS API this backend drives, split out of the full config for the
 * reason {@link kubernetesConnectionConfigSchema} states: teardown posts one `inactive`
 * deployment status and needs nothing else, so a `workersSubdomain` or name template that
 * stopped matching the contract must not be what strands a live preview.
 *
 * `apiBaseUrl` stays validated because the fallback is the PUBLIC API root: silently posting a
 * GitHub Enterprise deployment's teardown to `api.github.com` is a wrong-host write, not a
 * degradation. Absent is fine (that IS the documented default); present but unusable is not.
 */
export const cloudflareConnectionConfigSchema = v.object({
  /** VCS API root. Absent ⇒ `https://api.github.com`. Set it for GitHub Enterprise Server. */
  apiBaseUrl: v.optional(urlString),
})
export type CloudflareConnectionConfig = v.InferOutput<typeof cloudflareConnectionConfigSchema>

/**
 * The Cloudflare preview engine connection (the "how"). Everything here is non-secret; the
 * VCS API token rides the encrypted secret bundle under
 * {@link CLOUDFLARE_ENV_TOKEN_SECRET_KEY}.
 *
 * The two name templates are the CONTRACT WITH THE WORKFLOW, which is why they are config and
 * not constants: the platform derives the environment name it deploys under and the Worker
 * URL it hands the tester, and the workflow names its resources from the same values. Change
 * one and you must change the other. They default to the reference workflow's shape, so a
 * deployment that copied `deploy/preview` unmodified sets neither.
 */
export const cloudflareEnvironmentConfigSchema = v.object({
  ...cloudflareConnectionConfigSchema.entries,
  label: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  /**
   * The account's `*.workers.dev` subdomain — the preview URL is
   * `https://<worker>.<subdomain>.workers.dev`. The platform can DERIVE that before anything
   * is built, which is what lets a tester be handed a URL without waiting on a deploy that
   * takes minutes.
   */
  workersSubdomain: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(63),
    v.regex(
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
      'must be a bare workers.dev subdomain label, e.g. "my-account"',
    ),
  ),
  /**
   * `owner/repo` carrying the preview workflow. Absent ⇒ THE BLOCK'S OWN REPO, resolved per
   * provision — which is the point of a built-in backend over a pasted manifest: one handler
   * serves every repository in the workspace instead of being pinned to one.
   */
  repo: v.optional(
    v.pipe(v.string(), v.trim(), v.regex(/^[^/\s]+\/[^/\s]+$/, 'must be "owner/repo"')),
  ),
  /** Worker name template; the URL is derived from it. Absent ⇒ `cat-factory-pr-{{pullNumber}}`. */
  workerNameTemplate: v.optional(cloudflareNameTemplate),
  /** Deployment environment name template. Absent ⇒ `pr-{{pullNumber}}`. */
  environmentNameTemplate: v.optional(cloudflareNameTemplate),
  /** Fallback TTL (ms) after which the env is swept + torn down. */
  defaultTtlMs: v.optional(v.pipe(v.number(), v.minValue(60000))),
})
export type CloudflareEnvironmentConfig = v.InferOutput<typeof cloudflareEnvironmentConfigSchema>

/** Built-in environment backend kinds the contract knows by name. */
export const RESERVED_ENVIRONMENT_BACKEND_KINDS = [
  'manifest',
  'kubernetes',
  'eks',
  'cloudflare',
] as const

/**
 * The `kind` slug of a CUSTOM (third-party, programmatically-registered) environment
 * backend: any lower-kebab slug that isn't a reserved built-in. A custom backend stores
 * everything in the generic manifest — bespoke settings ride `providerConfig`, credentials
 * the secret bundle — so its connect config is a manifest under this slug, and the
 * registered `EnvironmentBackendProvider` (resolved by `kind`) owns the semantic
 * validation. The reserved-kind guard is load-bearing: it stops a wrong-shaped built-in
 * payload (e.g. `{ kind: 'kubernetes', manifest }`) from silently matching this generic
 * member instead of failing.
 */
export const customEnvironmentBackendKindSchema = customBackendKindSchema(
  RESERVED_ENVIRONMENT_BACKEND_KINDS,
)

/**
 * An ephemeral-environment backend config, discriminated by `kind`. The universal
 * abstraction over HOW a workspace's preview environments are provisioned: the built-ins
 * `manifest` (the generic BYO HTTP management API) and `kubernetes` (native per-PR
 * namespaces), plus any CUSTOM kind a deployment registers by reference into the app-owned
 * `EnvironmentBackendRegistry` (it rides the generic manifest member — NO new variant
 * needed). Mirrors `runnerBackendConfigSchema`; the provider-registry seam keys on `kind`.
 */
export const environmentBackendConfigSchema = v.variant('kind', [
  v.object({ kind: v.literal('manifest'), manifest: environmentManifestSchema }),
  v.object({ kind: v.literal('kubernetes'), kubernetes: kubernetesProvisionConfigSchema }),
  v.object({ kind: v.literal('eks'), eks: eksProvisionConfigSchema }),
  v.object({ kind: v.literal('cloudflare'), cloudflare: cloudflareEnvironmentConfigSchema }),
  v.object({ kind: customEnvironmentBackendKindSchema, manifest: environmentManifestSchema }),
])
export type EnvironmentBackendConfig = v.InferOutput<typeof environmentBackendConfigSchema>
export type EnvironmentBackendKind = EnvironmentBackendConfig['kind']

// ---------------------------------------------------------------------------
// Service-owned provisioning config (the "what + where") — on the service-frame Block.
// ---------------------------------------------------------------------------

/**
 * The per-type source a service supplies. Only the branch matching the service's
 * `provisionType` is meaningful; the others are ignored. The service carries NO
 * engine/credentials — only the in-repo intent. Built by merging with the workspace
 * handler (the "how") at provision time.
 */
export const serviceProvisioningSchema = v.object({
  type: provisionTypeSchema,
  /** `kubernetes`: where the per-PR manifests live (colocated in the PR repo, or a separate repo). */
  manifestSource: v.optional(kubernetesManifestSourceSchema),
  /** `docker-compose`: path to the compose file relative to the repo root. */
  composePath: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
  /** `docker-compose`: the compose stack is for local development only (advisory). */
  localDevOnly: v.optional(v.boolean()),
  /**
   * `docker-compose`: build the stack's images from the repo's Dockerfiles instead of
   * pulling pre-built images (advisory; the load-bearing switch is the workspace handler's
   * `providerConfig.build`). When set, the PR head is cloned into a working tree so `build:`
   * contexts, in-checkout bind mounts, and relative `env_file`s resolve.
   */
  composeBuild: v.optional(v.boolean()),
  /**
   * `docker-compose`: the declarative STACK RECIPE for a complex multi-step bring-up —
   * multi-`-f` layering, profiles, env-file materialization, external networks / shared-stack
   * refs, ordered setup/teardown steps + a terminal health gate. Absent ⇒ the simple
   * single-file `composePath` + `up --wait` path (when set, `recipe.composeFiles` supersedes
   * `composePath`). See {@link stackRecipeSchema}.
   */
  recipe: v.optional(stackRecipeSchema),
  /** `custom`: the custom-manifest-type id this service produces (matched to a remote-custom handler). */
  manifestId: v.optional(manifestIdSchema),
  /** `custom`: optional path to the custom manifest within the repo. */
  manifestPath: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
  /**
   * `kubernetes` (container-backed deploy adapter only): structured image overrides, the
   * helm releases the env composes, and the Secrets to materialize before apply. The
   * native REST adapter ignores these (raw manifests). See the schemas above.
   */
  images: v.optional(v.array(kubernetesImageOverrideSchema)),
  helmReleases: v.optional(v.array(kubernetesHelmReleaseSchema)),
  secretInjections: v.optional(v.array(kubernetesSecretInjectionSchema)),
})
export type ServiceProvisioning = v.InferOutput<typeof serviceProvisioningSchema>

// ---------------------------------------------------------------------------
// Per-type infra handler config (the "how") — on the workspace/user handler row.
// ---------------------------------------------------------------------------

/**
 * The kube engine connection (the "how" for a `kubernetes` provision type), discriminated
 * from the service-owned `manifestSource` (the "what/where"): apiserver + TLS + namespace
 * + sizing only. The manifests to apply come from the SERVICE at provision time. Used by
 * both the `local-k3s` and `remote-kubernetes` engines.
 */
export const kubernetesEngineConfigSchema = v.object({
  label: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  /** kube-apiserver root URL, e.g. `https://my-cluster.example:6443`. */
  apiServerUrl: urlString,
  /** PEM CA bundle to verify the apiserver TLS cert (omit only for a publicly-trusted CA). */
  caCertPem: v.optional(v.string()),
  /** Skip apiserver TLS verification — strongly discouraged; kind/dev clusters only. */
  insecureSkipTlsVerify: v.optional(v.boolean()),
  /**
   * Namespace name template for the per-PR environment, e.g. `cf-env-pr{{pullNumber}}`. With
   * `renderer: 'kustomize'`, ABSENT ⇒ honor the overlay's own `namespace:` when it pins one
   * (the shared-namespace ephemeral-env shape, where base + overlay name a fixed namespace);
   * SET ⇒ override it (the adapter sets the namespace at build time) for true per-PR
   * isolation. For raw manifests, absent ⇒ a default derived from the PR number / block id.
   */
  namespaceTemplate: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))),
  /** How the environment URL is derived once applied. */
  url: kubernetesUrlSourceSchema,
  /** Optional image reference made available to the manifests as `{{image}}`. */
  imageTemplate: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
  /** Fallback TTL (ms) after which the env is swept + torn down. */
  defaultTtlMs: v.optional(v.pipe(v.number(), v.minValue(60000))),
  /**
   * How long (seconds) the container deploy adapter waits for each Deployment to roll out
   * before reporting the env still `provisioning` (the backend keeps polling). Absent ⇒ the
   * harness default (180s). Merged into the provision config via `...kube` at provision time.
   */
  rolloutTimeoutSeconds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  /** Extra labels stamped on the namespace + every applied resource. */
  labels: v.optional(v.record(v.string(), v.string())),
  /** Extra annotations stamped on the namespace. */
  annotations: v.optional(v.record(v.string(), v.string())),
  /**
   * Workspace-level (cluster-singleton) helm releases the deploy adapter ensures before
   * applying a service's manifests — e.g. an ingress/gateway controller shared by every
   * per-PR env. Use `scope: 'shared'`; installed once, never torn down per-PR. Merged
   * with the service's own (per-environment) `helmReleases` at provision time.
   */
  helmReleases: v.optional(v.array(kubernetesHelmReleaseSchema)),
})
export type KubernetesEngineConfig = v.InferOutput<typeof kubernetesEngineConfigSchema>

/**
 * A per-type infra handler config, discriminated by `engine`. Binds a provision type to the
 * engine that handles it + that engine's connection config. `local-docker` rides the
 * generic compose backend (its settings in `providerConfig`); `local-k3s`/`remote-kubernetes`
 * carry the kube engine connection; `remote-custom` is the generic HTTP manifest API and
 * declares the manifest id it accepts.
 */
export const infraHandlerConfigSchema = v.variant('engine', [
  v.object({ engine: v.literal('local-docker'), manifest: environmentManifestSchema }),
  v.object({ engine: v.literal('local-k3s'), kubernetes: kubernetesEngineConfigSchema }),
  v.object({ engine: v.literal('remote-kubernetes'), kubernetes: kubernetesEngineConfigSchema }),
  v.object({ engine: v.literal('cloudflare'), cloudflare: cloudflareEnvironmentConfigSchema }),
  v.object({
    engine: v.literal('remote-custom'),
    manifest: environmentManifestSchema,
    /** Which custom manifest shape this remote provider consumes — matched to a service's `manifestId`. */
    acceptsManifestId: manifestIdSchema,
  }),
])
export type InfraHandlerConfig = v.InferOutput<typeof infraHandlerConfigSchema>

// ---------------------------------------------------------------------------
// Custom-manifest-type catalog — the open set of `custom` provision types, aggregated
// from programmatically-registered providers + workspace-defined (UI-editable) entries.
// ---------------------------------------------------------------------------

export const customManifestTypeSourceSchema = v.picklist(['registered', 'workspace'])
export type CustomManifestTypeSource = v.InferOutput<typeof customManifestTypeSourceSchema>

/** A custom manifest type a service can declare (and a remote-custom handler can accept). */
export const customManifestTypeSchema = v.object({
  manifestId: manifestIdSchema,
  label: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  /** `registered` (from a code provider) or `workspace` (UI-defined). */
  source: customManifestTypeSourceSchema,
  /** Optional hint describing the input shape the provider expects. */
  acceptsInputHint: v.optional(v.pipe(v.string(), v.maxLength(500))),
  description: v.optional(v.pipe(v.string(), v.maxLength(2000))),
  /**
   * Default in-repo path (complete relative path with filename, e.g. `deploy/preview.yaml`,
   * or a bare filename e.g. `preview.yaml`) for a service's `manifestPath`. Prefilled when a
   * service selects this type and used as the seed for path auto-detection.
   */
  defaultManifestPath: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
  /**
   * The coding-agent prompt used to generate the manifest (when absent) or fix it (when
   * present but invalid). Absent ⇒ the service inspector's "generate/fix manifest" affordance
   * is hidden (there is nothing to instruct the agent with).
   */
  fixerPrompt: v.optional(v.pipe(v.string(), v.maxLength(4000))),
})
export type CustomManifestType = v.InferOutput<typeof customManifestTypeSchema>

/** Create/edit a workspace-defined custom manifest type (UI CRUD). */
export const upsertCustomManifestTypeSchema = v.object({
  label: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  acceptsInputHint: v.optional(v.pipe(v.string(), v.maxLength(500))),
  description: v.optional(v.pipe(v.string(), v.maxLength(2000))),
  defaultManifestPath: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
  fixerPrompt: v.optional(v.pipe(v.string(), v.maxLength(4000))),
})
export type UpsertCustomManifestTypeInput = v.InferOutput<typeof upsertCustomManifestTypeSchema>

// ---------------------------------------------------------------------------
// Per-type infra HANDLER wire shapes (the workspace/user "how"): a handler view
// (safe metadata + non-secret config for connect-form prefill) and the register payload.
// ---------------------------------------------------------------------------

/** One registered infra handler, as exposed to clients (never secret VALUES). */
export const environmentHandlerViewSchema = v.object({
  provisionType: provisionTypeSchema,
  /** For `custom`: the manifest id this handler is keyed to; `null` otherwise. */
  manifestId: v.nullable(v.string()),
  engine: infraEngineSchema,
  providerId: v.string(),
  label: v.string(),
  baseUrl: v.string(),
  connectedAt: v.number(),
  /** Which secret keys are set (names only), so the UI can show completeness. */
  secretKeys: v.array(v.string()),
  /** For `remote-custom`: the manifest id this provider accepts; `null` otherwise. */
  acceptsManifestId: v.nullable(v.string()),
  /**
   * The registry backend kind that builds this handler's provider (`manifest`, `kubernetes`,
   * or a deployment-registered custom kind). Lets the connect form pre-select the right backend
   * when editing a saved handler — distinct from `providerId`, which is the connection's own
   * identifier, not the registry slug.
   */
  backendKind: v.string(),
  /** The stored handler config, sans secrets, for connect-form prefill on edit. */
  config: v.optional(infraHandlerConfigSchema),
})
export type EnvironmentHandlerView = v.InferOutput<typeof environmentHandlerViewSchema>

/**
 * Register (or replace) one per-type infra handler: the engine connection config + its
 * secret bundle (write-only). `manifestId` keys a `custom` handler to a specific manifest
 * id; `backendKind` pins the registry backend that builds the provider (else resolved from
 * the engine). Every secret key the chosen backend references must be supplied.
 */
export const registerEnvironmentHandlerSchema = v.object({
  provisionType: provisionTypeSchema,
  manifestId: v.optional(v.nullable(manifestIdSchema)),
  config: infraHandlerConfigSchema,
  backendKind: v.optional(v.string()),
  secrets: v.record(v.string(), v.string()),
})
export type RegisterEnvironmentHandlerInput = v.InferOutput<typeof registerEnvironmentHandlerSchema>

/**
 * Probe a per-type infra handler connection before saving (nothing persisted). Carries the
 * engine connection config + its (write-only) secret bundle, optionally pinning the registry
 * backend that builds the provider (else resolved from the engine). The same shape as
 * {@link registerEnvironmentHandlerSchema} minus the persistence-only `provisionType`/`manifestId`.
 */
export const testEnvironmentHandlerSchema = v.object({
  config: infraHandlerConfigSchema,
  backendKind: v.optional(v.string()),
  secrets: v.optional(v.record(v.string(), v.string())),
})
export type TestEnvironmentHandlerInput = v.InferOutput<typeof testEnvironmentHandlerSchema>

/**
 * The body for a per-USER handler override PUT, where the provision type is taken from the
 * path (`/me/environment-handlers/:workspaceId/:provisionType`) — so the body carries only
 * the config + secrets (+ optional `manifestId`/`backendKind`), and must NOT re-send a
 * `provisionType` the handler would ignore.
 */
export const upsertEnvironmentUserHandlerBodySchema = v.object({
  manifestId: v.optional(v.nullable(manifestIdSchema)),
  config: infraHandlerConfigSchema,
  backendKind: v.optional(v.string()),
  secrets: v.record(v.string(), v.string()),
})
export type UpsertEnvironmentUserHandlerBody = v.InferOutput<
  typeof upsertEnvironmentUserHandlerBodySchema
>

/** The batched per-type handler bundle: every workspace handler + the custom-type catalog. */
export const environmentHandlersBundleSchema = v.object({
  handlers: v.array(environmentHandlerViewSchema),
  customTypes: v.array(customManifestTypeSchema),
})
export type EnvironmentHandlersBundle = v.InferOutput<typeof environmentHandlersBundleSchema>

/** Resolved access creds for a provisioned env, as surfaced to a tester agent. */
export const environmentAccessHandleSchema = v.object({
  scheme: environmentAccessSchemeSchema,
  token: v.optional(v.string()),
  username: v.optional(v.string()),
  password: v.optional(v.string()),
  headerName: v.optional(v.string()),
  headerValue: v.optional(v.string()),
})
export type EnvironmentAccessHandle = v.InferOutput<typeof environmentAccessHandleSchema>

/** A provisioned environment, as exposed to clients and downstream agents. */
export const environmentHandleSchema = v.object({
  id: v.string(),
  workspaceId: v.string(),
  blockId: v.nullable(v.string()),
  /**
   * The service FRAME this environment belongs to (the deployer step's block walked up to its
   * enclosing frame). This is the key a cross-frame consumer resolves an env by — notably a
   * `frontend` frame's `service` binding, whose `serviceBlockId` names a service FRAME, not the
   * task the deployer happened to run on (which is `blockId`). Null for legacy rows / a block-less
   * or frame-less provision.
   */
  frameId: v.optional(v.nullable(v.string())),
  executionId: v.nullable(v.string()),
  providerId: v.string(),
  externalId: v.nullable(v.string()),
  url: v.nullable(v.string()),
  /**
   * What the platform knows about ADDRESSING this environment, beside the name in `url`: the
   * addresses its provider states carry traffic for that name, and what dialling them proved.
   *
   * Beside `url` rather than folded into it because they answer different questions and only one
   * of them is a claim. `url` is what a browser opens and what an ingress routes on, and it stays
   * exactly as the provider published it; this is whether anything can actually get there, which
   * before it existed nothing had ever asked. Null for an environment provisioned before this
   * field, and for a provider that states no addresses and has not been probed.
   */
  reachability: v.optional(v.nullable(environmentReachabilitySchema)),
  status: environmentStatusSchema,
  /** Present only on the dedicated access endpoint / in agent context. */
  access: v.optional(environmentAccessHandleSchema),
  createdAt: v.number(),
  expiresAt: v.nullable(v.number()),
  lastError: v.nullable(v.string()),
  /**
   * The provider's own account of a state it has not left yet: why this environment is not
   * ready. Written on every provision and poll regardless of status, so unlike `lastError` it
   * is present WHILE an environment is still coming up. Null when the provider said nothing.
   */
  statusNote: v.optional(v.nullable(v.string())),
  /**
   * When the provider last ANSWERED a status poll for this environment, and how many answers the
   * platform has recorded.
   *
   * The one trail polling leaves. The provisioning log records an attempt that threw and a poll
   * that turned an environment `failed`; an answer wrote nothing anywhere, so a readiness wait
   * that polled for four minutes was indistinguishable from no polling at all, and a reader (the
   * environment investigation, then a human) took the silence for the second.
   *
   * An answer reporting `failed` counts: this says how much polling HAPPENED, never how much of it
   * went well. A poll that THREW does not, having a provisioning-log row of its own.
   *
   * `pollCount` is a FLOOR, not a ledger: it is written from the count the poll read at its start,
   * so two polls racing cost it an increment. `lastPolledAt` is exact, a lost race there leaving
   * the later of the two stamps. Null / 0 means no answered poll is RECORDED, which is all a
   * reader may conclude from it.
   */
  lastPolledAt: v.optional(v.nullable(v.number())),
  pollCount: v.optional(v.number()),
  /**
   * The service's declared provision type this environment was stood up for
   * (`kubernetes` | `docker-compose` | `custom` | `infraless`). Recorded at provision
   * time so run details can show exactly what was provisioned. Null for legacy rows.
   */
  provisionType: v.optional(v.nullable(provisionTypeSchema)),
  /**
   * The resolved engine that handled the provisioning (`local-docker` | `local-k3s` |
   * `remote-kubernetes` | `remote-custom` | `none`). Surfaced in run details alongside
   * the provider label. Null for legacy rows.
   */
  engine: v.optional(v.nullable(infraEngineSchema)),
})
export type EnvironmentHandle = v.InferOutput<typeof environmentHandleSchema>

/** A workspace's provider binding, as exposed to clients (never secret values). */
export const environmentConnectionSchema = v.object({
  /** Which backend kind is configured (`manifest` | `kubernetes` | …). */
  kind: v.string(),
  providerId: v.string(),
  label: v.string(),
  baseUrl: v.string(),
  connectedAt: v.number(),
  /** Which secret keys are set (names only), so the UI can show completeness. */
  secretKeys: v.array(v.string()),
  /**
   * The stored discriminated backend config, sans secrets (those live in the
   * write-only secret bundle), so the connect form can prefill its non-secret fields
   * on edit. Omitted only for an unparsable row.
   */
  config: v.optional(environmentBackendConfigSchema),
})
export type EnvironmentConnection = v.InferOutput<typeof environmentConnectionSchema>

// ---- Request bodies -------------------------------------------------------

/**
 * Register (or replace) a workspace's environment provider. `config` is the
 * discriminated backend config (the generic HTTP manifest, or a native Kubernetes
 * backend); the org supplies the actual per-tenant secret values here (write-only) —
 * a manifest's management-API credentials, or a Kubernetes ServiceAccount token
 * (`apiToken`). Secrets are encrypted at rest and never returned. Every secret key
 * the chosen backend references must have a matching entry in `secrets`.
 */
export const registerEnvironmentProviderSchema = v.object({
  config: environmentBackendConfigSchema,
  secrets: v.record(v.string(), v.string()),
})
export type RegisterEnvironmentProviderInput = v.InferOutput<
  typeof registerEnvironmentProviderSchema
>

/** Rotate/replace the per-tenant secret bundle without re-sending the manifest. */
export const updateEnvironmentSecretsSchema = v.object({
  secrets: v.record(v.string(), v.string()),
})
export type UpdateEnvironmentSecretsInput = v.InferOutput<typeof updateEnvironmentSecretsSchema>

/**
 * Test (probe) a provider connection before saving: supply the candidate
 * discriminated `config` + its `secrets`. Nothing is persisted by a test.
 */
export const testEnvironmentConnectionSchema = v.object({
  config: v.optional(environmentBackendConfigSchema),
  secrets: v.optional(v.record(v.string(), v.string())),
})
export type TestEnvironmentConnectionInput = v.InferOutput<typeof testEnvironmentConnectionSchema>

/**
 * Validate a target repo against the provider's expectations on demand (no block
 * context). The operator supplies the repo coordinates + ref; nothing is persisted.
 */
export const validateEnvironmentRepoSchema = v.object({
  owner: v.pipe(v.string(), v.minLength(1)),
  repo: v.pipe(v.string(), v.minLength(1)),
  /** Branch/tag/sha to read at; absent ⇒ the repo's default branch. */
  gitRef: v.optional(v.pipe(v.string(), v.minLength(1))),
  /** Optional VCS provider hint; absent ⇒ the workspace's connected provider. */
  provider: v.optional(v.picklist(['github', 'gitlab'])),
})
export type ValidateEnvironmentRepoInput = v.InferOutput<typeof validateEnvironmentRepoSchema>

/**
 * Mechanically bootstrap the provider's config file into a target repo from the
 * variables the bootstrap form collected, optionally opening a PR and/or allowing the
 * agent-repair fallback when mechanical generation can't produce a valid config.
 */
export const bootstrapEnvironmentRepoSchema = v.object({
  owner: v.pipe(v.string(), v.minLength(1)),
  repo: v.pipe(v.string(), v.minLength(1)),
  /** Branch to write to; absent ⇒ the repo's default branch (the ref the provider reads). */
  gitRef: v.optional(v.pipe(v.string(), v.minLength(1))),
  provider: v.optional(v.picklist(['github', 'gitlab'])),
  /** Variables collected by the bootstrap form (keyed by `describeBootstrapInputs`). */
  inputs: v.record(v.string(), v.string()),
  /** Open a PR instead of committing straight to the branch. */
  openPr: v.optional(v.boolean()),
  /** Allow dispatching the repair agent when mechanical bootstrap can't do it. */
  allowAgentFallback: v.optional(v.boolean()),
})
export type BootstrapEnvironmentRepoInput = v.InferOutput<typeof bootstrapEnvironmentRepoSchema>

/**
 * Generate (when absent) or fix (when present-but-invalid) a service's CUSTOM manifest file in
 * a target repo, by dispatching the coding agent with the selected custom-manifest-type's
 * `fixerPrompt`. The run is a durable, asynchronous `env-config-repair` run tracked exactly
 * like {@link bootstrapEnvironmentRepoSchema}'s agent fallback. Nothing is persisted about the
 * service; the fix is pushed onto the target branch.
 */
export const repairCustomManifestSchema = v.object({
  /** The custom-manifest-type this service pins — supplies the `fixerPrompt` for the agent. */
  manifestId: manifestIdSchema,
  owner: v.pipe(v.string(), v.minLength(1)),
  repo: v.pipe(v.string(), v.minLength(1)),
  /** Branch the agent clones from and pushes the fix back onto; absent ⇒ the default branch. */
  gitRef: v.optional(v.pipe(v.string(), v.minLength(1))),
  /**
   * The target manifest path to create/fix, REPO-root-relative (the caller roots the type's
   * default under the service subtree before sending, exactly as auto-detection does).
   */
  manifestPath: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
  /** Optional VCS provider hint; absent ⇒ the workspace's connected provider. */
  provider: v.optional(v.picklist(['github', 'gitlab'])),
})
export type RepairCustomManifestInput = v.InferOutput<typeof repairCustomManifestSchema>

/** Manually provision an environment (outside a pipeline run). */
export const provisionEnvironmentSchema = v.object({
  blockId: v.optional(v.pipe(v.string(), v.minLength(1))),
  inputs: v.optional(v.record(v.string(), v.string())),
})
export type ProvisionEnvironmentInput = v.InferOutput<typeof provisionEnvironmentSchema>

// ---------------------------------------------------------------------------
// Provisioning auto-detection (slice 11): a NON-BINDING recommended provisioning config
// inferred from a service's repo, read checkout-free over the `RepoFiles` port. A pure-TS
// heuristic detector proposes the service-owned "what + where" (provision type + manifest
// source + renderer + image overrides + secret injections + per-env helm releases) plus the
// engine-level URL source / pinned namespace the WORKSPACE handler owns (surfaced so the
// operator can apply them to the kube engine config). The user always confirms/edits;
// nothing is applied silently. See docs/initiatives/per-service-provision-types.md.
// ---------------------------------------------------------------------------

/** How confident the detector is in an inferred field. */
export const provisioningDetectionConfidenceSchema = v.picklist(['high', 'low'])
export type ProvisioningDetectionConfidence = v.InferOutput<
  typeof provisioningDetectionConfidenceSchema
>

/** One inferred aspect of the recommendation, with its confidence + a human-readable rationale. */
export const provisioningDetectionNoteSchema = v.object({
  /**
   * Which field this note explains: `provisionType` | `renderer` | `url` | `namespace` |
   * `secretInjections` | `images` | `overlay` | `helmReleases` | `compose` | `serviceDir` |
   * `manifestRoot` | `composeService` | `composeBuild` | `composeFiles` | `composeProfiles` |
   * `envFiles` | `externalNetworks` | `sharedStackRefs` | `setupSteps` | `healthGate` |
   * `seedDump` | `repoCli`.
   */
  field: v.string(),
  confidence: provisioningDetectionConfidenceSchema,
  /** Rationale for the SPA to surface next to the field (e.g. "kustomization.yaml present ⇒ kustomize"). */
  message: v.pipe(v.string(), v.maxLength(500)),
})
export type ProvisioningDetectionNote = v.InferOutput<typeof provisioningDetectionNoteSchema>

/**
 * A candidate ephemeral overlay when several exist under `overlays/*`. The detector ranks by
 * name (`prenv`/`preview`/`pr`/`ephemeral`/`dev`) and pre-selects the top one, but the user
 * picks — so every candidate is surfaced.
 */
export const provisioningOverlayCandidateSchema = v.object({
  /** Repo-relative overlay directory (the value `manifestSource.path` would take). */
  path: v.string(),
  /** The overlay's base name (e.g. `prenv`). */
  name: v.string(),
  /** The highest-ranked candidate (the one pre-selected in `provisioning.manifestSource`). */
  recommended: v.boolean(),
})
export type ProvisioningOverlayCandidate = v.InferOutput<typeof provisioningOverlayCandidateSchema>

/**
 * A per-service slice found inside a ROOT SHARED deploy directory of a monorepo — the common
 * layout where a service's manifests live under `deploy/<svc>` / `k8s/<svc>` / `manifests/services/<svc>`
 * (keyed by the service name) rather than colocated under `services/<svc>/k8s`. The detector
 * matches the slice whose basename equals the service directory's basename and pre-selects it,
 * but every candidate is surfaced so the user can pick a different one.
 */
export const provisioningServiceDirCandidateSchema = v.object({
  /** Repo-relative directory of the slice (the value `manifestSource.path` would take), e.g. `deploy/api`. */
  path: v.string(),
  /** The slice's subfolder basename (e.g. `api`). */
  name: v.string(),
  /** The candidate matching the service directory's basename (the pre-selected one). */
  recommended: v.boolean(),
})
export type ProvisioningServiceDirCandidate = v.InferOutput<
  typeof provisioningServiceDirCandidateSchema
>

/**
 * A `services:` key when a discovered Docker Compose file declares MORE THAN ONE service — the
 * user picks which service corresponds to this board block. Advisory only: the chosen key is NOT
 * persisted on the service (the compose backend targets the file, not a single service), so the
 * chip sets `composePath` and the key rides a note.
 */
export const provisioningComposeServiceCandidateSchema = v.object({
  /** The compose file the service is declared in (the `-f` target — the value `composePath` would take). */
  composePath: v.string(),
  /** The `services:` key (e.g. `api`). */
  service: v.string(),
  /** The heuristic top pick (basename match, else the first declared service). */
  recommended: v.boolean(),
})
export type ProvisioningComposeServiceCandidate = v.InferOutput<
  typeof provisioningComposeServiceCandidateSchema
>

/**
 * A candidate Kubernetes manifest ROOT when several resolve (e.g. both `k8s/` and `manifests/`
 * hold real manifests). Generalizes `overlayCandidates` from "which overlay within one root" to
 * "which root": each carries its own `renderer`. Complementary to `overlayCandidates` — both may
 * appear (pick the root, then the overlay within it).
 */
export const provisioningManifestRootCandidateSchema = v.object({
  /** Repo-relative manifest directory (the value `manifestSource.path` would take). */
  path: v.string(),
  /** A human label (the directory's last path segment). */
  name: v.string(),
  /** The renderer for this root (`kustomization.yaml` present ⇒ `kustomize`, else `raw`). */
  renderer: kubernetesRendererSchema,
  /** The pre-selected root (the one reflected in `provisioning.manifestSource`). */
  recommended: v.boolean(),
})
export type ProvisioningManifestRootCandidate = v.InferOutput<
  typeof provisioningManifestRootCandidateSchema
>

/**
 * A candidate Docker Compose file for `-f` layering (slice 2 detection). The base file(s) are
 * pre-selected into `provisioning.recipe.composeFiles`; OS-specific overrides
 * (`dev.wsl.override.yml`, `dev.mac.override.yml`) are surfaced here — annotated with `os` and
 * NOT auto-layered — so the wizard binds the one matching the operator's machine.
 */
export const provisioningComposeFileCandidateSchema = v.object({
  /** Repo-relative compose file path (a value `recipe.composeFiles` would take). */
  path: v.string(),
  /** The file's base name (e.g. `dev.wsl.override.yml`). */
  name: v.string(),
  /** For an OS-specific override, which OS it targets; absent ⇒ OS-neutral (a base layer). */
  os: v.optional(v.picklist(['wsl', 'mac', 'linux', 'windows'])),
  /** True for a base layer pre-selected into `composeFiles`; an OS override is opt-in. */
  recommended: v.boolean(),
})
export type ProvisioningComposeFileCandidate = v.InferOutput<
  typeof provisioningComposeFileCandidateSchema
>

/**
 * A `COMPOSE_PROFILES` label the compose files declare (slice 2 detection). Surfaced
 * default-OFF — an optional service group the user opts into; `recommended` is set only for a
 * profile the detector deems part of the base bring-up (rare — most profiles are optional).
 */
export const provisioningProfileCandidateSchema = v.object({
  /** The `profiles:` label (e.g. `peer`, `backends`). */
  profile: v.string(),
  /** Whether to pre-enable it (default false — profiles are opt-in). */
  recommended: v.boolean(),
})
export type ProvisioningProfileCandidate = v.InferOutput<typeof provisioningProfileCandidateSchema>

/**
 * A `.sql` dump found under a seed-ish directory (`deployment/`, `seed/`, `db/`,
 * `docker-entrypoint-initdb.d/`) — a LOW-confidence candidate the wizard confirms, turning it
 * into a `compose-exec` seed-import step (piping the dump via `stdinFile`). Never auto-applied.
 */
export const provisioningSeedDumpCandidateSchema = v.object({
  /** Repo-relative path of the SQL dump. */
  path: v.string(),
  /** The dump file's base name. */
  name: v.string(),
  /** The heuristic top pick among several dumps. */
  recommended: v.boolean(),
})
export type ProvisioningSeedDumpCandidate = v.InferOutput<
  typeof provisioningSeedDumpCandidateSchema
>

/**
 * A REPORT-ONLY hint that the repo carries its OWN imperative bring-up — a Makefile, a
 * `bin/*console*` repo CLI, a justfile/Taskfile with setup-looking targets. Detection never
 * parses shell; it only flags the file so the wizard can suggest running the environment
 * ANALYST (slice 8) to translate that bring-up into recipe steps. Its presence sets the
 * "consider deep analysis" nudge.
 */
export const provisioningRepoCliHintSchema = v.object({
  /** Repo-relative path of the CLI / build file that triggered the hint. */
  path: v.string(),
  /** What kind of imperative entry point it is. */
  kind: v.picklist(['makefile', 'repo-cli', 'justfile', 'taskfile']),
})
export type ProvisioningRepoCliHint = v.InferOutput<typeof provisioningRepoCliHintSchema>

/**
 * A non-binding provisioning recommendation detected from a service's repo. `provisioning`
 * carries the service-owned config to prefill (the "what + where", now including a
 * `docker-compose` service's {@link stackRecipeSchema | recipe} — layered compose files,
 * profiles, env-file pairs, external networks); `urlSource`/`namespace` are engine-level
 * suggestions the workspace handler owns (the detector can READ them from the manifests but
 * they aren't stored on the service); the candidate arrays + `notes` drive the confirm UI.
 * `detected: false` ⇒ nothing inferable (`provisioning.type` is `infraless`).
 *
 * The candidate arrays let the user CHOOSE instead of accepting a silent auto-pick:
 * `overlayCandidates` (which overlay within a kustomize root), `manifestRootCandidates` (which
 * k8s root when several resolve), `serviceDirCandidates` (which root-shared monorepo slice),
 * `composeServiceCandidates` (which compose service), `composeFileCandidates` (which OS override
 * to layer), `profileCandidates` (which optional profiles to enable), and `seedDumpCandidates`
 * (which SQL dump to seed from). `repoCliHint` flags a repo with its own imperative bring-up
 * (a nudge toward the analyst). Each note's `field` is one of `provisionType` | `renderer` |
 * `url` | `namespace` | `secretInjections` | `images` | `overlay` | `helmReleases` | `compose` |
 * `serviceDir` | `manifestRoot` | `composeService` | `composeBuild` | `composeFiles` |
 * `composeProfiles` | `envFiles` | `externalNetworks` | `sharedStackRefs` | `setupSteps` |
 * `healthGate` | `seedDump` | `repoCli`.
 */
/**
 * A single extracted key/value a CUSTOM provider's `detect()` surfaced (a health port/path
 * parsed from its manifest, a deploy command, …) for the SPA to prefill into the connect/
 * provision form. Advisory — nothing is applied without the user confirming.
 */
export const provisioningCustomConfigSeedSchema = v.object({
  /** The config field name the provider names (e.g. `healthPort`, `healthPath`, `deployCommand`). */
  key: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  /** The extracted value (stringified). */
  value: v.pipe(v.string(), v.maxLength(1000)),
})
export type ProvisioningCustomConfigSeed = v.InferOutput<typeof provisioningCustomConfigSeedSchema>

/**
 * A CUSTOM manifest type whose `detect()` hook matched the repo, surfaced by the arbitration
 * sweep (when no type was pre-selected). The best-ranked one is pre-selected (`recommended`);
 * the rest let the user switch if the platform guessed wrong.
 */
export const detectedManifestTypeCandidateSchema = v.object({
  /** The matched custom-manifest-type id (the value `provisioning.manifestId` would take). */
  manifestId: v.string(),
  /** The type's human label (for the picker). */
  label: v.string(),
  /** How confident that provider's `detect()` was in the match. */
  confidence: provisioningDetectionConfidenceSchema,
  /** The top-ranked candidate (the one pre-selected in `provisioning.manifestId`). */
  recommended: v.boolean(),
})
export type DetectedManifestTypeCandidate = v.InferOutput<
  typeof detectedManifestTypeCandidateSchema
>

export const provisioningRecommendationSchema = v.object({
  detected: v.boolean(),
  /** The prefilled service provisioning the user confirms/edits (the "what + where"). */
  provisioning: serviceProvisioningSchema,
  /** Engine-level URL source inferred from the manifest kinds (workspace handler owns it). */
  urlSource: v.optional(kubernetesUrlSourceSchema),
  /** A pinned namespace the manifests declare — recommend honoring it (leave `namespaceTemplate` empty). */
  namespace: v.optional(v.string()),
  /** Candidate ephemeral overlays to choose among (kustomize with several `overlays/*`). */
  overlayCandidates: v.optional(v.array(provisioningOverlayCandidateSchema)),
  /** Candidate k8s manifest roots to choose among when several resolve (complements `overlayCandidates`). */
  manifestRootCandidates: v.optional(v.array(provisioningManifestRootCandidateSchema)),
  /** Candidate root-shared monorepo deploy slices to choose among (keyed by service name). */
  serviceDirCandidates: v.optional(v.array(provisioningServiceDirCandidateSchema)),
  /** Candidate compose services to pick from when the compose file declares several (advisory). */
  composeServiceCandidates: v.optional(v.array(provisioningComposeServiceCandidateSchema)),
  /** Candidate compose files for `-f` layering (base pre-selected; OS overrides opt-in). */
  composeFileCandidates: v.optional(v.array(provisioningComposeFileCandidateSchema)),
  /** `COMPOSE_PROFILES` labels the compose files declare (surfaced default-off). */
  profileCandidates: v.optional(v.array(provisioningProfileCandidateSchema)),
  /** Low-confidence SQL seed dumps to confirm as `compose-exec` seed steps. */
  seedDumpCandidates: v.optional(v.array(provisioningSeedDumpCandidateSchema)),
  /** Report-only: the repo has its own imperative bring-up ⇒ suggest the environment analyst. */
  repoCliHint: v.optional(provisioningRepoCliHintSchema),
  /**
   * `custom` only: config a matching custom provider's `detect()` extracted from its manifest(s)
   * (health port/path, deploy command, …) for the SPA to prefill. Advisory.
   */
  customConfigSeed: v.optional(v.array(provisioningCustomConfigSeedSchema)),
  /**
   * `custom` only: the OTHER manifest files a multi-file custom signature matched beyond the
   * primary `provisioning.manifestPath` (e.g. the deploy script + compose file alongside the
   * root manifest), surfaced for context.
   */
  secondaryManifestPaths: v.optional(v.array(v.string())),
  /**
   * `custom` only: every registered custom type whose `detect()` matched, produced by the
   * arbitration sweep when no `manifestId` was pre-selected. The top-ranked is reflected in
   * `provisioning.manifestId`; the list lets the user switch.
   */
  detectedManifestTypeCandidates: v.optional(v.array(detectedManifestTypeCandidateSchema)),
  /** Per-field confidence + hints for the SPA. */
  notes: v.array(provisioningDetectionNoteSchema),
})
export type ProvisioningRecommendation = v.InferOutput<typeof provisioningRecommendationSchema>

/**
 * Detect a recommended provisioning config for a service's repo (nothing persisted). The repo
 * is read at `gitRef` (absent ⇒ default branch); `directory` scopes detection to a monorepo
 * service subdirectory (absent ⇒ the repo root).
 */
export const detectServiceProvisioningSchema = v.object({
  owner: v.pipe(v.string(), v.minLength(1)),
  repo: v.pipe(v.string(), v.minLength(1)),
  /** Branch/tag/sha to read at; absent ⇒ the repo's default branch. */
  gitRef: v.optional(v.pipe(v.string(), v.minLength(1))),
  /** Service subdirectory within the repo (monorepo); absent ⇒ the repo root. */
  directory: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
  /** Optional VCS provider hint; absent ⇒ the workspace's connected provider. */
  provider: v.optional(v.picklist(['github', 'gitlab'])),
  /**
   * The provision type the user currently has SELECTED (the active tab). The detector
   * prioritizes finding THIS option before falling back to the other — e.g. on the
   * `docker-compose` tab it recommends a compose file when one exists, even if Kubernetes
   * manifests are also present. Only `kubernetes`/`docker-compose`/`custom` change the search
   * order (the others have nothing to auto-detect); absent ⇒ prefer `kubernetes` (richer).
   */
  prefer: v.optional(provisionTypeSchema),
  /**
   * `custom` only: the selected custom-manifest-type id. When PRESENT, that type's `detect()`
   * hook runs (or its `defaultManifestPath` seeds the path search when it has no hook — see
   * {@link customManifestTypeSchema}). When ABSENT with `prefer: 'custom'`, the detector runs
   * an ARBITRATION sweep across every registered custom type's `detect()` and proposes the
   * best-matching one (echoed back in `provisioning.manifestId` + `detectedManifestTypeCandidates`).
   * Ignored for other provision types.
   */
  manifestId: v.optional(manifestIdSchema),
  /**
   * `custom` only: the service's CURRENT `manifestPath`, if any. When it already points at an
   * existing file the detector keeps it; otherwise it applies the default-path search rules.
   */
  currentManifestPath: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
})
export type DetectServiceProvisioningInput = v.InferOutput<typeof detectServiceProvisioningSchema>

/**
 * Re-validate a native backend's config read back off a stored {@link EnvironmentManifest}'s
 * `providerConfig`, or throw naming what is wrong with it.
 *
 * `providerConfig` is `Record<string, unknown>` on the wire, deliberately: it is the carrier
 * for whatever settings a backend defines. So reading a config back out used to be an
 * assertion. The connect controller does validate on the way IN, but the value has been through
 * storage since: a config written before a schema change, or edited in the database, would flow
 * on as a fake-valid object and only misbehave deep inside a provision. Parsing here names the
 * offending field at the boundary instead, and every native backend re-reads its config the
 * same way rather than each picking its own wording.
 */
export function parseStoredProviderConfig<T>(
  schema: v.GenericSchema<unknown, T>,
  raw: unknown,
  label: string,
): T {
  const parsed = v.safeParse(schema, raw)
  if (parsed.success) return parsed.output
  const detail = parsed.issues
    .map((issue) => {
      const path = issue.path?.map((segment) => String(segment.key)).join('.')
      return path ? `${path}: ${issue.message}` : issue.message
    })
    .join('; ')
  throw new Error(`${label} has an invalid stored providerConfig: ${detail}`)
}
