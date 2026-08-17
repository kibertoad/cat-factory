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
 * Set ONE credential's value, leaving every other stored key sealed as it is.
 *
 * The whole-set PUT cannot serve an operator filling in a checklist. The client never received
 * the values, so re-sending the set means re-typing every secret, and sending only the edited one
 * REPLACES the set: a workspace that fills in its second credential silently deletes its first.
 * The narrow write is the twin of the per-key delete, and for the same reason.
 *
 * The key rides the path, held to {@link capabilityCredentialKeySchema} there, so a reserved name
 * is refused at this boundary rather than reaching the store.
 */
export const setCapabilityCredentialSchema = v.object({
  value: v.pipe(v.string(), v.minLength(1), v.maxLength(8192)),
})
export type SetCapabilityCredentialInput = v.InferOutput<typeof setCapabilityCredentialSchema>

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
      subject: v.picklist(['tool-server', 'binary-generator', 'foundational-service']),
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

/**
 * How many credentials one workspace may store. Exported because the per-KEY write has to hold
 * the same ceiling as the whole-set PUT, and a second literal is a second number to keep in step.
 */
export const MAX_CAPABILITY_CREDENTIALS = 100

/** Set/replace a workspace's capability credentials. Values write-only; keys unique. */
export const upsertCapabilityCredentialsSchema = v.pipe(
  v.object({ entries: v.array(capabilityCredentialEntrySchema) }),
  v.check(
    (o) => new Set(o.entries.map((e) => e.key)).size === o.entries.length,
    'capability credential keys must be unique within a workspace',
  ),
  v.check(
    (o) => o.entries.length <= MAX_CAPABILITY_CREDENTIALS,
    `at most ${MAX_CAPABILITY_CREDENTIALS} capability credentials per workspace`,
  ),
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
   * Whether the deployment ALSO has an environment-variable fallback behind this store, read off
   * the chain the facade actually COMPOSED rather than asserted by the surface that renders it.
   *
   * Stated because it changes what an EMPTY row means: with the fallback, a key nothing is stored
   * for may still resolve from the deployment's environment, so the UI must not report it as
   * missing. "Absent" and "zero" again.
   *
   * Three states, not two, because a deployment that supplied its OWN `ToolSecretResolver`
   * replaced the whole chain, and the platform cannot describe what it put there: that resolver
   * may read Vault, or the environment, or both. Absent is that answer. Rendering a guess either
   * way is the same mistake in opposite directions: `true` sends an operator away from a
   * credential nothing will resolve, `false` sends them hunting for a value that already answers.
   */
  environmentFallback: v.optional(v.boolean()),
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

// ---------------------------------------------------------------------------
// The DECLARATION half of the same subject: how a capability a DEPLOYMENT registers in code says
// which secrets it needs, which is what turns the store above from a blank form into a checklist.
//
// It lives beside the store rather than in each registry's own module because the two names a
// credential carries, and the floors over them, are properties of the injection CHANNEL (a value
// resolved through `ToolSecretResolver` and set as a variable of one job's agent process) rather
// than of what declared it. It was the generative integrations' own schema until a foundational
// STORAGE service needed the same declaration: the platform had a credential seam applied to what
// MAKES an artifact and not to where it GOES, and a second copy of the shape would have been the
// first place two declarers could disagree about a reserved key.
//
// WHO may declare one is a separate question, and the registries answer it differently: see
// `createFoundationalServiceSchema`, where only the code-registered tier may.
// ---------------------------------------------------------------------------

/**
 * ONE credential a registered capability needs, declared by NAME only, never a value.
 *
 * The value is resolved per dispatch through the facade-wired `ToolSecretResolver` port (the
 * same port a tool server's credentials go through) and written straight onto the job body,
 * where the harness injects it into THIS JOB's agent environment. It never reaches
 * `AgentRunContext`, a prompt, or the telemetry snapshot: only the key NAME does, because the
 * agent has to know which variable to read.
 *
 * A declarer states a LIST of these, because a vendor's account is not always one string. HTTP Basic over a
 * key/secret pair is the ordinary case that breaks a single field, and it is common enough to be
 * a shape rather than one vendor's eccentricity. Under one field the two halves have to be
 * colon-joined into a single variable, which rotates them together, hands the operator one
 * checklist row where their vendor console shows two values, and turns a mis-joined value into a
 * 401 indistinguishable from a wrong key.
 */
export const capabilityCredentialSchema = v.object({
  /**
   * The credential's LOOKUP key: what the secret resolver is asked for, and what a workspace
   * stores its own value under. Also the ENVIRONMENT VARIABLE the agent reads it from unless
   * {@link envName} says otherwise, so it must be a valid POSIX variable name either way: a
   * generator declaring `x-rd-token` would resolve fine and then be dropped by the harness's env
   * validation, which is a silent "the integration just 401s" at run time.
   *
   * It may NOT name a variable the platform's own configuration owns
   * ({@link isReservedPlatformEnvKey}). The resolver reads the key off the deployment's
   * environment and the value is injected into an agent process, so an integration declaring
   * `ENCRYPTION_KEY` would hand a prompt-injectable agent the deployment's master sealing key.
   * Refused here so a deployment learns at boot, and again at dispatch, since a mothership-mode
   * node boot-validates none of the definitions it resolves.
   */
  key: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(128),
    v.regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a valid environment variable name'),
    v.check(
      (key) => !isReservedPlatformEnvKey(key),
      (issue) => reservedEnvKeyMessage(String(issue.input)),
    ),
  ),
  /**
   * The environment variable the value is injected as, when that differs from {@link key}. This
   * is the name the agent is told to read, and it is what a vendor SDK that auto-reads its own
   * documented variable needs.
   *
   * Held to the toolchain rule rather than the reserved-platform one, because it reads nothing:
   * the floor above is about what may be READ off the deployment's environment, and an injection
   * name only decides what a variable is called inside this job's agent process. That is what lets
   * a declaration keep a vendor's documented name even when a platform prefix family covers it.
   */
  envName: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.minLength(1),
      v.maxLength(128),
      v.regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a valid environment variable name'),
      v.check(
        (name) => !isToolchainEnvName(name),
        (issue) => toolchainEnvNameMessage(String(issue.input)),
      ),
    ),
  ),
  /**
   * How the capability expects the credential to be presented (`X-RD-Token: <value>`,
   * `Authorization: Bearer <value>`). Folded into the brief verbatim: the agent writes the
   * request itself, and a key with no stated header is a key it has to guess the use of.
   */
  usage: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(400))),
  /**
   * When true (the default), a capability whose credential does not resolve is reported to
   * the agent as UNAVAILABLE rather than offered. Set false only for an endpoint that genuinely
   * works unauthenticated — an agent handed an API whose first call 401s burns a run
   * discovering it.
   */
  required: v.optional(v.boolean()),
})
export type CapabilityCredential = v.InferOutput<typeof capabilityCredentialSchema>

