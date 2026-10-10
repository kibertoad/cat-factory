import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Inbound public-API key wire contracts.
//
// Unlike the direct-provider API keys (`api-keys.ts`, OUTBOUND credentials the
// platform hands to an LLM vendor and therefore stores ENCRYPTED so it can be
// recovered), a public-API key authenticates an EXTERNAL CALLER to our own
// `/api/v1` surface. The platform only ever VERIFIES it, never replays it, so
// the secret is stored as a one-way peppered hash (`HMAC-SHA256(secret,
// ENCRYPTION_KEY)`) — irrecoverable, DB-leak-resistant. The raw key is returned
// exactly once, on create; thereafter only metadata is exposed.
//
// A key is scoped to one account + workspace: every `/api/v1` call it makes is
// bound to that workspace.
// ---------------------------------------------------------------------------

/**
 * The permission a key carries on the `/api/v1` surface. An ordered ladder — each level
 * INCLUDES the ones below it (`admin` ⊃ `write` ⊃ `read`), so an endpoint gates on a MINIMUM:
 *
 *  - `read`   — read-only reads/streams (list services/tasks/pipelines, poll a run, SSE).
 *  - `write`  — everything `read` can do, PLUS non-destructive mutations (create/start/stop/
 *    retry/edit a task, start an initiative run).
 *  - `decide` — everything `write` can do, PLUS answering a run's PARKED human decisions
 *    (requirement-review findings, implementation-fork choices) — and, because of that,
 *    starting a headless run on a pipeline that can park at all. Answering a decision injects
 *    caller-supplied prose into the requirements every downstream agent then implements and
 *    un-parks the run, so it is deliberately a rung above ordinary task authoring: a plain
 *    `write` integration sees exactly the pre-existing behaviour, including the refusal of
 *    parking pipelines. Minting a `decide` key is the operator asserting "this integration is
 *    the headless overseer for these runs".
 *
 *    **The grant is WORKSPACE-WIDE, not limited to runs the key started.** The decision surface
 *    is keyed by run id and resolves any run in the key's workspace — including a board task a
 *    human started in the SPA — because a headless overseer that could only answer its own runs
 *    would be useless for the case it exists for (an integration watching a team's board). That
 *    is the same reach a `write` key already has over board runs (start/stop/retry), one rung
 *    up. Scope a key to a workspace accordingly, and prefer `write` for an integration that
 *    only needs to author and launch.
 *  - `admin`  — everything `decide` can do, PLUS destructive / merge-adjacent operations
 *    (delete a task, act on a notification — which can perform a real merge).
 *
 * The canonical rank order lives beside this schema (`PUBLIC_API_SCOPES`) so both the wire
 * validation and the server-side `scope ≥ required` check read from one source of truth —
 * the ARRAY ORDER *is* the ladder, and `scopeSatisfies` derives its ranks from it.
 */
export const PUBLIC_API_SCOPES = ['read', 'write', 'decide', 'admin'] as const
export const publicApiScopeSchema = v.picklist(PUBLIC_API_SCOPES)
export type PublicApiScope = v.InferOutput<typeof publicApiScopeSchema>

/**
 * An identifier the PROVISIONER attaches to a key it mints headlessly: who, on ITS side, the
 * credential acts for (an OS user id, a tenant slug, a service account name).
 *
 * Opaque to the platform in the strongest sense: never parsed, never resolved against a user,
 * never an authorization input. What a key may do is its own {@link publicApiScopeSchema}, and
 * what a run may do is the policy the workspace authored. This value exists so an integration
 * that mints one key per person can map a RUN back to that person without keeping a keyId table
 * of its own, which is the whole cost it otherwise pays for real per-user attribution.
 *
 * Bounded and line-break-free rather than a bare string: it is echoed on the key resource, on run
 * projections and (per key) on `GET /api/v1/me`, so a value carrying a newline or a terminator
 * would be an integrator's own text breaking a line-oriented log or a table row on whichever
 * surface renders it next.
 *
 * The refusal is TWO checks, split by what can be PUBLISHED rather than by what it means.
 *
 * {@link EXTERNAL_IDENTITY_CONTROL_CLASS} is the half that ships: it lands in `docs/openapi.json`
 * as this field's `pattern`, which third parties feed to their own codegen and validators, so it
 * is spelled in the one escape syntax every flavour we publish an SDK for agrees on. `\xHH` is
 * valid in ECMA-262, Go's RE2, PCRE, Python and Java alike, where `\p{C}` needs a flag many of
 * them do not set and `\uHHHH` (which this class first carried) is a PARSE ERROR in RE2 and PCRE.
 * A pattern naming U+2028 that way does not fail one validation, it fails to compile at all, which
 * is a broken client rather than a rejected value.
 *
 * The two separators cannot be spelled portably at all (`\u2028` breaks RE2 and PCRE, `\x{2028}`
 * breaks ECMA-262 and Python), so they are refused by a `v.check`, which emits no `pattern`. The
 * published schema is therefore a NECESSARY condition and not a sufficient one: a third-party
 * validator admits two code points this server then answers 422 for. The trade is deliberate and
 * this is the right way round, because an under-strict published pattern costs one caller one
 * clear refusal where an uncompilable one costs every Go and PCRE consumer their whole client.
 */
