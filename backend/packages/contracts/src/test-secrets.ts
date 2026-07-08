import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Sensitive per-service test credentials (SEALED).
//
// A companion to the NON-sensitive test-credential pools (`ServiceTestCredentials`,
// stored as plain JSON and rendered straight into the tester prompt): this store is for
// SENSITIVE testing credentials — e.g. a third-party API token a Tester needs to exercise
// an integration. Unlike the pools, these are:
//   - SEALED at rest by the facade `SecretCipher` (like `observability_connections`), and
//   - delivered to the Tester container OUT OF BAND — injected as environment variables the
//     agent's shell can read, NEVER rendered into the prompt text or the telemetry snapshot.
// The prompt only advertises each secret's KEY + (non-secret) DESCRIPTION so the agent knows
// which env vars exist and what each is for; the VALUES reach only the container environment.
//
// Both this and the non-sensitive pools are per SERVICE FRAME (resolved up the frame chain),
// mirroring the release-health per-block config. See docs/initiatives/tester-environment-access.md.
// ---------------------------------------------------------------------------

/**
 * An env-var-safe key: the name the secret is injected under in the Tester container's
 * environment, so it must be a valid POSIX shell variable name (letters, digits, underscore;
 * not starting with a digit). The operator names it as the system under test expects it —
 * e.g. `STRIPE_API_KEY` — and the agent references it as `$STRIPE_API_KEY`.
 */
export const testSecretKeySchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(128),
  v.regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    'must be a valid environment variable name (letters, digits and underscores, not starting with a digit)',
  ),
)

/** A non-secret note describing what a test secret is for. Rendered into the tester prompt. */
const testSecretDescriptionSchema = v.pipe(v.string(), v.trim(), v.maxLength(500))

/**
 * One sensitive test credential: the env-var name it is injected under, a non-secret
 * description (advertised to the agent), and the (write-only) secret value (sealed at rest,
 * delivered only to the container environment — never echoed back or put in a prompt).
 */
export const testSecretEntrySchema = v.object({
  key: testSecretKeySchema,
  description: testSecretDescriptionSchema,
  value: v.pipe(v.string(), v.minLength(1), v.maxLength(8192)),
})
export type TestSecretEntry = v.InferOutput<typeof testSecretEntrySchema>

/**
 * A non-secret REFERENCE to a configured test secret: the key + description, NEVER the value.
 * This is what is safe to render into the tester prompt, expose on the API, and carry on the
 * agent run context.
 */
export const testSecretRefSchema = v.object({
  key: testSecretKeySchema,
  description: testSecretDescriptionSchema,
})
export type TestSecretRef = v.InferOutput<typeof testSecretRefSchema>

/**
 * Validate a decrypted test-secret blob at the read boundary. The service calls this on the
 * JSON it decrypts so a drifted/corrupted row fails with a clear schema error here rather than
 * deep in a dispatch. (The persisted blob is `TestSecretEntry[]` — key + description + value.)
 */
export const testSecretEntriesSchema = v.array(testSecretEntrySchema)
export function parseTestSecretEntries(raw: unknown): TestSecretEntry[] {
  return v.parse(testSecretEntriesSchema, raw)
}

/** Set/replace a service's sensitive test-secret set (values write-only; keys unique). */
export const upsertServiceTestSecretsSchema = v.pipe(
  v.object({ entries: v.array(testSecretEntrySchema) }),
  v.check(
    (o) => new Set(o.entries.map((e) => e.key)).size === o.entries.length,
    'test-secret keys must be unique within a service',
  ),
  v.check((o) => o.entries.length <= 50, 'at most 50 test secrets per service'),
)
export type UpsertServiceTestSecretsInput = v.InferOutput<typeof upsertServiceTestSecretsSchema>

/** What `GET .../test-secrets` returns — the configured keys + descriptions, NEVER the values. */
export const serviceTestSecretsViewSchema = v.object({
  /** The service-frame block these secrets belong to. */
  blockId: v.string(),
  entries: v.array(testSecretRefSchema),
})
export type ServiceTestSecretsView = v.InferOutput<typeof serviceTestSecretsViewSchema>

/**
 * The non-secret summary persisted alongside the sealed values, so the view (and the tester
 * prompt) can list what is configured without decrypting anything.
 */
export function serviceTestSecretsSummary(entries: TestSecretEntry[]): TestSecretRef[] {
  return entries.map((e) => ({ key: e.key, description: e.description }))
}
