import * as v from 'valibot'
import {
  customBackendKindSchema,
  eksClusterFieldsSchema,
  nonEmpty,
  urlString,
} from './primitives.js'
import { stackRecipeSchema } from './stack-recipes.js'

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
 * A reference to a credential by logical key. Resolves against the workspace's
 * encrypted secret bundle (supplied at registration), not an env var.
 */
export const environmentSecretRefSchema = v.object({
  key: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_.-]+$/), v.minLength(1), v.maxLength(64)),
})
export type EnvironmentSecretRef = v.InferOutput<typeof environmentSecretRefSchema>

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
 */
export const provisionTypeSchema = v.picklist([
  'kubernetes',
  'docker-compose',
  'custom',
  'infraless',
])
export type ProvisionType = v.InferOutput<typeof provisionTypeSchema>

/**
 * Machine-readable cause of an environment-provisioning failure, surfaced on the run's
 * {@link AgentFailure.reason} so the SPA can render precise, actionable guidance instead of
 * string-matching the provider prose (the failure analogue of {@link ConflictReason}).
 *  - `deploy_runner_unwired` — the service's provider needs a container-backed deploy (a real
 *    render/apply) but no deploy runner is wired on this deployment. The fix is deployment-level
 *    config (a runner pool / `LOCAL_DEPLOY_RUNTIME` / the Cloudflare DeployContainer binding), so
 *    the SPA gates its runtime-specific hint on this reason rather than on the prose.
 */
export const environmentFailureReasonSchema = v.picklist(['deploy_runner_unwired'])
export type EnvironmentFailureReason = v.InferOutput<typeof environmentFailureReasonSchema>

/**
 * The engine a workspace/user handler uses to stand up / connect to an environment for a
 * provision type. `none` is the synthetic engine for `infraless`. `local-docker` runs a
 * compose stack locally; `local-k3s`/`remote-kubernetes` drive a kube apiserver;
 * `remote-custom` is the generic BYO HTTP management API.
 */
export const infraEngineSchema = v.picklist([
  'local-docker',
  'local-k3s',
  'remote-kubernetes',
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
// Kubernetes ephemeral-environment backend.
//
// A native backend that deploys an operator-authored set of k3s/Kubernetes
// manifests into a per-PR namespace, reached over the kube-apiserver via HTTPS
// (the same client the Kubernetes RUNNER backend uses). Unlike the manifest
// HTTP provider, this is NOT a declarative HTTP template: the apiserver is driven
// directly. The ServiceAccount bearer token lives in the encrypted secret bundle
// (key `apiToken`, shared with the runner backend); everything non-secret is
// config here.
// ---------------------------------------------------------------------------

/** The secret-bundle key the Kubernetes env backend reads the ServiceAccount token from. */
export const KUBERNETES_ENV_TOKEN_SECRET_KEY = 'apiToken'

/** A `{{var}}`-templated string rendered against the provision vars. */
const templateString = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500))

/**
 * A PINNED helm chart version: an exact SemVer (optionally `v`-prefixed, with optional
 * pre-release / build metadata). Floating tags (`latest`, `*`, `^1.0`, `1.x`, ranges) are
 * rejected so provisioning is deterministic.
 */
const pinnedChartVersion = v.pipe(
  v.string(),
  v.trim(),
  v.regex(
    /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
    'version must be a pinned semver (e.g. 1.2.3), not a floating tag like latest or ^1.0.',
  ),
)

/**
 * How the manifests at `path` are turned into apiserver-ready resources. `raw` (the
 * default, and the only one the in-Worker native REST adapter handles) treats `path` as
 * a single manifest file or a flat directory of already-valid YAML docs. `kustomize`
 * treats `path` as an overlay directory (`kustomization.yaml` + `resources`/`components`/
 * `bases`) that must be `kustomize build`-rendered before apply — which only the
 * container-backed deploy adapter can do (it shells out to real `kustomize`/`helm`).
 */
export const kubernetesRendererSchema = v.picklist(['raw', 'kustomize'])
export type KubernetesRenderer = v.InferOutput<typeof kubernetesRendererSchema>

/**
 * Where the per-PR manifests are read from. `colocated` reads them from the block's
 * own repo at the PR head branch; `separate` reads them from a different repo (the
 * Kubernetes definition often lives outside the service repo). `renderer` (absent ⇒
 * `raw`) selects how `path` is turned into resources; `kustomize` requires the
 * container-backed deploy adapter.
 */