const EXTERNAL_IDENTITY_CONTROL_CLASS =
  // The C0 controls, DEL, and the C1 controls. The lint guards a pattern that matches control
  // characters by ACCIDENT; here refusing them is the whole rule, which is why the class names
  // them one by one. C1 is named as a RANGE because an enumeration reaches for U+0085 (NEL) and
  // silently admits the other 31 members, each of which renders as its own kind of damage on a
  // surface that echoes this value.
  // eslint-disable-next-line no-control-regex
  /^[^\x00-\x1f\x7f\x80-\x9f]+$/

/**
 * U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR: line breaks to every renderer that
 * matters, and unspellable in a portable `pattern`, so refused off the wire schema (see above).
 */
const EXTERNAL_IDENTITY_SEPARATORS = /[\u2028\u2029]/

export const publicApiExternalIdentitySchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(200),
  v.regex(
    EXTERNAL_IDENTITY_CONTROL_CLASS,
    'externalIdentity must not contain control characters or line breaks',
  ),
  // One message for both halves: the SPLIT is about what a published pattern can express, never
  // about what a caller did wrong, so a caller must not have to learn which half refused them.
  v.check(
    (value) => !EXTERNAL_IDENTITY_SEPARATORS.test(value),
    'externalIdentity must not contain control characters or line breaks',
  ),
)
export type PublicApiExternalIdentity = v.InferOutput<typeof publicApiExternalIdentitySchema>

/** One public-API key as exposed to clients — metadata only, never the secret. */
export const publicApiKeySchema = v.object({
  /** `pak_*` — also the non-secret lookup id embedded in the raw key. */
  id: v.string(),
  accountId: v.string(),
  workspaceId: v.string(),
  label: v.string(),
  /** What the key is allowed to do on `/api/v1` (read ⊂ write ⊂ admin). */
  scope: publicApiScopeSchema,
  /** The user who minted the key (`usr_*`), for audit/UI attribution; `null` when unknown. */
  createdByUserId: v.nullable(v.string()),
  /**
   * The KEY that minted this one (`pak_*`), set only for a key provisioned headlessly through
   * `POST /api/v1/keys`; `null` for a key a person minted in the app.
   *
   * Provenance, not authorization, but unlike {@link publicApiKeySchema.entries.createdByUserId}
   * it is also a lifecycle link: revoking a key revokes everything it minted, so a leaked
   * provisioning key cannot outlive its own revocation through the keys it left behind.
   */
  createdByKeyId: v.nullable(v.string()),
  /**
   * Who the provisioner said this key acts for, on its own side
   * ({@link publicApiExternalIdentitySchema}); `null` for a key minted in the app and for one
   * provisioned without it. Set only at mint time and never edited: a key IS one identity, so a
   * value that could move would retro-attribute every run it already started.
   */
  externalIdentity: v.nullable(v.string()),
  /**
   * The user (`usr_*`) whose PERSONAL subscriptions this key may unlock, or `null` for a key that
   * did not opt in (the default, and every headlessly-minted key).
   *
   * Always equal to {@link publicApiKeySchema.entries.createdByUserId} when set: a person binds
   * their OWN key, and there is no way to name anyone else. Reading it as "this key can act as
   * this user" overstates it — it admits the per-run personal-credential unlock and nothing more,
   * and only on a call that also carries that user's personal password.
   */
  actsAsUserId: v.nullable(v.string()),
  createdAt: v.number(),
  lastUsedAt: v.nullable(v.number()),
  /** Set when the key was revoked (tombstone); a revoked key never authenticates. */
  revokedAt: v.nullable(v.number()),
})
export type PublicApiKey = v.InferOutput<typeof publicApiKeySchema>

export const publicApiKeyListResultSchema = v.object({ keys: v.array(publicApiKeySchema) })
export type PublicApiKeyListResult = v.InferOutput<typeof publicApiKeyListResultSchema>

/**
 * Mint a new key. A label plus an optional `scope` (the account/workspace scope comes from the
 * mounting route). `scope` defaults to `write` — the safe middle of the ladder: a fresh key can
 * create/start/manage tasks but NOT answer a parked run's decisions, delete, or perform a
 * merge-adjacent action until it is minted `decide` / `admin` explicitly. Pass `read` for a
 * monitor-only integration.
 */
