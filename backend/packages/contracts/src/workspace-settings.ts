import * as v from 'valibot'
import { manifestIdSchema, provisionTypeSchema } from './environments.js'
import { createTaskTypeSchema } from './primitives.js'
import { inputGateModeSchema } from './input-gate.js'

// ---------------------------------------------------------------------------
// Per-workspace runtime settings. A single settings object per workspace (lazily
// seeded from the defaults) holding the operator-tunable policies that aren't
// per-task: how long a run may wait for a human before its notification escalates
// to red, and whether/how to cap the number of tasks running concurrently under one
// service. Persisted in the `workspace_settings` table on both runtime facades.
// ---------------------------------------------------------------------------

/**
 * How the per-service running-task limit is bucketed:
 *  - `off`      — no limit (the default).
 *  - `shared`   — one shared cap across all task types under a service.
 *  - `per_type` — a separate cap per task type under a service.
 */
export const taskLimitModeSchema = v.picklist(['off', 'shared', 'per_type'])
export type TaskLimitMode = v.InferOutput<typeof taskLimitModeSchema>

const limitSchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000))

/** Per-task-type running-task caps (used when {@link taskLimitModeSchema} is `per_type`). */
export const taskLimitPerTypeSchema = v.record(createTaskTypeSchema, limitSchema)
export type TaskLimitPerType = v.InferOutput<typeof taskLimitPerTypeSchema>

// ---------------------------------------------------------------------------
// Opt-in review-debt friction (see `backend/docs/review-debt-friction.md`). When a
// workspace has too many tasks parked on human review — by count, or by how long the
// oldest has been stuck — authoring a NEW task requires an explicit acknowledgement
// (soft friction), and past a harder threshold is refused outright (hard block). Off
// by default; the debt itself is derived from open review-wait notifications, so this
// only ever shapes *new* work.
// ---------------------------------------------------------------------------

/**
 * Whether/how review-debt friction is applied to task creation:
 *  - `off`     — no friction (the default).
 *  - `warn`    — soft friction only: past the warn threshold, creating a task
 *                requires an explicit acknowledgement.
 *  - `enforce` — soft friction plus the hard block thresholds.
 */
export const reviewFrictionModeSchema = v.picklist(['off', 'warn', 'enforce'])
export type ReviewFrictionMode = v.InferOutput<typeof reviewFrictionModeSchema>

// ---------------------------------------------------------------------------
// Per-workspace spend budget. Moved out of the deployment-wide env vars
// (`SPEND_MONTHLY_LIMIT` / `SPEND_CURRENCY`) onto the workspace settings row so
// an operator can tune a workspace's budget in the UI without a redeploy. Both
// are nullable; null ⇒ fall back to the built-in `DEFAULT_SPEND_PRICING` base
// table (the spend service resolves the effective pricing per workspace,
// overlaying the OpenRouter catalog as before).
// ---------------------------------------------------------------------------

/** ISO 4217 currency code (3 letters), e.g. `EUR`. */
const spendCurrencySchema = v.pipe(
  v.string(),
  v.trim(),
  v.toUpperCase(),
  v.length(3),
  v.regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO 4217 code'),
)

// ---------------------------------------------------------------------------
// The workspace's DEFAULT test-environment provisioning mechanism: the provision
// type suggested for every newly added service frame (ADR 0007's "what + where",
// pre-filled at creation instead of left for the operator to discover per service).
//
// This is deliberately NULLABLE rather than defaulted to `infraless`, and the
// distinction is the whole point — it is the same tri-state the infra-setup
// projection uses:
//   - `null`        — the operator has never made a choice. Banner-worthy: the SPA
//                     nags once per board until a decision is recorded.
//   - `infraless`   — a real, recorded decision that services stand up no
//                     environment. Silences the nag exactly like any other choice.
//   - anything else — that type (plus, for `custom`, the manifest id) is stamped
//                     onto each new service frame.
// Collapsing the two would make "nobody decided" indistinguishable from "we decided
// no environments", so the banner could only either nag forever or never.
//
// NOTE this is NOT the `defaultTestEnvironment` toggle ADR 0007 removed. That was a
// per-service local-vs-ephemeral switch the engine branched on at run time; this
// never reaches the engine at all — it is a creation-time seed for a field the
// service still owns and the user can still change.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Custom workspace metadata: a free-form `key -> string` bag on the settings row,
// whose FIELDS are declared programmatically by the deployment (the SPA's
// `workspaceMetadataFields` slot) and whose VALUES are typed in by an operator in
// the workspace-settings panel. The canonical consumer is an external-tool URL
// resolver — "open the map editor already switched to this workspace's `gameId`".
//
// The backend deliberately knows NOTHING about which fields exist: definitions are
// code-shipped by a deployment that can add, rename and retire them without a
// migration, so validating a key against a server-side list would make the store
// disagree with the app the moment either side is deployed alone. What it DOES own
// is the shape — an identifier-ish key and a bounded scalar value — so a stray
// write can neither bloat the row nor smuggle a structure the readers don't expect.
// ---------------------------------------------------------------------------