export const kubernetesManifestSourceSchema = v.variant('type', [
  v.object({
    type: v.literal('colocated'),
    /** File or directory path within the PR repo (read at the PR head branch). */
    path: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
    renderer: v.optional(kubernetesRendererSchema),
  }),
  v.object({
    type: v.literal('separate'),
    /** `owner/repo` of the manifests repo. */
    repo: v.pipe(v.string(), v.trim(), v.regex(/^[^/\s]+\/[^/\s]+$/, 'must be "owner/repo"')),
    /** Branch/tag/sha to read at; absent ⇒ that repo's default branch. */
    ref: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
    /** File or directory path within the manifests repo. */
    path: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
    renderer: v.optional(kubernetesRendererSchema),
  }),
])
export type KubernetesManifestSource = v.InferOutput<typeof kubernetesManifestSourceSchema>

/** How the environment URL is derived once the manifests are applied. */
export const kubernetesUrlSourceSchema = v.variant('source', [
  v.object({
    source: v.literal('ingressTemplate'),
    /** Host template, e.g. `{{branch}}.preview.example.com`; rendered with the provision vars. */
    hostTemplate: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
    scheme: v.optional(v.picklist(['http', 'https'])),
  }),
  v.object({
    source: v.literal('ingressStatus'),
    /** Ingress object to read `.status.loadBalancer` from; absent ⇒ the only Ingress applied. */
    ingressName: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
    scheme: v.optional(v.picklist(['http', 'https'])),
  }),
  v.object({
    source: v.literal('serviceStatus'),
    /** Service object to read `.status.loadBalancer` (k3s ServiceLB) from. */
    serviceName: v.pipe(v.string(), v.trim(), v.minLength(1)),
    port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535))),
    scheme: v.optional(v.picklist(['http', 'https'])),
  }),
  v.object({
    source: v.literal('gatewayStatus'),
    /** Gateway-API `Gateway` to read `.status.addresses[]` from; absent ⇒ the only one applied. */
    gatewayName: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
    scheme: v.optional(v.picklist(['http', 'https'])),
  }),
  v.object({
    source: v.literal('httpRouteStatus'),
    /** `HTTPRoute` whose `parentRefs` resolve to the Gateway address; absent ⇒ the only one applied. */
    httpRouteName: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
    scheme: v.optional(v.picklist(['http', 'https'])),
  }),
])
export type KubernetesUrlSource = v.InferOutput<typeof kubernetesUrlSourceSchema>

export const kubernetesEnvironmentConfigSchema = v.object({
  /** Human label for the connection (shown in the UI). */
  label: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  /** kube-apiserver root URL, e.g. `https://my-cluster.example:6443`. */
  apiServerUrl: urlString,
  /** PEM CA bundle to verify the apiserver TLS cert (omit only for a publicly-trusted CA). */
  caCertPem: v.optional(v.string()),
  /** Skip apiserver TLS verification — strongly discouraged; kind/dev clusters only. */
  insecureSkipTlsVerify: v.optional(v.boolean()),
  /**
   * Namespace name template for the per-PR environment, e.g. `cf-env-{{pullNumber}}`.
   * Rendered with the provision vars then sanitized to an RFC1123 label; absent ⇒ a
   * default derived from the PR number / block id.
   */
  namespaceTemplate: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))),
  /** Where the manifests are read from (co-located in the PR repo, or a separate repo). */
  manifestSource: kubernetesManifestSourceSchema,
  /** How the environment URL is derived once applied. */
  url: kubernetesUrlSourceSchema,
  /**
   * Optional image reference made available to the manifests as `{{image}}` (e.g. a
   * CI-built image tagged by branch/sha). Itself a template over the provision vars.
   */
  imageTemplate: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
  /** Fallback TTL (ms) after which the env is swept + torn down. */
  defaultTtlMs: v.optional(v.pipe(v.number(), v.minValue(60000))),
  /**
   * How long (seconds) the container deploy adapter waits for each Deployment to roll out
   * before reporting the env still `provisioning` (the backend keeps polling). Only the
   * container-backed render path honors it; absent ⇒ the harness default (180s).
   */
  rolloutTimeoutSeconds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  /** Extra labels stamped on the namespace + every applied resource. */
  labels: v.optional(v.record(v.string(), v.string())),
  /** Extra annotations stamped on the namespace. */
  annotations: v.optional(v.record(v.string(), v.string())),
})
export type KubernetesEnvironmentConfig = v.InferOutput<typeof kubernetesEnvironmentConfigSchema>

// ---------------------------------------------------------------------------
// Kustomize / Helm render inputs (container-backed deploy adapter only).
//
// These ride a service's provisioning (the "what/where") and are consumed by the
// container deploy adapter, which runs real `kubectl`/`kustomize`/`helm`. The native
// in-Worker REST adapter ignores them (raw manifests only). Values for any `secretRef`
// resolve from the workspace encrypted bundle at provision time — the config carries
// secret KEYS, never values (the same invariant the manifest-HTTP provider enforces).
// ---------------------------------------------------------------------------

