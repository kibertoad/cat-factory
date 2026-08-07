import * as v from 'valibot'

// ---------------------------------------------------------------------------
// The ACCOUNT AUDIT vocabulary: what privileged action a recorded audit event describes, who
// performed it, what kind of thing it acted on, and which VALUES the viewer interpolates.
//
// It lives in contracts rather than kernel because both sides must agree about the SAME
// member lists for different reasons. The backend writes an action when a mutation commits;
// the SPA's viewer renders each one as human copy, through an exhaustive `Record` over this
// picklist, so a member added without translated copy fails the SPA's typecheck instead of
// rendering a raw `account.member_roles_changed` at an operator. A vocabulary kept only on the
// backend becomes a hand-copied list in the viewer, and the two then drift in the one
// direction that matters: an action nobody can read is an action nobody audits.
//
// The vocabularies are deliberately CLOSED and deliberately COARSE. Closed, because an audit
// reader filters by action class and a free-form string makes `member.role_changed` and
// `member.roles_changed` two unrelated actions that look identical in a list. Coarse, because
// an action names WHAT changed, never the values: the values ride `details` as machine-readable
// fields (see {@link AUDIT_ACTION_DETAIL_KEYS}), and the ones that are secret never get
// recorded at all (see `AuditEvent` in kernel).
//
// NOTHING here records human-readable PROSE. The backend does not localize (see CLAUDE.md →
// "Internationalization"), and an audit row is the sharpest case for that rule rather than an
// exception to it: the row is PERSISTED, so an English sentence written today can never be
// re-rendered for a reader in another locale. `action` + `details` is what lets slice 4's viewer
// compose its copy from translated keys, for rows written years earlier.
// ---------------------------------------------------------------------------

/**
 * The privileged actions an account audit event can describe.
 *
 * Naming is `<subject>.<verb>`, past tense, subject first, so an alphabetical list groups by
 * subject and a filter on a prefix is a filter on a subject. Members are added as the paths
 * that produce them get instrumented, never speculatively: an action in the union that nothing
 * writes reads to an operator as a category their deployment never exercises, which is
 * indistinguishable from a category that is silently broken.
 *
 * What is deliberately NOT here yet, because nothing writes it until the run-lifecycle slice:
 * run start/stop/retry, the notification `act` (which performs a real merge), and API-key
 * mint/revoke.
 */
export const auditActionSchema = v.picklist([
  /** A member was added to an account. */
  'account.member_added',
  /** An existing account member's role set was replaced. */
  'account.member_roles_changed',
  /** An account's monthly spend ceiling was set, changed, or cleared. */
  'account.budget_changed',
  /** An account's settings were changed (today: the default cloud provider). */
  'account.settings_changed',
  /** A teammate was invited to an account by email. */
  'account.invitation_created',
  /** A pending invitation was revoked before it was accepted. */
  'account.invitation_revoked',
  /** An invitation was accepted, creating the membership it granted. */
  'account.invitation_accepted',
  /**
   * An admin ended every session a member currently held (offboarding, a lost device). Distinct
   * from a role change: this withdraws AUTHENTICATION, not permissions, and the member keeps their
   * roles. Self-serve "sign out everywhere" is deliberately NOT recorded as this action — nobody's
   * admin performed it, and there is no account it belongs to.
   */
  'account.member_sessions_revoked',
  /** A member was added to one workspace (board-level roster, not the account roster). */
  'workspace.member_added',
  /** A workspace member's role was changed. */
  'workspace.member_role_changed',
  /** A member was removed from a workspace. */
  'workspace.member_removed',
  /** A workspace's access mode was changed (open ⇄ restricted). */
  'workspace.access_mode_changed',
])
export type AuditAction = v.InferOutput<typeof auditActionSchema>

/**
 * WHAT KIND of thing an audited action acted on: the type `targetId` is an id WITHIN.
 *
 * Closed for the same reason `action` is, plus one specific to it: the viewer resolves
 * `targetId` against a different table per kind (a user's name, an invitation's email), so a
 * free-form `'users'` beside `'user'` is not a cosmetic typo, it is a row whose subject silently
 * fails to resolve for exactly the admin trying to read it.
 */
export const auditTargetTypeSchema = v.picklist([
  /** A user, by internal id (`usr_*`). The account or board roster acted on a person. */
  'user',
  /** An account invitation, by its own id. */
  'invitation',
  /** A board, by workspace id. */
  'workspace',
  /** The account itself (settings, budget). */
  'account',
])
export type AuditTargetType = v.InferOutput<typeof auditTargetTypeSchema>

