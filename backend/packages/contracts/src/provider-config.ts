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
})
export type ProviderDescriptor = v.InferOutput<typeof providerDescriptorSchema>

/** The outcome of a provider connection test (never throws to the client). */
export const connectionTestResultSchema = v.object({
  ok: v.boolean(),
  /** Human-readable detail — a success hint or the failure reason. */
  message: v.optional(v.string()),
})
export type ConnectionTestResult = v.InferOutput<typeof connectionTestResultSchema>