/** Max stored metadata entries per workspace. */
export const MAX_WORKSPACE_METADATA_ENTRIES = 64
/** Max stored length of a single metadata value. */
export const MAX_WORKSPACE_METADATA_VALUE_LENGTH = 1024

/**
 * A metadata field key: an identifier a deployment writes in code and a resolver reads
 * off `ctx.metadata`. Deliberately identifier-shaped (no spaces, no `/`, no `%`) so that
 * the one thing every consumer does with a key — read it as a property, `ctx.metadata.gameId`
 * — is total and needs no escaping. The leading-letter rule additionally keeps `__proto__`
 * out of a bag that is `JSON.parse`d on both sides.
 *
 * This is NOT what makes an external tool's URL safe. It is the VALUES that get interpolated
 * into one, and a value is operator-typed text bounded only in length — so the rule that
 * matters lives with the reader: build a URL by setting a query parameter or an encoded path
 * segment, never by splicing a value into the origin. Stated where a resolver author will
 * read it, on `ExternalToolContext.metadata`.
 */
export const workspaceMetadataKeySchema = v.pipe(
  v.string(),
  v.regex(
    /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/,
    'metadata keys start with a letter and may contain letters, digits, "_", "." and "-" (max 64 chars)',
  ),
)

/**
 * The stored metadata bag. Values are STRINGS whatever the declared field type — the
 * only consumer is text interpolation (a URL, a prompt), and a numeric-looking field
 * that round-trips as a number would lose a leading zero the external system cares about.
 * An UNSET field is an ABSENT key, never an empty string: the editor drops a cleared
 * value, so "nobody filled this in" and "somebody deliberately entered nothing" don't
 * both render as a tool URL with an empty parameter.
 */
export const workspaceMetadataSchema = v.pipe(
  v.record(
    workspaceMetadataKeySchema,
    v.pipe(v.string(), v.maxLength(MAX_WORKSPACE_METADATA_VALUE_LENGTH)),
  ),
  v.check(
    (record) => Object.keys(record).length <= MAX_WORKSPACE_METADATA_ENTRIES,
    `a workspace may hold at most ${MAX_WORKSPACE_METADATA_ENTRIES} metadata fields`,
  ),
)
export type WorkspaceMetadata = v.InferOutput<typeof workspaceMetadataSchema>