/**
 * WHO performed an audited action, as a closed set of principal KINDS.
 *
 * Three kinds rather than a nullable user id, because "the engine did it" and "we failed to
 * resolve who did it" are different facts and an audit log that renders them identically is
 * worse than one that omits the row: a reader concludes a human action was automated. `system`
 * is therefore asserted by an engine-internal caller, never defaulted to when a user id is
 * missing.
 *
 * `apiKey` is its own kind because a public-API key is a distinct principal from the user who
 * minted it: the key's own lifecycle is auditable, and attributing its actions to that user
 * would make a leaked key indistinguishable from the person in the log.
 */
export const auditActorKindSchema = v.picklist([
  /** A signed-in user acting through the SPA or the API. */
  'user',
  /** A public-API key acting on behalf of its account. */
  'apiKey',
  /** The engine itself, with no human in the loop. */
  'system',
])
export type AuditActorKind = v.InferOutput<typeof auditActorKindSchema>

/**
 * The VALUES an audit event carries beside its action, keyed by action.
 *
 * This is the contract between the writer and the viewer: the backend states what changed as
 * fields, and the SPA interpolates them into a translated sentence per action. Declared here
 * as data rather than left to each writer's discretion so that "which values does this action
 * carry" has ONE answer both sides read, and so a new action cannot ship with fields the copy
 * has no slot for (the `Record` is exhaustive over the picklist, so adding a member fails the
 * build until its keys are named).
 *
 * Every key is a value SAFE TO SHOW: a role, a ceiling, an email, an access mode. Never a
 * credential, never model or prompt text. The audit store is strictly more exposed than the
 * transactional domain (its whole purpose is to be read by humans, and a later slice serves it
 * over HTTP), which is why the boundary is stated once, here, rather than at each call site.
 */
export const AUDIT_ACTION_DETAIL_KEYS: Record<AuditAction, readonly string[]> = {
  'account.member_added': ['roles'],
  'account.member_roles_changed': ['previousRoles', 'roles'],
  'account.budget_changed': ['limit'],
  'account.settings_changed': ['defaultCloudProvider'],
  'account.invitation_created': ['email', 'roles'],
  'account.invitation_revoked': ['email'],
  'account.invitation_accepted': ['email', 'roles', 'invitedBy'],
  // No values: WHO revoked WHOSE sessions and WHEN is the whole fact, and all three are columns
  // already. The new generation is deliberately not recorded — it is an internal counter, and a
  // reader comparing two of them would be inferring how many revocations went unlogged rather
  // than reading the rows that state them.
  'account.member_sessions_revoked': [],
  'workspace.member_added': ['role'],
  'workspace.member_role_changed': ['previousRole', 'role'],
  'workspace.member_removed': ['role'],
  'workspace.access_mode_changed': ['accessMode'],
}

/**
 * One value inside an event's `details`.
 *
 * Scalars only, deliberately. Every detail exists to be interpolated into one translated
 * sentence, and a bounded set of shapes is what keeps that interpolation TOTAL: a nested object
 * or an array would each need the viewer to decide how to render it, per action, in every
 * locale. A list of roles is therefore joined by its writer (`'admin, developer'`) rather than
 * pushed onto the reader.
 */
export type AuditDetailValue = string | number | boolean | null

/** The machine-readable values an audited action carries. See {@link AUDIT_ACTION_DETAIL_KEYS}. */
export type AuditEventDetails = Readonly<Record<string, AuditDetailValue>>

/**
 * A persisted vocabulary member this build no longer declares.
 *
 * `action` and `targetType` are CLOSED vocabularies that are also PERSISTED, and those two facts
 * together are what makes this shape necessary (CLAUDE.md → "But a break must ARRIVE as one"):
 * retiring a member removes it from the type and NOT from the rows already written, so every
 * exhaustive `Record`/`switch` over it is total against the TYPE and partial against the DATA.
 * A reader that ignores the gap either renders `undefined` at an operator or throws in the
 * viewer itself.
 *
 * So a value that is no longer a member reads back NAMED as retired: never guessed onto a
 * current member (nothing can know which one was meant), and above all never DROPPED, because a
 * missing row is the single failure an audit log must not have.
 */