/**
 * The two names a credential carries, which is all the fallback below reads.
 *
 * Structural rather than {@link CapabilityCredential} itself, because the DISPATCH projection
 * carries a narrower shape (kernel's `ResolvedBinaryGeneratorCredential`, which drops `usage` and
 * every other prose field the container executor has no use for) and would otherwise have to
 * either widen or re-spell the fallback. A parameter type nothing outside the two names can
 * satisfy is what makes the "one place" claim below enforceable rather than aspirational.
 */
export interface CapabilityCredentialNames {
  key: string
  envName?: string
}

/**
 * The environment variable one credential arrives as: its {@link CapabilityCredential.envName}
 * when it declares one, else its lookup key.
 *
 * The ONE place that fallback is written, because three layers apply it (the schemas' uniqueness
 * checks, the dispatch-time resolvers that key the job body, and the briefs that tell the
 * agent which variable to read) and a copy that drifted would name a variable that is never set:
 * a capability reported as unavailable on every run, with nothing to see at either end.
 */
export function credentialInjectionName(credential: CapabilityCredentialNames): string {
  return credential.envName ?? credential.key
}

/**
 * The form an injection name is COMPARED in, which is not the form it is injected under.
 *
 * Case-folded, the same way {@link isReservedPlatformEnvKey} folds the lookup key it screens, and
 * for the reason that floor has: environment lookup is case-insensitive on Windows, so `ACME_KEY`
 * and `acme_key` are two variables in the declaration and one variable in the process that reads
 * them. A rule comparing them exactly would call that pair distinct and let one value overwrite
 * the other on the one platform where it matters.
 */