/** A workspace's runtime settings. */
export const workspaceSettingsSchema = v.object({
  /**
   * Minutes a run may wait for human input before its open notification escalates
   * from `normal` (yellow) to `urgent` (red). The run itself is never auto-failed.
   */
  waitingEscalationMinutes: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100_000)),
  /** Whether/how the per-service running-task limit is enforced. */
  taskLimitMode: taskLimitModeSchema,
  /** The shared cap, when {@link taskLimitMode} is `shared`. Null otherwise. */
  taskLimitShared: v.nullable(limitSchema),
  /** The per-type caps, when {@link taskLimitMode} is `per_type`. Null otherwise. */
  taskLimitPerType: v.nullable(taskLimitPerTypeSchema),
  /**
   * Whether to store the complete context provided to each container agent (the
   * fully composed system + user prompts, the best-practice fragment bodies folded
   * in, and the full content of the files injected into the container) for the
   * observability viewer. On by default. The heavy, potentially sensitive bodies ride
   * the same retention window as the per-call LLM telemetry, and storing is also
   * suppressed when the deployment disables prompt recording (`LLM_RECORD_PROMPTS`).
   */
  storeAgentContext: v.boolean(),
  /**
   * Whether the engine maintains its verification report on each run's pull request. On by
   * default.
   *
   * A pull request is a more exposed surface than the telemetry store — it can be a public
   * repo, and its description is visible to everyone who can see the PR. The report carries
   * only captured run facts and every free-text field is scrubbed of credentials before it is
   * written, but a workspace that would rather keep its CI verdicts, test outcomes and
   * environment URLs off the PR can turn it off here. Off ⇒ nothing is written and any region
   * already on a PR is left exactly as it is (the engine never deletes what it wrote — a
   * report that vanished would read as "the run had nothing to say").
   */
  publishPrVerificationReport: v.boolean(),
  /**
   * How many days captured UI screenshots + uploaded reference design images (the
   * binary artifacts backing the visual-confirmation gate) are retained before the
   * cleanup sweep deletes them — bytes and metadata. Default 14. Bounded 1–3650.
   */
  artifactRetentionDays: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(3650)),
  /**
   * How many completed tasks a service frame's "Done" swimlane renders, newest completion
   * first. Default 20. Bounded 0–500.
   *
   * `0` is valid and means "count them, show none": the lane still states how many tasks
   * the service has finished, which is the fact a collapsed archive is there to carry. The
   * cap exists because completed tasks accrue forever — a long-lived service reaches
   * hundreds — and an uncapped terminal column would make its frame arbitrarily tall.
   *
   * Paired with {@link doneLaneRetentionDays}: this one bounds the SIZE of the lane, that
   * one bounds its AGE, and the board reports the two drop counts separately because they
   * tell a reader different things ("there is more from this period" vs "there is older
   * history").
   */
  doneLaneMaxItems: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(500)),
  /**
   * How many days a completed task stays in the "Done" swimlane before the board stops
   * rendering it. Default 14. Bounded 1–3650. Null ⇒ no age cap, so
   * {@link doneLaneMaxItems} alone bounds the lane.
   *
   * This hides a card; it deletes nothing. A task aged out of the lane is still on the
   * board's data, still reachable from search and its own inspector, and still counted in
   * the lane's total.
   *
   * A task whose `completedAt` is absent (merged before that column existed) is EXEMPT
   * rather than treated as ancient: hiding history on the strength of a timestamp nobody
   * recorded would be the platform inferring a fact it does not have.
   */
  doneLaneRetentionDays: v.nullable(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(3650)),
  ),
  /**
   * Whether the Kaizen agent grades agent steps after each run completes and
   * recommends prompt/model improvements. On by default. When off, no gradings are
   * scheduled (existing history + verified combos are retained, just not extended).
   */
  kaizenEnabled: v.boolean(),
  /**
   * LOCAL MODE ONLY. Whether container agents dispatch to the workspace's registered
   * self-hosted runner pool instead of the host container runtime (Docker/Podman/…).
   * Off by default (local-everything is the default). Meaningful only in local mode —
   * on the Cloudflare/Node facades agents always run on their fixed backend, so this is
   * inert there. Enabling it with no runner pool registered fails the run loudly.
   */
  delegateAgentsToRunnerPool: v.boolean(),
  /**
   * Whether/how the PRE-DISPATCH INPUT GATE applies to this workspace's runs: the deterministic
   * structural check of a task's authored input, run before the first agent step is dispatched
   * so a task nobody could act on parks having spent nothing.
   *
   * `standard` (the default) parks a run on a blocking finding: an empty or placeholder-only
   * description, a `bug` with no reproduction context, a `review` task naming no pull request.
   * Each of those is unambiguous: no model reading them could produce work, so buying that
   * verdict from the requirements reviewer costs a call to be told what a string comparison
   * already knew. `advisory` records the same findings and never parks; `off` skips the check.
   */
  inputGateMode: inputGateModeSchema,
  /** Whether/how review-debt friction is applied when authoring a new task. */
  reviewFrictionMode: reviewFrictionModeSchema,
  /**
   * Tasks-in-review count at which soft friction starts (past it, creating a task
   * needs an explicit acknowledgement). Default 3.
   */
  reviewFrictionWarnCount: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000)),
  /**
   * Hard block: refuse task creation while ≥ this many tasks are in human review.
   * Null ⇒ the count trigger is off. Must be ≥ {@link workspaceSettingsSchema.reviewFrictionWarnCount}.
   * Only consulted when {@link reviewFrictionModeSchema} is `enforce`.
   */
  reviewFrictionBlockCount: v.nullable(limitSchema),
  /**
   * Hard block: refuse task creation while ANY task has been in human review longer than
   * this many minutes. Null ⇒ the age trigger is off. Only consulted in `enforce` mode.
   */
  reviewFrictionBlockStuckMinutes: v.nullable(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100_000)),
  ),
  /** Spend budget currency (ISO 4217). Null ⇒ the built-in default (`EUR`). */
  spendCurrency: v.nullable(spendCurrencySchema),
  /**
   * Monthly spend budget in {@link spendCurrency}. Null ⇒ the built-in default
   * (~100 EUR). `0` is intentional and valid — it means "no PAID spend": runs on
   * metered models (direct API keys / Cloudflare Workers AI) are refused at start and
   * paused mid-run, while LOCAL-runner models (keyless) and connected SUBSCRIPTIONS
   * (Claude Code / Codex, flat-rate quota) keep running, since they incur no metered
   * cost. So `0` is the "local-/subscription-only" setting, not a footgun — it's
   * reversible from the UI and clearer than an unbounded "unlimited" that can run up a
   * bill. The gate is per-workspace (see the spend safeguard); web search still costs
   * money, so a `0` budget also blocks paid web searches.
   */
  spendMonthlyLimit: v.nullable(v.pipe(v.number(), v.minValue(0))),
  /**
   * The provision type stamped onto every newly added service frame that doesn't declare
   * one of its own. `null` ⇒ the operator has never chosen (the banner-worthy state); see
   * the block comment above for why this is not defaulted to `infraless`.
   */
  defaultProvisionType: v.nullable(provisionTypeSchema),
  /**
   * Which custom manifest type a `custom` {@link defaultProvisionType} names. Meaningful
   * only for `custom` (and REQUIRED there — a `custom` service with no pinned id matches no
   * `remote-custom` handler, so seeding one would create services that can never provision);
   * null for every other type. Cross-field validated by `WorkspaceSettingsService.update`.
   */
  defaultProvisionManifestId: v.nullable(manifestIdSchema),
  /**
   * Whether a run may authenticate as its INITIATOR (their stored personal access token)
   * instead of the deployment credential. On by default, which is the attribution behaviour
   * the platform has always had: pushes and PRs come from the human who started the run.
   *
   * Turning it OFF is a security control, and the only ENFORCED one over an initiator's PAT.
   * A personal token's scope is whatever the human who minted it granted — a classic-scope
   * PAT reaches every repository its owner can push to, which is routinely far wider than the
   * App installation the operator scoped. So the blast radius of a compromised run is
   * otherwise a property of whoever STARTED it. Off ⇒ every run authenticates as the App
   * installation (or, in local mode, the deployment's own token), at the cost of bot
   * attribution. See `backend/docs/security-model.md`.
   *
   * Scope of the switch: it governs the credential a RUN acts with. It does not touch what a
   * member's own token does on their behalf in the UI (browsing their PAT-reachable repos in
   * the picker), which is that member reading their own account, not the platform writing to
   * someone else's.
   */
  allowInitiatorPat: v.boolean(),
  /**
   * The workspace's custom metadata values, keyed by the field keys a deployment declares
   * in code. `{}` when nothing has been filled in. See {@link workspaceMetadataSchema}.
   */
  metadata: workspaceMetadataSchema,
})
export type WorkspaceSettings = v.InferOutput<typeof workspaceSettingsSchema>

