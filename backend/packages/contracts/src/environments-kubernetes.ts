import * as v from 'valibot'
import {
  eksClusterFieldsSchema,
  environmentSecretRefSchema,
  nonEmpty,
  urlString,
} from './primitives.js'

// The native Kubernetes ephemeral-environment backend's wire contracts, plus the EKS superset
// that reuses every one of them. Split out of `environments.ts`, which had grown past its size
// budget: this is the one block in it that is about a SINGLE backend's config rather than about
// the environment model every backend shares, and `environments.ts` re-exports nothing of it —
// the package index exports both files, so an importer sees one surface either way.

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
    /**
     * Host port the ingress controller is reached on, when it is not the scheme's default. It has
     * to live here rather than inside `hostTemplate`, because the rendered template is ALSO the
     * Ingress `spec.rules[].host` the manifests declare (`provision-detect` reads one back out of
     * a scanned Ingress), and Kubernetes rejects a `host` carrying a port. A local cluster that
     * publishes its controller on 18080 is the case that needs it.
     */
    port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535))),
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

/**
 * Whether a stored value is still a `source` this build knows how to derive a URL from —
 * DERIVED from the variant's own members, so it cannot drift from them the way a second
 * hand-written list would (the {@link isBinaryModality} treatment, for the same reason).
 *
 * The discriminant is a closed vocabulary that is nonetheless PERSISTED, on every stored
 * Kubernetes environment config. A reader that maps it through an exhaustive `switch` is
 * therefore total against the TYPE and partial against the DATA: a config written by a
 * deployment that knows a source this one does not falls off the end of every branch. Narrow
 * with this before assigning a stored value anywhere the exhaustive switch will see it.
 */
export function isKubernetesUrlSource(value: unknown): value is KubernetesUrlSource['source'] {
  return typeof value === 'string' && KUBERNETES_URL_SOURCES.has(value)
}

const KUBERNETES_URL_SOURCES: ReadonlySet<string> = new Set(
  kubernetesUrlSourceSchema.options.map((option) => option.entries.source.literal),
)

/**
 * What it takes to REACH a cluster's apiserver, split out of the full config below.
 *
 * Standing an environment up needs the whole config; reclaiming one needs only this. That
 * split is load-bearing rather than cosmetic: a stored config is re-parsed on the way out
 * ({@link parseStoredProviderConfig}), so a `manifestSource` or `url` block that stopped
 * matching the contract would otherwise refuse the teardown too, and an environment nobody
 * can reclaim goes on costing money until a human notices. Teardown validates what it uses
 * and nothing else, so drift in the provisioning half can never strand a live namespace.
 *
 * `apiServerUrl` is not in that forgiving set, deliberately: it stays REQUIRED because there is
 * no safe default for "which cluster", and a DELETE aimed at a guessed one is worse than a
 * refusal.
 */
export const kubernetesConnectionConfigSchema = v.object({
  /** kube-apiserver root URL, e.g. `https://my-cluster.example:6443`. */
  apiServerUrl: urlString,
  /** PEM CA bundle to verify the apiserver TLS cert (omit only for a publicly-trusted CA). */
  caCertPem: v.optional(v.string()),
  /** Skip apiserver TLS verification — strongly discouraged; kind/dev clusters only. */
  insecureSkipTlsVerify: v.optional(v.boolean()),
})
export type KubernetesConnectionConfig = v.InferOutput<typeof kubernetesConnectionConfigSchema>

export const kubernetesEnvironmentConfigSchema = v.object({
  ...kubernetesConnectionConfigSchema.entries,
  /** Human label for the connection (shown in the UI). */
  label: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
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

/**
 * The EKS counterpart of {@link kubernetesConnectionConfigSchema}: what it takes to reach the
 * cluster, which on EKS includes the AWS coordinates the apiserver token is minted against.
 * Same split, same reason — a reclaim validates the connection and not the provisioning recipe.
 */
export const eksConnectionConfigSchema = v.object({
  ...kubernetesConnectionConfigSchema.entries,
  ...eksClusterFieldsSchema.entries,
})
export type EksConnectionConfig = v.InferOutput<typeof eksConnectionConfigSchema>
