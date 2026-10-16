// The Acme account's audit log, newest first: a page with one row for each kind of actor (a
// person, an API key and the system), and an older page with an actor who has left and an action
// this build no longer declares. The people, ids and times are made up.
import type { AuditEventWire } from '@cat-factory/contracts'
import { orgAccount } from './accounts.stories.mocks'

function event(
  overrides: Partial<AuditEventWire> & Pick<AuditEventWire, 'id' | 'action' | 'targetId'>,
): AuditEventWire {
  return {
    at: Date.UTC(2026, 9, 12, 14, 5),
    workspaceId: null,
    actor: { kind: 'user', userId: 'usr_maya' },
    targetType: 'user',
    details: {},
    actorName: 'Maya Lindqvist',
    targetName: null,
    ...overrides,
  }
}

/** One of each actor kind, newest first. */
export const auditEvents: AuditEventWire[] = [
  event({
    id: 'aud_06',
    action: 'workspace.member_role_changed',
    workspaceId: 'ws_story',
    targetId: 'usr_tomas',
    targetName: 'Tomás Ruiz',
    details: { previousRole: 'member', role: 'viewer' },
  }),
  event({
    id: 'aud_05',
    at: Date.UTC(2026, 9, 12, 9, 40),
    action: 'account.invitation_created',
    targetType: 'invitation',
    targetId: 'inv_3k9d',
    details: { email: 'jonas@acme.dev', roles: 'developer' },
  }),
  event({
    id: 'aud_04',
    at: Date.UTC(2026, 9, 11, 17, 2),
    action: 'account.budget_changed',
    actor: { kind: 'apiKey', apiKeyId: 'pak_ops_7f2a' },
    actorName: null,
    targetType: 'account',
    targetId: orgAccount.id,
    details: { limit: 500 },
  }),
  event({
    id: 'aud_03',
    at: Date.UTC(2026, 9, 10, 3, 0),
    action: 'account.invitation_revoked',
    actor: { kind: 'system' },
    actorName: null,
    targetType: 'invitation',
    targetId: 'inv_8p1q',
    details: { email: 'contractor@example.com' },
  }),
]

/** Rows from people who have left, and an action this build no longer declares. */
export const olderAuditEvents: AuditEventWire[] = [
  event({
    id: 'aud_02',
    at: Date.UTC(2026, 8, 30, 11, 15),
    action: 'account.member_roles_changed',
    actor: { kind: 'user', userId: 'usr_ines' },
    actorName: null,
    targetId: 'usr_priya',
    targetName: 'Priya Natarajan',
    details: { previousRoles: 'developer', roles: 'admin, developer' },
  }),
  event({
    id: 'aud_01',
    at: Date.UTC(2026, 8, 2, 8, 30),
    action: { retired: 'account.sso_enforced' },
    targetType: 'account',
    targetId: orgAccount.id,
  }),
]