/** Update a workspace's runtime settings (full replace of the supplied fields). */
export const updateWorkspaceSettingsSchema = v.object({
  waitingEscalationMinutes: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100_000)),
  ),
  taskLimitMode: v.optional(taskLimitModeSchema),
  taskLimitShared: v.optional(v.nullable(limitSchema)),
  taskLimitPerType: v.optional(v.nullable(taskLimitPerTypeSchema)),
  storeAgentContext: v.optional(v.boolean()),
  publishPrVerificationReport: v.optional(v.boolean()),
  artifactRetentionDays: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(3650)),
  ),
  doneLaneMaxItems: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(500))),
  doneLaneRetentionDays: v.optional(
    v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(3650))),
  ),
  kaizenEnabled: v.optional(v.boolean()),
  delegateAgentsToRunnerPool: v.optional(v.boolean()),
  inputGateMode: v.optional(inputGateModeSchema),
  reviewFrictionMode: v.optional(reviewFrictionModeSchema),
  reviewFrictionWarnCount: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000)),
  ),
  reviewFrictionBlockCount: v.optional(v.nullable(limitSchema)),
  reviewFrictionBlockStuckMinutes: v.optional(
    v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100_000))),
  ),
  spendCurrency: v.optional(v.nullable(spendCurrencySchema)),
  spendMonthlyLimit: v.optional(v.nullable(v.pipe(v.number(), v.minValue(0)))),
  defaultProvisionType: v.optional(v.nullable(provisionTypeSchema)),
  defaultProvisionManifestId: v.optional(v.nullable(manifestIdSchema)),
  allowInitiatorPat: v.optional(v.boolean()),
  /**
   * Replace the whole metadata bag. Whole-bag rather than per-key because the editor
   * renders every declared field at once, so a save states the complete intent — and a
   * field the operator CLEARED has to disappear, which a merge-only patch could never
   * express. The editor carries any key it did not render back into the submitted bag, so
   * a value written by another deployment version survives an unrelated save.
   */
  metadata: v.optional(workspaceMetadataSchema),
})
export type UpdateWorkspaceSettingsInput = v.InferOutput<typeof updateWorkspaceSettingsSchema>
