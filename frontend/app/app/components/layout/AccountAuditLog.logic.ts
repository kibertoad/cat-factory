import { AUDIT_ACTION_DETAIL_KEYS, isRetiredAuditValue } from '@cat-factory/contracts'
import type {
  AccountRole,
  AuditAction,
  AuditEventWire,
  WorkspaceRole,
} from '@cat-factory/contracts'

// How one audit row becomes one sentence. Kept out of the SFC on the same seam as
// `StepToolServers.logic.ts`, because the two rules worth asserting here are both about rows a
// happy-path render never produces: an action this build has retired, and a row whose `details`
// blob would not parse.
//
// The design this serves: the backend records machine-readable FIELDS and never prose, since a
// row is persisted and English written today could not be re-rendered for a reader in another
// locale years later. So every sentence is a translated key plus the row's own values.

/**
 * Action → message key. EXHAUSTIVE over the contract union on purpose: the alternative is a lookup
 * returning `undefined` for an action somebody added on the backend, which renders a raw
 * `account.member_roles_changed` at an operator instead of failing the build.
 */
export const ACTION_KEYS: Record<AuditAction, string> = {
  'account.member_added': 'layout.auditLog.actions.accountMemberAdded',
  'account.member_roles_changed': 'layout.auditLog.actions.accountMemberRolesChanged',
  'account.budget_changed': 'layout.auditLog.actions.accountBudgetChanged',
  'account.settings_changed': 'layout.auditLog.actions.accountSettingsChanged',
  'account.invitation_created': 'layout.auditLog.actions.accountInvitationCreated',
  'account.invitation_revoked': 'layout.auditLog.actions.accountInvitationRevoked',
  'account.invitation_accepted': 'layout.auditLog.actions.accountInvitationAccepted',
  'account.member_sessions_revoked': 'layout.auditLog.actions.accountMemberSessionsRevoked',
  'workspace.member_added': 'layout.auditLog.actions.workspaceMemberAdded',
  'workspace.member_role_changed': 'layout.auditLog.actions.workspaceMemberRoleChanged',
  'workspace.member_removed': 'layout.auditLog.actions.workspaceMemberRemoved',
  'workspace.access_mode_changed': 'layout.auditLog.actions.workspaceAccessModeChanged',
}

/**
 * Role id → label key, for the detail slots that carry roles. The writer stores the ids (a list
 * joined as `'admin, developer'`), and an id on screen reads as a code, not a role.
 */
const ACCOUNT_ROLE_KEYS: Record<AccountRole, string> = {
  admin: 'layout.accountTeam.roles.admin',
  developer: 'layout.accountTeam.roles.developer',
  product: 'layout.accountTeam.roles.product',
}
const WORKSPACE_ROLE_KEYS: Record<WorkspaceRole, string> = {
  admin: 'layout.workspaceMembers.roles.admin',
  member: 'layout.workspaceMembers.roles.member',
  viewer: 'layout.workspaceMembers.roles.viewer',
}
const ROLE_SLOT_KEYS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  roles: ACCOUNT_ROLE_KEYS,
  previousRoles: ACCOUNT_ROLE_KEYS,
  role: WORKSPACE_ROLE_KEYS,
  previousRole: WORKSPACE_ROLE_KEYS,
}

/** Translate a key with interpolation params. The component owns the i18n instance; this is pure. */
export type Translate = (key: string, params?: Record<string, string>) => string

/**
 * The row's detail fields as interpolation params.
 *
 * Seeded from what the ACTION declares it carries (`AUDIT_ACTION_DETAIL_KEYS`, the same contract
 * the backend writers are held to), then overlaid with what the row actually holds. Both halves
 * are needed, and the seed is the one easy to leave out: iterating the row alone defaults
 * nothing, because a row whose `details` blob was unreadable has NO keys to iterate — and that is
 * precisely the row the defaulting exists for. `decodeAuditDetails` returns an empty set there by
 * design, keeping a row that states less over losing the row entirely, so without the seed the
 * sentence renders the literal `{previousRoles}` at an operator.
 *
 * Derived from the contract rather than re-listed, so an action whose fields change cannot leave
 * this behind: the `Record` it reads is exhaustive over the same picklist `ACTION_KEYS` is.
 */
function detailParams(
  action: AuditAction,
  details: AuditEventWire['details'],
  t: Translate,
): Record<string, string> {
  const none = t('layout.auditLog.values.none')
  const params: Record<string, string> = {}
  for (const key of AUDIT_ACTION_DETAIL_KEYS[action]) params[key] = none
  for (const [key, value] of Object.entries(details)) {
    if (value === null || value === '') params[key] = none
    else params[key] = roleLabels(ROLE_SLOT_KEYS[key], String(value), t)
  }
  return params
}

/**
 * A role slot's ids as labels. An id this build does not know (a role retired after the row was
 * written) stays as itself rather than being guessed onto a current role.
 */
function roleLabels(
  keys: Readonly<Record<string, string>> | undefined,
  value: string,
  t: Translate,
): string {
  if (!keys) return value
  return value
    .split(',')
    .map((id) => id.trim())
    .map((id) => (Object.hasOwn(keys, id) ? t(keys[id]!) : id))
    .join(', ')
}

/** Who the action was performed ON: the resolved name, else the raw id. */
function targetLabel(event: AuditEventWire): string {
  return event.targetName ?? event.targetId
}

/**
 * Who performed it.
 *
 * The three principal kinds render differently on purpose. A user shows their name (or their id,
 * when the person is gone — which is precisely the kind of thing the log is kept to record); an
 * API key shows the key, never the person who minted it, so a leaked key is distinguishable from
 * them; and `system` says the engine acted, which is a different fact from a user we failed to
 * resolve and must never look the same.
 */
export function actorLabel(event: AuditEventWire, t: Translate): string {
  if (event.actor.kind === 'system') return t('layout.auditLog.actors.system')
  if (event.actor.kind === 'apiKey') {
    return t('layout.auditLog.actors.apiKey', { id: event.actor.apiKeyId })
  }
  return event.actorName ?? event.actor.userId
}

/**
 * The sentence for one row.
 *
 * A RETIRED action (one this build no longer declares, in a row written before it was retired) is
 * named as itself rather than dropped or guessed onto a current member. Nothing here can know what
 * it meant, and a missing row is the one failure an audit log must not have — so it renders as
 * "unrecognised action: <value>" and keeps its actor, target and timestamp.
 */
export function describeEvent(event: AuditEventWire, t: Translate): string {
  if (isRetiredAuditValue(event.action)) {
    return t('layout.auditLog.retiredAction', { action: event.action.retired })
  }
  return t(ACTION_KEYS[event.action], {
    target: targetLabel(event),
    ...detailParams(event.action, event.details, t),
  })
}