export interface RetiredAuditValue {
  retired: string
}

/** Whether a read-back vocabulary value is one this build no longer declares. */
export function isRetiredAuditValue<T extends string>(
  value: T | RetiredAuditValue,
): value is RetiredAuditValue {
  return typeof value !== 'string'
}

const AUDIT_ACTION_SET: ReadonlySet<string> = new Set(auditActionSchema.options)
const AUDIT_TARGET_TYPE_SET: ReadonlySet<string> = new Set(auditTargetTypeSchema.options)

/**
 * Whether a stored value is still a member of the action vocabulary — DERIVED from the picklist,
 * so it cannot drift from it the way a hand-written second list would.
 */
export function isAuditAction(value: string): value is AuditAction {
  return AUDIT_ACTION_SET.has(value)
}

/** Whether a stored value is still a member of the target-type vocabulary. Derived, as above. */
export function isAuditTargetType(value: string): value is AuditTargetType {
  return AUDIT_TARGET_TYPE_SET.has(value)
}

/** A stored `action` as either a current member or the retired value it is. */
export function readAuditAction(value: string): AuditAction | RetiredAuditValue {
  return isAuditAction(value) ? value : { retired: value }
}

/** A stored `targetType` as either a current member or the retired value it is. */
export function readAuditTargetType(value: string): AuditTargetType | RetiredAuditValue {
  return isAuditTargetType(value) ? value : { retired: value }
}

// ---------------------------------------------------------------------------
// The WIRE shapes the viewer reads. Separate from the vocabulary above because a read must cope
// with values a write cannot produce: a member retired since the row was written.
// ---------------------------------------------------------------------------

/** A persisted vocabulary member this build no longer declares, on the wire. */
export const retiredAuditValueSchema = v.object({ retired: v.string() })

/**
 * The acting principal, as the three shapes it can take.
 *
 * A union rather than `{ kind, id }`, so the id's MEANING travels with it: `usr_*` resolves
 * against the user roster and `pak_*` against the API-key list, and a viewer handed a bare id
 * would have to guess which. `system` carries no id at all, which is what stops it being confused
 * with a principal whose name merely failed to resolve.
 */
export const auditActorSchema = v.variant('kind', [
  v.object({ kind: v.literal('user'), userId: v.string() }),
  v.object({ kind: v.literal('apiKey'), apiKeyId: v.string() }),
  v.object({ kind: v.literal('system') }),
])

/** One audit event as the viewer renders it. */
export const auditEventViewSchema = v.object({
  id: v.string(),
  /** Epoch ms the action committed. */
  at: v.number(),
  /** The board it happened on, when the action was board-scoped. */
  workspaceId: v.nullable(v.string()),
  actor: auditActorSchema,
  /**
   * Unions with the retired shape for the reason stated on {@link RetiredAuditValue}: the row
   * outlives the vocabulary it was written against, and a viewer mapping actions to copy through
   * an exhaustive `Record` would otherwise splice `undefined` into an admin's screen.
   */
  action: v.union([auditActionSchema, retiredAuditValueSchema]),
  targetType: v.union([auditTargetTypeSchema, retiredAuditValueSchema]),
  targetId: v.string(),
  /** Machine-readable values, interpolated into translated copy. See {@link AUDIT_ACTION_DETAIL_KEYS}. */
  details: v.record(v.string(), v.nullable(v.union([v.string(), v.number(), v.boolean()]))),
  /**
   * Display name for the ACTOR, resolved server-side, or null.
   *
   * Null is a real and expected answer, not a failure: an audit log outlives the people in it, and
   * "the user who did this no longer exists" is exactly the kind of thing it is kept to record. The
   * viewer renders the id in that case rather than an empty space, so a row never reads as though
   * nobody performed it.
   */
  actorName: v.nullable(v.string()),
  /** Display name for the TARGET when it is a user, resolved server-side, or null. As above. */
  targetName: v.nullable(v.string()),
})
export type AuditEventWire = v.InferOutput<typeof auditEventViewSchema>

/** One page of an account's audit log, newest first. */
export const auditEventPageSchema = v.object({
  events: v.array(auditEventViewSchema),
  /**
   * Opaque cursor for the next (older) page, or null at the end. Keyset, never an offset: the
   * log grows while it is being read, and an offset would re-serve or skip rows at every boundary.
   */
  nextCursor: v.nullable(v.string()),
})