/**
 * A structured image override (the kustomize `images:` equivalent, generalizing the
 * legacy `{{image}}` text substitution). Matches a container image by `name` and
 * overrides its repo and/or tag/digest; the override values are templated over the
 * provision vars (e.g. `newTagTemplate: '{{branch}}'`).
 */
export const kubernetesImageOverrideSchema = v.pipe(
  v.object({
    /** The image to match (the `name:` in a kustomization `images:` entry), e.g. `registry/app`. */
    name: nonEmpty,
    /** Optional replacement repo, templated; absent ⇒ keep the original repo. */
    newNameTemplate: v.optional(templateString),
    /** Replacement tag, templated (e.g. `{{branch}}` / `{{sha}}`); mutually exclusive with digest. */
    newTagTemplate: v.optional(templateString),
    /** Replacement digest, templated; alternative to a tag. */
    digestTemplate: v.optional(templateString),
  }),
  v.check(
    (o) =>
      o.newNameTemplate !== undefined ||
      o.newTagTemplate !== undefined ||
      o.digestTemplate !== undefined,
    'an image override must set at least one of newNameTemplate, newTagTemplate, or digestTemplate.',
  ),
  v.check(
    (o) => !(o.newTagTemplate !== undefined && o.digestTemplate !== undefined),
    'newTagTemplate and digestTemplate are mutually exclusive on an image override.',
  ),
)
export type KubernetesImageOverride = v.InferOutput<typeof kubernetesImageOverrideSchema>

/** A single templated `--set path=value` for a helm release. */
export const kubernetesHelmSetSchema = v.object({
  /** Dotted `--set` path, e.g. `config.rateLimit.enabled`. */
  path: nonEmpty,
  /** The value, templated over the provision vars. */
  valueTemplate: v.pipe(v.string(), v.trim(), v.maxLength(2000)),
})
export type KubernetesHelmSet = v.InferOutput<typeof kubernetesHelmSetSchema>

/**
 * A helm release the deploy adapter installs/upgrades (`helm upgrade --install`).
 * `scope: 'shared'` is a cluster singleton (installed once, never torn down per-PR —
 * e.g. an ingress/gateway controller); `per-environment` (the default) re-installs in
 * each per-PR namespace. The `version` pin is required so provisioning is deterministic.
 */
export const kubernetesHelmReleaseSchema = v.object({
  /** Release name. */
  name: nonEmpty,
  /** Chart ref: an OCI ref (`oci://…`) or, with `repo`, a `repo/chart` name. */
  chart: nonEmpty,
  /** Chart repo URL; absent ⇒ `chart` is an OCI ref. */
  repo: v.optional(urlString),
  /** PINNED chart version, e.g. `1.2.3` / `v1.2.3` (floating tags like `latest`/`^1.0` rejected). */
  version: pinnedChartVersion,
  /** Namespace to install into, templated; absent ⇒ the environment namespace. */
  namespaceTemplate: v.optional(templateString),
  /** Inline `--values` overrides. */
  values: v.optional(v.record(v.string(), v.unknown())),
  /** Templated `--set` overrides. */
  set: v.optional(v.array(kubernetesHelmSetSchema)),
  /** Secret-bundle-backed values folded in at provision time (`--set <path>=<secret>`). */
  valuesSecretRefs: v.optional(
    v.array(v.object({ path: nonEmpty, secretRef: environmentSecretRefSchema })),
  ),
  scope: v.optional(v.picklist(['per-environment', 'shared'])),
})
export type KubernetesHelmRelease = v.InferOutput<typeof kubernetesHelmReleaseSchema>

/** One entry inside an injected Secret: a logical key mapped to a secret-bundle ref OR a templated value. */
export const kubernetesSecretEntrySchema = v.pipe(
  v.object({
    /** Key inside the rendered Secret / `.env`. */
    key: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_.-]+$/), v.minLength(1), v.maxLength(256)),
    /** Resolve the value from the workspace encrypted bundle by key. */
    secretRef: v.optional(environmentSecretRefSchema),
    /** OR a non-secret value, templated over the provision vars. */
    valueTemplate: v.optional(v.pipe(v.string(), v.maxLength(2000))),
  }),
  v.check(
    (e) => (e.secretRef === undefined) !== (e.valueTemplate === undefined),
    'a secret entry must set exactly one of secretRef or valueTemplate.',
  ),
)
export type KubernetesSecretEntry = v.InferOutput<typeof kubernetesSecretEntrySchema>

