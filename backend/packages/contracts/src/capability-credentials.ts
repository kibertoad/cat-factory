import * as v from 'valibot'
import {
  isReservedPlatformEnvKey,
  isToolchainEnvName,
  reservedEnvKeyMessage,
  toolchainEnvNameMessage,
} from './reserved-env-keys.js'

// ---------------------------------------------------------------------------
// PER-WORKSPACE capability credentials (SEALED) — the tenant-scoped home for the secrets a
// registered capability declares.
//
// A tool server (MCP) and a generative binary integration each declare the credential they need
// BY NAME, and the value is resolved per dispatch through the kernel `ToolSecretResolver`. The
// shipped default reads that name off the DEPLOYMENT'S OWN ENVIRONMENT, which is the right answer
// for a single-tenant install and the wrong one for every other shape: one process serves many
// workspaces, so one variable serves them all — every tenant's runs authenticate as whoever set
// the variable, a tenant cannot supply its own vendor account, rotating one tenant's key means a
// redeploy, and the value is visible to every operator with shell access to the host.
//
// Every other credential in the platform already went the other way: provider API keys, tracker /
// document / runner / observability connections, personal subscriptions, private package
// registries and the sensitive test secrets are all per-tenant rows, sealed at rest, edited in
// the UI. Capabilities are the subsystem that did not get it. This module is that store's wire
// vocabulary, and it is modelled on `test-secrets.ts` deliberately — same sealed-blob-plus-
// non-secret-summary shape, same write-only values, same "the view lists KEYS, never values".
//
// The env resolver is NOT removed. It becomes the FALLBACK: a workspace that has stored nothing
// keeps resolving exactly as before, so a local install and a single-tenant deployment need no
// migration and no UI visit. What changes is which one wins when both have a value — see
// `composeToolSecretResolvers` in `@cat-factory/server`.
// ---------------------------------------------------------------------------

/**
 * The key a stored credential answers for: the LOOKUP name the capability's definition declares,
 * which is what a resolver is asked for.
 *
 * It is not necessarily the variable the agent reads the value from. A definition that needs a
 * specific variable name in the process it configures declares `envName` beside its `key`, and
 * the store never sees that name: it stores what the resolver is ASKED for, and the injection
 * name is applied afterwards, at dispatch.
 *
 * Held to BOTH lists, which protect different things and neither implies the other:
 *
 *   - {@link isReservedPlatformEnvKey}, the platform's own configuration. Storing a value under
 *     `ENCRYPTION_KEY` would not read the deployment's key (this store answers first), but the
 *     declaration it would satisfy is refused at boot, so accepting it here lets an operator fill
 *     in a credential that can never be asked for.
 *   - {@link isToolchainEnvName}, the harness's own process. This one is belt-and-braces at this
 *     boundary rather than the real guard (the real guard is on `envName` at declaration), because
 *     a stored key with no `envName` beside it IS the injected name.
 */
export const capabilityCredentialKeySchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(128),
  v.regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    'must be a valid environment variable name (letters, digits and underscores, not starting with a digit)',
  ),
  v.check(
    (key) => !isReservedPlatformEnvKey(key),
    (issue) => reservedEnvKeyMessage(String(issue.input)),
  ),
  v.check(
    (key) => !isToolchainEnvName(key),
    (issue) => toolchainEnvNameMessage(String(issue.input)),
  ),
)

/** One stored credential: the key it answers for, and the write-only value sealed at rest. */
export const capabilityCredentialEntrySchema = v.object({
  key: capabilityCredentialKeySchema,
  value: v.pipe(v.string(), v.minLength(1), v.maxLength(8192)),
})
export type CapabilityCredentialEntry = v.InferOutput<typeof capabilityCredentialEntrySchema>

/**
 * The non-secret projection of a stored credential — what the API returns and the UI lists.
 *
 * A KEY and nothing else. There is deliberately no operator-authored description field, unlike a
 * test secret's: what a capability credential is FOR is already stated by the definition that
 * declares it (`usage`, `guidance`), and a second free-text answer beside it is a copy that can
 * disagree with the definition and always wins visually. The read that pairs stored keys with
 * their DECLARATIONS is {@link capabilityCredentialStatusSchema}.
 */
export const capabilityCredentialRefSchema = v.object({
  key: capabilityCredentialKeySchema,
  /** When the value was last written, so the UI can show age without revealing the value. */
  updatedAt: v.number(),
})
export type CapabilityCredentialRef = v.InferOutput<typeof capabilityCredentialRefSchema>

