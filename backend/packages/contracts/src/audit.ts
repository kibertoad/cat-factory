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
