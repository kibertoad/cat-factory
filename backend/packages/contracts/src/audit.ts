import * as v from 'valibot'

// ---------------------------------------------------------------------------
// The ACCOUNT AUDIT vocabulary: what privileged action a recorded audit event describes,
// and who performed it.
//
// It lives in contracts rather than kernel because both sides must agree about the SAME
// member list for different reasons. The backend writes an action when a mutation commits;
// the SPA's viewer renders each one as human copy, through an exhaustive `Record` over this
// picklist, so a member added without translated copy fails the SPA's typecheck instead of
// rendering a raw `account.member.role_changed` at an operator. A vocabulary kept only on the
// backend becomes a hand-copied list in the viewer, and the two then drift in the one
// direction that matters: an action nobody can read is an action nobody audits.
//
// The vocabulary is deliberately CLOSED and deliberately COARSE. Closed, because an audit
// reader filters by action class and a free-form string makes `member.role_changed` and
// `member.roles_changed` two unrelated actions that look identical in a list. Coarse, because
// an action names WHAT changed, never the values: the values live in `summary`, and the ones
// that are secret never get recorded at all (see `AuditEvent` in kernel).
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