/**
 * A credential the deployment's registered capabilities actually DECLARE, joined to whether this
 * workspace has stored one.
 *
 * This is the read that makes the store usable rather than a blank key-value form. The keys a
 * workspace must fill in are not a workspace fact at all — they are a property of the
 * deployment's CODE (its `AgentKindRegistry` tool servers, its `BinaryGeneratorRegistry`) — so
 * without projecting them, an operator has to read the deployment's source to learn what to type,
 * and a typo produces a stored credential that is never asked for.
 *
 * Admin-gated on purpose. The workspace SNAPSHOT's generative-integration projection deliberately
 * omits credential key names ("a workspace viewer has no business learning which environment
 * variables the deployment sets"), and that judgement does not change because the value now lives
 * in a row: this rides the same `secrets.manage` surface as the write.
 */
export const capabilityCredentialStatusSchema = v.object({
  key: capabilityCredentialKeySchema,
  /** Which capabilities want it — id + label, so the UI can say who a key is for. */
  declaredBy: v.array(
    v.object({
      subject: v.picklist(['tool-server', 'binary-generator']),
      id: v.string(),
      label: v.string(),
      /** The definition's own note on how the value is presented, when it states one. */
      usage: v.optional(v.string()),
    }),
  ),
  /** Whether at least one declaring capability treats it as required. */
  required: v.boolean(),
  /** Whether THIS workspace has stored a value. */
  stored: v.boolean(),
  /** When the stored value was last written. Absent when nothing is stored. */
  updatedAt: v.optional(v.number()),
})
export type CapabilityCredentialStatus = v.InferOutput<typeof capabilityCredentialStatusSchema>

/** Set/replace a workspace's capability credentials. Values write-only; keys unique. */
export const upsertCapabilityCredentialsSchema = v.pipe(
  v.object({ entries: v.array(capabilityCredentialEntrySchema) }),
  v.check(
    (o) => new Set(o.entries.map((e) => e.key)).size === o.entries.length,
    'capability credential keys must be unique within a workspace',
  ),
  v.check((o) => o.entries.length <= 100, 'at most 100 capability credentials per workspace'),
)
export type UpsertCapabilityCredentialsInput = v.InferOutput<
  typeof upsertCapabilityCredentialsSchema
>

/**
 * What the credential surface returns: what this deployment's capabilities DECLARE joined to what
 * this workspace has STORED, plus any stored key nothing declares.
 *
 * The orphan half is not tidiness. A capability is deployment CODE, so a workspace's stored key
 * stops being declared whenever the deployment retires an integration or renames a variable — and
 * an orphaned credential is a live secret nobody will ever ask for, sitting sealed in a row. It is
 * reported as its own list rather than dropped from the view, for the same reason an unknown
 * generator id is named rather than filtered: the operator is the only one who can decide whether
 * to delete it or whether the deployment regressed.
 */
export const capabilityCredentialsViewSchema = v.object({
  declared: v.array(capabilityCredentialStatusSchema),
  /** Stored keys no registered capability declares. */
  orphaned: v.array(capabilityCredentialRefSchema),
  /**
   * Whether the deployment ALSO has an environment-variable fallback behind this store. False
   * when a facade wired a store-only resolver.
   *
   * Stated because it changes what an EMPTY row means: with the fallback, a key nothing is stored
   * for may still resolve from the deployment's environment, so the UI must not report it as
   * missing. "Absent" and "zero" again.
   */
  environmentFallback: v.boolean(),
  /**
   * Whether the DECLARATION half of this view is known to be incomplete — the generative
   * integrations are read through `BinaryGeneratorSource`, which THROWS rather than answering an
   * empty set when it cannot reach the mothership, and this surface must not turn that outage
   * into "no integration needs a credential".
   *
   * Its own flag rather than a failed request, because the stored half is still perfectly
   * readable and an operator locked out of their own credential list during someone else's
   * outage is a worse answer than a list with a caveat on it.
   */
  declarationsIncomplete: v.boolean(),
})
export type CapabilityCredentialsView = v.InferOutput<typeof capabilityCredentialsViewSchema>

/** Validate a decrypted blob at the read boundary, so a drifted row fails clearly and early. */
export const capabilityCredentialEntriesSchema = v.array(capabilityCredentialEntrySchema)
export function parseCapabilityCredentialEntries(raw: unknown): CapabilityCredentialEntry[] {
  return v.parse(capabilityCredentialEntriesSchema, raw)
}

/** The non-secret summary persisted beside the sealed values, so a read decrypts nothing. */
export function capabilityCredentialsSummary(
  entries: CapabilityCredentialEntry[],
  updatedAt: number,
): CapabilityCredentialRef[] {
  return entries.map((entry) => ({ key: entry.key, updatedAt }))
}
