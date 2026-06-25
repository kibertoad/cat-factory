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

/** How a config field is rendered/collected. */
export const providerConfigFieldTypeSchema = v.picklist(['text', 'password', 'select'])
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
})
export type ProviderDescriptor = v.InferOutput<typeof providerDescriptorSchema>

/** The outcome of a provider connection test (never throws to the client). */
export const connectionTestResultSchema = v.object({
  ok: v.boolean(),
  /** Human-readable detail — a success hint or the failure reason. */
  message: v.optional(v.string()),
})
export type ConnectionTestResult = v.InferOutput<typeof connectionTestResultSchema>