export const createPublicApiKeySchema = v.object({
  label: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  scope: v.optional(publicApiScopeSchema, 'write'),
  /**
   * Which of the two IDENTITIES this key runs as. The default, `false`, is a SYSTEM key: its runs
   * are attributed to nobody and it can reach no personal (individual-usage) subscription at all,
   * so a task pinned to such a model is refused rather than charged to a person who is not there.
   * `true` binds the key to the person minting it, so a run it starts is theirs and may unlock
   * THEIR subscription with the password supplied on that same call.
   *
   * Both are first-class, and an integration should hold the narrower one unless it specifically
   * needs the other: a shared CI credential wants system, and a developer driving their own
   * headless runs wants self. That is also why the field is not merely a capability toggle — it
   * decides whose credentials, spend and merge-policy role a run answers to.
   *
   * A boolean rather than a user id, and that is the safety property rather than an ergonomic
   * one: the only value the server will write is the caller's own id, so the wire shape cannot
   * express minting a key onto someone else's subscription. Refused outright when there is no
   * signed-in user to bind (a dev-open mint), because a key bound to nobody would silently behave
   * like a system one at the moment a run needed the credential.
   */
  actsAsSelf: v.optional(v.boolean(), false),
})
export type CreatePublicApiKeyInput = v.InferOutput<typeof createPublicApiKeySchema>

/**
 * The scope a HEADLESS provisioning call (`POST /api/v1/keys`) must itself hold, and therefore
 * the rung a key it mints may not reach.
 *
 * One constant rather than two, because both facts are the same rule: provisioning is an admin
 * action, so a key that can provision is an `admin` key, so a minted key that could reach `admin`
 * could provision in turn. See {@link HEADLESS_MINTABLE_SCOPES}.
 */
export const HEADLESS_KEY_MINT_SCOPE = 'admin' as const satisfies PublicApiScope

/**
 * What a headless mint may hand out: every rung strictly BELOW the one provisioning itself
 * requires, so a key minted over the API can never mint another.
 *
 * That bound is the whole reason headless provisioning is safe to offer. A leaked `admin` key is
 * already a full compromise of its workspace; what this stops is the compromise SURVIVING its own
 * cleanup, by making the mint chain exactly one link long and revocation of the minter cascade to
 * everything it produced. An operator who wants a second admin key mints it in the app, where a
 * human session and the `secrets.manage` workspace permission stand behind it.
 *
 * DERIVED from the ladder rather than hand-listed: a rung inserted above `admin` becomes mintable
 * automatically and one inserted below stays mintable, where a literal list would silently freeze
 * whichever set was true the day it was written.
 */
export type HeadlessMintableScope = Exclude<PublicApiScope, typeof HEADLESS_KEY_MINT_SCOPE>
export const HEADLESS_MINTABLE_SCOPES = PUBLIC_API_SCOPES.slice(
  0,
  PUBLIC_API_SCOPES.indexOf(HEADLESS_KEY_MINT_SCOPE),
) as readonly HeadlessMintableScope[]

/**
 * The gate must be the TOP rung, or the two statements of the same rule diverge: the value above
 * is every rung BELOW the gate, while its type is every rung EXCEPT it, and those coincide only
 * while nothing sits above. A rung added above `admin` fails this assignment rather than silently
 * shipping a schema whose TypeScript type admits a scope its runtime validation refuses.
 */
type TopScopeRung = typeof PUBLIC_API_SCOPES extends readonly [...infer _Rest, infer Top]
  ? Top
  : never
const _mintGateIsTopRung: TopScopeRung = HEADLESS_KEY_MINT_SCOPE

/**
 * Mint a key HEADLESSLY, over `/api/v1`: the same body as the session-authed create, minus the
 * rung it may not reach, plus the identity the provisioner is minting it FOR.
 *
 * `scope` carries no schema-level DEFAULT where its session-authed twin does, deliberately: this
 * body ships in four generated SDKs, where a default reads as "always present on the way out" and
 * an omitted-optional as "may be absent on the way in", and the two cannot both be true of one
 * field. The omitted-scope behaviour (`write`, the same safe middle rung) is applied by the
 * handler and stated on the endpoint's docs instead.
 *
 * `externalIdentity` is offered HERE and not on the session-authed create, because the two mints
 * answer "who is this key" differently: a person minting in the app is already recorded as
 * `createdByUserId`, an account the platform can resolve. This field is for the identity the
 * platform has no account for, which only a provisioning integration can name.
 */
export const createHeadlessPublicApiKeySchema = v.object({
  label: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  scope: v.optional(v.picklist([...HEADLESS_MINTABLE_SCOPES])),
  externalIdentity: v.optional(publicApiExternalIdentitySchema),
})
export type CreateHeadlessPublicApiKeyInput = v.InferOutput<typeof createHeadlessPublicApiKeySchema>

/**
 * The create response: the key metadata PLUS the raw secret (`cf_live_<id>.<secret>`),
 * returned exactly once and never again — the caller must store it now.
 */
export const createdPublicApiKeySchema = v.object({
  key: publicApiKeySchema,
  /** The full raw key, shown once. Store it — it is not recoverable. */
  secret: v.string(),
})
export type CreatedPublicApiKey = v.InferOutput<typeof createdPublicApiKeySchema>
