import { AUDIT_ACTION_DETAIL_KEYS, auditActionSchema } from '@cat-factory/contracts'
import type { AuditEventWire } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { ACTION_KEYS, actorLabel, describeEvent } from './AccountAuditLog.logic'

/**
 * The audit viewer's sentence composition. What is worth pinning is the set of rows a happy-path
 * render never produces, because those are the rows an audit log is kept FOR: an action this build
 * has retired, a `details` blob that would not parse, a person who is no longer here.
 */

/** A fake `t` that renders `key(param=value, …)`, so an unresolved slot is visible as itself. */
function fakeT(key: string, params?: Record<string, string>): string {
  const rendered = Object.entries(params ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join(',')
  return rendered ? `${key}(${rendered})` : key
}

function event(overrides: Partial<AuditEventWire> = {}): AuditEventWire {
  return {
    id: 'aud_1',
    at: 1_700_000_000_000,
    workspaceId: null,
    actor: { kind: 'user', userId: 'usr_actor' },
    action: 'account.member_roles_changed',
    targetType: 'user',
    targetId: 'usr_target',
    details: { previousRoles: 'developer', roles: 'admin' },
    actorName: 'Ada',
    targetName: 'Grace',
    ...overrides,
  } as AuditEventWire
}

describe('audit sentence composition', () => {
  it('gives every action in the wire vocabulary its own copy', () => {
    // Derived from the picklist the backend writes against, not a list retyped here: an action
    // added on the backend fails THIS assertion rather than rendering its raw code at an operator.
    expect(Object.keys(ACTION_KEYS).sort()).toEqual([...auditActionSchema.options].sort())
  })

  it('interpolates the row’s own values', () => {
    expect(describeEvent(event(), fakeT)).toBe(
      'layout.auditLog.actions.accountMemberRolesChanged(previousRoles=developer,roles=admin,target=Grace)',
    )
  })

  it('defaults every slot the ACTION declares when the details blob was unreadable', () => {
    // The regression: `decodeAuditDetails` deliberately returns `{}` for a blob that will not
    // parse, keeping a row that states less over losing the row entirely. Defaulting by iterating
    // the row cannot reach that case — there are no keys to iterate — so the sentence rendered the
    // literal `{previousRoles}` at an operator. The seed comes from the contract, so the two
    // declared slots are known even when the row carries neither.
    expect(describeEvent(event({ details: {} }), fakeT)).toBe(
      'layout.auditLog.actions.accountMemberRolesChanged(previousRoles=layout.auditLog.values.none,' +
        'roles=layout.auditLog.values.none,target=Grace)',
    )
  })

  it('defaults a slot the row carries as null or empty, without dropping it', () => {
    expect(describeEvent(event({ details: { previousRoles: null, roles: '' } }), fakeT)).toBe(
      'layout.auditLog.actions.accountMemberRolesChanged(previousRoles=layout.auditLog.values.none,' +
        'roles=layout.auditLog.values.none,target=Grace)',
    )
  })

  it('leaves no declared slot of any action unfilled on an empty details blob', () => {
    // The structural form of the case above, across the whole vocabulary rather than one action:
    // whatever an action declares it carries, a row carrying none of it still renders every slot.
    for (const action of auditActionSchema.options) {
      const sentence = describeEvent(event({ action, details: {} }), fakeT)
      for (const slot of AUDIT_ACTION_DETAIL_KEYS[action]) {
        expect(sentence).toContain(`${slot}=layout.auditLog.values.none`)
      }
    }
  })

  it('names a RETIRED action as itself rather than dropping or guessing it', () => {
    // Nothing here can know what a retired member meant, and a missing row is the one failure an
    // audit log must not have.
    expect(describeEvent(event({ action: { retired: 'account.something_gone' } }), fakeT)).toBe(
      'layout.auditLog.retiredAction(action=account.something_gone)',
    )
  })

  it('falls back to the raw id for a person who is no longer here', () => {
    // Which is precisely the kind of thing the log is kept to record, so it renders rather than
    // becoming a placeholder.
    expect(actorLabel(event({ actorName: null }), fakeT)).toBe('usr_actor')
    expect(describeEvent(event({ targetName: null }), fakeT)).toContain('target=usr_target')
  })

  it('shows an API key as the key, never the person who minted it', () => {
    // A leaked key has to stay distinguishable from the human it was minted by.
    expect(actorLabel(event({ actor: { kind: 'apiKey', apiKeyId: 'key_9' } }), fakeT)).toBe(
      'layout.auditLog.actors.apiKey(id=key_9)',
    )
  })

  it('says the SYSTEM acted, which is not the same as a user we failed to resolve', () => {
    expect(actorLabel(event({ actor: { kind: 'system' } }), fakeT)).toBe(
      'layout.auditLog.actors.system',
    )
  })
})
