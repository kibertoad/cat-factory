import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Shared provider self-description + connection-test wire contracts.
//
// Several integrations are configured against an external system whose exact
// config is provider-specific: an ephemeral-environment provider, a self-hosted
// runner pool, a per-user repository credential (a GitHub PAT today). Rather than
// hard-code each provider's form in the SPA, a provider describes the config it
// expects via a list of {@link ProviderConfigField}s so the UI renders a form
// generically (the same idea the document/task source descriptors use), and may
// expose a {@link ConnectionTestResult}-returning probe the UI calls before save.
// ---------------------------------------------------------------------------

/**
 * How a config field is rendered/collected. `text`/`password`/`select` are the originals;
 * `number`, `checkbox`, and `textarea` were added so a NATIVE backend's typed flat fields
 * (a numeric port, a boolean skip-TLS toggle, a multi-line PEM CA bundle) render generically
 * instead of forcing a bespoke per-backend form. The wire value stays a string in every case
 * (`"8080"`, `"true"`, the PEM text); the backend coerces + Valibot-validates it on register.
 */
export const providerConfigFieldTypeSchema = v.picklist([
  'text',
  'password',
  'select',
  'number',
  'checkbox',
  'textarea',
])
export type ProviderConfigFieldType = v.InferOutput<typeof providerConfigFieldTypeSchema>

/** One config value a provider needs, rendered as a single form field. */
export const providerConfigFieldSchema = v.object({
  /** Stable key the value is stored/sent under (e.g. `apiToken`, `PROJECT_ID`). */
  key: v.string(),
  /** Human label for the form field. */
  label: v.string(),
  /** Optional helper text shown under the field. */
  help: v.optional(v.string()),
  /** Optional input placeholder. */
  placeholder: v.optional(v.string()),
  /** Render as a password input and never echo the value back. */
  secret: v.optional(v.boolean()),
  /** Whether the value is required to connect (absent ⇒ optional). */
  required: v.optional(v.boolean()),
  /** Field type; absent is treated as `text`. */
  type: v.optional(providerConfigFieldTypeSchema),
  /** Choices for a `select` field. */
  options: v.optional(v.array(v.object({ value: v.string(), label: v.string() }))),
  /**
   * The provider/manifest's default for this field. When present, the value is
   * optional in practice: leaving the form field blank falls back to this default
   * (so the UI shows an empty input with a "defaulted to …" hint, and clearing an
   * override reverts to it). Never set for secrets — those have no default and must
   * be supplied explicitly. A `required` field WITHOUT a default is what drives the
   * unconfigured-provider banner (see {@link ProviderDescriptor.missingRequired}).
   */
  default: v.optional(v.string()),
})
export type ProviderConfigField = v.InferOutput<typeof providerConfigFieldSchema>

/**
 * What the SPA needs to render a provider's config form. `kind` distinguishes a
 * `native` provider (a code-injected adapter with its own auth, fully described
 * by `configFields`) from the generic `manifest` providers (configured via the
 * hand-authored manifest editor — `configFields` then just reflects the secret
 * keys the current manifest references).
 */
