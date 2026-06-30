import * as v from 'valibot'
import { customBackendKindSchema } from './primitives.js'

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

const nonEmpty = v.pipe(v.string(), v.minLength(1))
const urlString = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2000))

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
   * Opaque, provider-specific configuration for a CUSTOM backend (e.g. a Kargo project,
   * link-selection key, status map). The generic HttpEnvironmentProvider ignores it
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

/**
 * Where the per-PR manifests are read from. `colocated` reads them from the block's
 * own repo at the PR head branch; `separate` reads them from a different repo (the
 * Kubernetes definition often lives outside the service repo).
 */
export const kubernetesManifestSourceSchema = v.variant('type', [
  v.object({
    type: v.literal('colocated'),
    /** File or directory path within the PR repo (read at the PR head branch). */
    path: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
  }),
  v.object({
    type: v.literal('separate'),
    /** `owner/repo` of the manifests repo. */
    repo: v.pipe(v.string(), v.trim(), v.regex(/^[^/\s]+\/[^/\s]+$/, 'must be "owner/repo"')),
    /** Branch/tag/sha to read at; absent ⇒ that repo's default branch. */
    ref: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
    /** File or directory path within the manifests repo. */
    path: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
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
  /** Extra labels stamped on the namespace + every applied resource. */
  labels: v.optional(v.record(v.string(), v.string())),
  /** Extra annotations stamped on the namespace. */
  annotations: v.optional(v.record(v.string(), v.string())),
})
export type KubernetesEnvironmentConfig = v.InferOutput<typeof kubernetesEnvironmentConfigSchema>

/** Built-in environment backend kinds the contract knows by name. */
export const RESERVED_ENVIRONMENT_BACKEND_KINDS = ['manifest', 'kubernetes'] as const

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
  v.object({ kind: v.literal('kubernetes'), kubernetes: kubernetesEnvironmentConfigSchema }),
  v.object({ kind: customEnvironmentBackendKindSchema, manifest: environmentManifestSchema }),
])
export type EnvironmentBackendConfig = v.InferOutput<typeof environmentBackendConfigSchema>
export type EnvironmentBackendKind = EnvironmentBackendConfig['kind']

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

/** Manually provision an environment (outside a pipeline run). */
export const provisionEnvironmentSchema = v.object({
  blockId: v.optional(v.pipe(v.string(), v.minLength(1))),
  inputs: v.optional(v.record(v.string(), v.string())),
})
export type ProvisionEnvironmentInput = v.InferOutput<typeof provisionEnvironmentSchema>
