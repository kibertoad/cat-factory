import * as v from 'valibot'

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
   * Opaque, provider-specific configuration for a *native* injected adapter (e.g. a
   * Kargo project, link-selection key, status map). The generic HttpEnvironmentProvider
   * ignores it entirely; a native adapter (injected via `buildNodeContainer({
   * environmentProvider })` / `startLocal({ environmentProvider })`) reads + validates it
   * off the per-call `manifest`. This is the per-WORKSPACE config carrier for native
   * adapters — the deployment-wide provider singleton has no other way to receive
   * per-workspace settings. NOT covered by the manifest URL/SSRF checks (which only guard
   * `baseUrl`/`tokenUrl`); an adapter that puts a URL here must guard it itself (reuse the
   * exported `UrlSafetyPolicy`). See `backend/docs/native-environment-adapter.md`.
   */
  providerConfig: v.optional(v.record(v.string(), v.unknown())),
})
export type EnvironmentManifest = v.InferOutput<typeof environmentManifestSchema>

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
  providerId: v.string(),
  label: v.string(),
  baseUrl: v.string(),
  connectedAt: v.number(),
  /** Which secret keys are set (names only), so the UI can show completeness. */
  secretKeys: v.array(v.string()),
})
export type EnvironmentConnection = v.InferOutput<typeof environmentConnectionSchema>

// ---- Request bodies -------------------------------------------------------

/**
 * Register (or replace) a workspace's environment provider. The org supplies the
 * actual per-tenant secret values here (write-only); they are encrypted and
 * stored in D1 and never returned. Every `secretRef.key` in the manifest must
 * have a matching entry in `secrets`.
 */
export const registerEnvironmentProviderSchema = v.object({
  manifest: environmentManifestSchema,
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

/** Manually provision an environment (outside a pipeline run). */
export const provisionEnvironmentSchema = v.object({
  blockId: v.optional(v.pipe(v.string(), v.minLength(1))),
  inputs: v.optional(v.record(v.string(), v.string())),
})
export type ProvisionEnvironmentInput = v.InferOutput<typeof provisionEnvironmentSchema>
