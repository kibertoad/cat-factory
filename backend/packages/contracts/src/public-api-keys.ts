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
})
export type CreatePublicApiKeyInput = v.InferOutput<typeof createPublicApiKeySchema>

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