export const providerDescriptorSchema = v.object({
  providerId: v.string(),
  label: v.string(),
  kind: v.picklist(['native', 'manifest']),
  configFields: v.array(providerConfigFieldSchema),
  /** Whether the provider implements a connection test the UI can call. */
  supportsTest: v.boolean(),
  /**
   * Keys of `configFields` that are `required`, have no `default`, and have no
   * stored value for this workspace yet (e.g. an unset API token). Empty ⇒ the
   * provider is fully configured. Non-empty while a provider is registered for the
   * instance is exactly the "loud banner" signal: the org still has to supply these
   * before the provider can be used. Computed server-side so the form, the banner,
   * and the register-time validation all read one source of truth.
   */
  missingRequired: v.array(v.string()),
  /**
   * Whether the provider implements a mechanical repo-config validation the UI can
   * call ("validate repo" button) and the engine runs as a provision pre-flight.
   */
  supportsRepoValidation: v.optional(v.boolean()),
  /**
   * Whether the provider can mechanically bootstrap its config file into a repo
   * ("set up config" flow). When true, `bootstrapInputs` carries the form fields.
   */
  supportsRepoBootstrap: v.optional(v.boolean()),
  /** The variables the bootstrap form should collect (empty unless `supportsRepoBootstrap`). */
  bootstrapInputs: v.optional(v.array(providerConfigFieldSchema)),
  /**
   * For a NATIVE provider: the base manifest the SPA overlays the flat `configFields`
   * values onto before POSTing (so the connect form is flat fields but storage stays a
   * single full manifest — see `backend/docs/native-environment-adapter.md`). A `secret`
   * field → the secret bundle, a non-secret field → `providerConfig[key]` (a `baseUrl`
   * field → `baseUrl`). Absent ⇒ a manifest-authored provider (the SPA edits the manifest
   * directly). Provider-specific JSON (an EnvironmentManifest or RunnerPoolManifest shape)
   * carrying NO secret values — only the shape + secret-ref keys.
   */
  manifestTemplate: v.optional(v.record(v.string(), v.unknown())),
  /**
   * The provider's CURRENT saved manifest, when a connection exists. Non-secret: the
   * manifest only carries secret-ref key NAMES (the actual values live in the encrypted
   * bundle and are never returned), so this is safe to expose. The native connect form
   * overlays edited fields onto THIS (falling back to `manifestTemplate` on a first
   * connect), so re-saving preserves previously-stored `providerConfig` — including nested
   * values the flat form doesn't render — instead of silently dropping it. Absent ⇒ no
   * connection yet.
   */
  savedManifest: v.optional(v.record(v.string(), v.unknown())),
  /**
   * The runner-backend analogue of `manifestTemplate`/`savedManifest` for a NATIVE backend
   * whose config is a discriminated `{ kind, <payload> }` object (Kubernetes, EKS, …) rather
   * than a manifest. It is the base config object the SPA overlays the flat `configFields`
   * onto: every non-secret field is written to the SINGLE non-`kind` payload key, each secret
   * field to the write-only bundle, and the assembled `{ kind, <payload> }` is POSTed as the
   * register `config`. When a connection exists this is the STORED config, so a re-save
   * preserves advanced API-only fields (resources / nodeSelector / …) the flat form never
   * renders; on a first connect it is the empty skeleton. Absent ⇒ a manifest-style provider
   * (use `manifestTemplate`/the manifest editor instead). Carries NO secret values.
   */
  configTemplate: v.optional(v.record(v.string(), v.unknown())),
  /**
   * Current stored NON-SECRET flat values (keyed by `configFields[].key`) for prefilling a
   * native flat-field form, so an edit shows the live config instead of blanks. Secrets are
   * never included (write-only). Absent ⇒ no connection yet.
   */
  values: v.optional(v.record(v.string(), v.string())),
})
export type ProviderDescriptor = v.InferOutput<typeof providerDescriptorSchema>

/** The outcome of a provider connection test (never throws to the client). */
export const connectionTestResultSchema = v.object({
  ok: v.boolean(),
  /** Human-readable detail — a success hint or the failure reason. */
  message: v.optional(v.string()),
})
export type ConnectionTestResult = v.InferOutput<typeof connectionTestResultSchema>

/** Severity of a single repo-config validation finding. */
export const repoValidationSeveritySchema = v.picklist(['error', 'warning'])
export type RepoValidationSeverity = v.InferOutput<typeof repoValidationSeveritySchema>

/** One finding from a provider repo-config validation. */
export const repoValidationIssueSchema = v.object({
  severity: repoValidationSeveritySchema,
  message: v.string(),
  /** The repo-relative path the issue concerns, when applicable (e.g. `.deploy.yml`). */
  path: v.optional(v.string()),
})
export type RepoValidationIssue = v.InferOutput<typeof repoValidationIssueSchema>

/** The outcome of a provider's repo-config validation (never throws to the client). */
export const repoValidationResultSchema = v.object({
  ok: v.boolean(),
  issues: v.array(repoValidationIssueSchema),
})
export type RepoValidationResult = v.InferOutput<typeof repoValidationResultSchema>

/**
 * The outcome of a "bootstrap provider config in repo" operation: whether the repo
 * now satisfies the provider (`ok`), whether anything was written (`committed`), where
 * (`branch`/`prUrl`), whether the agent fallback ran (`usedAgent`), and any residual
 * issues. Never throws to the client.
 *
 * When the agent fallback is taken the repair runs ASYNCHRONOUSLY (a durable
 * `env-config-repair` agent run), so the call returns immediately with `usedAgent:true`,
 * `repairJobId` set, and `ok:false` (not yet re-validated): the caller tracks the repair
 * job (snapshot + `env-config-repair` events) for the post-repair outcome.
 */
export const bootstrapRepoResultSchema = v.object({
  ok: v.boolean(),
  committed: v.boolean(),
  branch: v.optional(v.string()),
  prUrl: v.optional(v.string()),
  usedAgent: v.optional(v.boolean()),
  /**
   * Set when the async repair agent was dispatched: the id of the `env-config-repair`
   * run to track for the post-repair re-validation outcome. Absent ⇒ no agent ran.
   */
  repairJobId: v.optional(v.string()),
  issues: v.array(repoValidationIssueSchema),
})
export type BootstrapRepoResult = v.InferOutput<typeof bootstrapRepoResultSchema>