export function comparableCredentialInjectionName(credential: CapabilityCredentialNames): string {
  return credentialInjectionName(credential).toUpperCase()
}

/**
 * Whether every credential in a declaration arrives as its own variable.
 *
 * Exported so the boot checks and the schemas share one implementation rather than agreeing by
 * hand. Duplicate LOOKUP keys are deliberately allowed: a capability wanting one stored value
 * delivered under two names is odd but honest, and nothing is lost. A duplicate INJECTION name
 * loses a value, which is why only that one is refused.
 */
export function uniqueCredentialInjectionNames(
  credentials: readonly CapabilityCredentialNames[],
): boolean {
  const names = credentials.map(comparableCredentialInjectionName)
  return new Set(names).size === names.length
}

/** One capability that claims environment variables, as {@link credentialInjectionCollisions} reads it. */
export interface CredentialInjectionClaimant {
  /**
   * How this claimant is NAMED in the fault message, qualified by what it is: `integration "x"`,
   * `service "y"`. The rule spans registries, so an id alone would leave an operator hunting for
   * which registry to edit.
   */
  owner: string
  credentials?: readonly CapabilityCredentialNames[]
}

/** One environment variable two or more claimants want to hold different values. */
export interface CredentialInjectionCollision {
  /** The variable, in the spelling the deployment wrote (comparison is case-folded; injection is not). */
  envName: string
  message: string
}

/**
 * The rule that spans DECLARATIONS: two capabilities may not inject different values into one
 * environment variable.
 *
 * The across-declaration twin of {@link uniqueCredentialInjectionNames}, and stated over CLAIMANTS
 * rather than over any one registry's definition type because the variable is the shared resource
 * and the registries cannot see each other. A generative integration, a foundational service and
 * an MCP tool server are registered independently, and the pair only meets when a step selects
 * both, so a rule scoped to one registry answers a question narrower than the fault: the same
 * collision graded twice, once per registry, produces two remediations for one variable.
 *
 * A SHARED name is legitimate and common, because one vendor behind an image endpoint and a music
 * endpoint is one account: what makes that safe is that both look the value up under the SAME key,
 * so whichever resolves first sets the variable to exactly what the other wanted. Different keys
 * behind one name is the opposite, and there is no arbitration that makes it right. Serving the
 * first claimant sets the variable the second capability's brief tells the agent to read, so the
 * agent authenticates one thing with another's credential; withholding it (what dispatch does,
 * since a mothership node validates nothing) costs both capabilities every run. Only a
 * disagreement about the VALUE is reported.
 *
 * Takes the claimants that PARSED. Reading a malformed definition's credentials would restate a
 * fault already reported as a second, more confusing one.
 */
export function credentialInjectionCollisions(
  claimants: readonly CredentialInjectionClaimant[],
): CredentialInjectionCollision[] {
  // Grouped by the COMPARABLE (case-folded) name and reported under the spelling the deployment
  // wrote, because `ACME_KEY` and `acme_key` are one variable wherever the environment ignores case
  // and two everywhere else: the pair collides on exactly the platform where the operator has the
  // least chance of noticing it.
  const claims = new Map<string, { spelling: string; byKey: Map<string, string[]> }>()
  for (const claimant of claimants) {
    for (const credential of claimant.credentials ?? []) {
      const comparable = comparableCredentialInjectionName(credential)
      const claim = claims.get(comparable) ?? {
        spelling: credentialInjectionName(credential),
        byKey: new Map<string, string[]>(),
      }
      claim.byKey.set(credential.key, [...(claim.byKey.get(credential.key) ?? []), claimant.owner])
      claims.set(comparable, claim)
    }
  }
  const collisions: CredentialInjectionCollision[] = []
  for (const [, { spelling, byKey }] of claims) {
    if (byKey.size < 2) continue
    const described = [...byKey]
      .map(([key, owners]) => `"${key}" (${owners.join(', ')})`)
      .sort()
      .join(' and ')
    collisions.push({
      envName: spelling,
      message:
        `Registered capabilities disagree about environment variable "${spelling}": it is declared ` +
        `for lookup keys ${described}. One variable cannot hold both values, so every dispatch ` +
        `carrying both withholds it from BOTH of them. Give one a distinct \`envName\`, or point ` +
        `both at the same lookup key if they really share an account.`,
    })
  }
  return collisions
}