/**
 * How the deploy adapter feeds resolved secret values in before apply, discriminated by
 * `mode`. The mapping of logical keys is in-repo intent; the values resolve from the
 * encrypted bundle at provision time (the config carries secret KEYS, never values).
 *
 * - `secret`: materialize a `Secret` resource named `secretName` directly in the namespace.
 * - `generatorEnvFile`: write the entries as a `KEY=value` `.env` file at `envFilePath`
 *   (repo-relative, inside the overlay tree) BEFORE `kustomize build`, so the overlay's own
 *   existing `secretGenerator` consumes it. This is the common ephemeral-environment shape
 *   where a Component declares `secretGenerator: { envs: ['.env'] }`, the Secret is named by
 *   the overlay, and the real `.env` is supplied at deploy time (e.g. from a secrets manager).
 *   Use this instead of `secret` when the manifests already declare a `secretGenerator`, so
 *   the two don't collide.
 */
export const kubernetesSecretInjectionSchema = v.variant('mode', [
  v.object({
    mode: v.literal('secret'),
    /** Target Secret name in the namespace. */
    secretName: nonEmpty,
    /** Secret `type`; absent ⇒ `Opaque`. */
    secretType: v.optional(nonEmpty),
    entries: v.array(kubernetesSecretEntrySchema),
  }),
  v.object({
    mode: v.literal('generatorEnvFile'),
    /**
     * Repo-relative path within the overlay tree to write the `KEY=value` env file the
     * overlay's `secretGenerator` reads (e.g. `overlays/<env>/<component>/.env`). The
     * overlay names the Secret.
     */
    envFilePath: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
    entries: v.array(kubernetesSecretEntrySchema),
  }),
])
export type KubernetesSecretInjection = v.InferOutput<typeof kubernetesSecretInjectionSchema>

/**
 * The full Kubernetes provision config the deploy adapter consumes: the combined cluster +
 * URL + manifest-source config PLUS the kustomize/helm render inputs (image overrides, helm
 * releases, secret injections). It is assembled at provision time by MERGING the workspace
 * kube engine config (the "how": apiserver, sizing, shared helm releases) with the service's
 * own provisioning (the "what/where": manifest source, per-environment helm releases, image
 * overrides, secret injections) — so the provider reads everything it needs from one place.
 * The native in-Worker REST adapter ignores the render fields (raw manifests only); the
 * container-backed deploy adapter consumes them. Carries secret KEYS, never values.
 */
export const kubernetesProvisionConfigSchema = v.object({
  ...kubernetesEnvironmentConfigSchema.entries,
  /** Structured image overrides (the kustomize `images:` shape), templated over provision vars. */
  images: v.optional(v.array(kubernetesImageOverrideSchema)),
  /** Helm releases to install — workspace-shared singletons merged with the service's per-env ones. */
  helmReleases: v.optional(v.array(kubernetesHelmReleaseSchema)),
  /** Secrets fed in before apply (a `Secret` resource or a `secretGenerator` `.env`). */
  secretInjections: v.optional(v.array(kubernetesSecretInjectionSchema)),
})
export type KubernetesProvisionConfig = v.InferOutput<typeof kubernetesProvisionConfigSchema>

/**
 * The AWS EKS provision config: the full Kubernetes provision config (an EKS apiserver is a
 * standard apiserver, so per-PR namespaces + manifest apply are identical) PLUS the AWS
 * `region` + `clusterName` needed to mint the IAM apiserver token. The AWS credentials ride
 * the secret bundle; the SigV4/STS minting lives in `@cat-factory/eks`.
 */
export const eksProvisionConfigSchema = v.object({
  ...kubernetesProvisionConfigSchema.entries,
  ...eksClusterFieldsSchema.entries,
})
export type EksProvisionConfig = v.InferOutput<typeof eksProvisionConfigSchema>

/** Built-in environment backend kinds the contract knows by name. */
export const RESERVED_ENVIRONMENT_BACKEND_KINDS = ['manifest', 'kubernetes', 'eks'] as const

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
   * Namespace name template for the per-PR environment, e.g. `cf-env-{{pullNumber}}`. With
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
  status: environmentStatusSchema,
  /** Present only on the dedicated access endpoint / in agent context. */
  access: v.optional(environmentAccessHandleSchema),
  createdAt: v.number(),
  expiresAt: v.nullable(v.number()),
  lastError: v.nullable(v.string()),
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
   * `custom` only: the selected custom-manifest-type id. Its `defaultManifestPath` seeds the
   * path search (see {@link customManifestTypeSchema}). Ignored for other provision types.
   */
  manifestId: v.optional(manifestIdSchema),
  /**
   * `custom` only: the service's CURRENT `manifestPath`, if any. When it already points at an
   * existing file the detector keeps it; otherwise it applies the default-path search rules.
   */
  currentManifestPath: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
})
export type DetectServiceProvisioningInput = v.InferOutput<typeof detectServiceProvisioningSchema>
