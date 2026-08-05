import { describe, expect, it } from 'vitest'
import {
  AUDIT_PAGE_LIMIT_DEFAULT,
  AUDIT_PAGE_LIMIT_MAX,
  auditEventColumns,
  auditPageLimit,
  decodeAuditCursor,
  decodeAuditDetails,
  encodeAuditCursor,
  rowToAuditEventView,
} from './audit-log.js'
import type { AuditEventRecord } from '../ports/audit.js'

// The audit log's shared rules live in kernel because BOTH facades' repositories map through
// them; these are the cases a repository test would only catch on one runtime.

const record: AuditEventRecord = {
  id: 'aud_1',
  accountId: 'acc-1',
  workspaceId: null,
  actor: { kind: 'user', userId: 'usr-1' },
  action: 'workspace.member_role_changed',
  targetType: 'user',
  targetId: 'usr-2',
  details: { previousRole: 'viewer', role: 'admin' },
  at: 1_700_000_000_000,
}

describe('auditPageLimit', () => {
  it('defaults an absent, unusable or non-finite limit', () => {
    expect(auditPageLimit()).toBe(AUDIT_PAGE_LIMIT_DEFAULT)
    expect(auditPageLimit(0)).toBe(AUDIT_PAGE_LIMIT_DEFAULT)
    expect(auditPageLimit(-5)).toBe(AUDIT_PAGE_LIMIT_DEFAULT)
    expect(auditPageLimit(Number.NaN)).toBe(AUDIT_PAGE_LIMIT_DEFAULT)
  })

  it('clamps to the ceiling and floors a fraction', () => {
    expect(auditPageLimit(10)).toBe(10)
    expect(auditPageLimit(10.7)).toBe(10)
    expect(auditPageLimit(10_000)).toBe(AUDIT_PAGE_LIMIT_MAX)
  })
})

describe('audit cursor codec', () => {
  it('round-trips the (at, id) pair', () => {
    expect(decodeAuditCursor(encodeAuditCursor({ at: 42, id: 'aud_9' }))).toEqual({
      at: 42,
      id: 'aud_9',
    })
  })

  it('keeps an id containing the separator whole', () => {
    // The split is on the FIRST colon only: an id is opaque, and re-splitting it would hand the
    // keyset a truncated tie-break, which reads as a page that silently starts elsewhere.
    expect(decodeAuditCursor('42:aud:9')).toEqual({ at: 42, id: 'aud:9' })
  })

  it('reads anything unusable as "start from the newest"', () => {
    for (const cursor of [undefined, null, '', 'nonsense', ':aud_1', '42:', 'x:aud_1', '1e999:a']) {
      expect(decodeAuditCursor(cursor)).toBeNull()
    }
  })
})

describe('audit details codec', () => {
  it('round-trips every value shape a writer may state', () => {
    const columns = auditEventColumns({
      ...record,
      details: { role: 'admin', limit: 250, cleared: null, urgent: true },
    })
    expect(decodeAuditDetails(columns.details)).toEqual({
      role: 'admin',
      limit: 250,
      cleared: null,
      urgent: true,
    })
  })

  it('reads an unreadable blob as no values, never as a lost row', () => {
    // Who acted, on what, and when are the irreplaceable parts of the row. Losing all of it
    // because one event's values no longer parse is the single failure a viewer must not have.
    for (const raw of [null, '', 'not json', '[]', 'null', '3', '"a string"']) {
      expect(decodeAuditDetails(raw)).toEqual({})
    }
  })
})

describe('rowToAuditEventView', () => {
  it('maps a written row straight back', () => {
    expect(rowToAuditEventView(auditEventColumns(record))).toEqual(record)
  })

  it('names a retired action and target type instead of guessing or dropping', () => {
    const view = rowToAuditEventView({
      ...auditEventColumns(record),
      action: 'account.seat_reassigned',
      target_type: 'apiKey',
    })
    expect(view.action).toEqual({ retired: 'account.seat_reassigned' })
    expect(view.targetType).toEqual({ retired: 'apiKey' })
    // The rest of the row is untouched: a retirement costs the label, not the evidence.
    expect(view.actor).toEqual({ kind: 'user', userId: 'usr-1' })
    expect(view.details).toEqual(record.details)
  })

  it('reads an incomplete principal as `system` rather than inventing a user', () => {
    const base = auditEventColumns(record)
    expect(rowToAuditEventView({ ...base, actor_user_id: null }).actor).toEqual({ kind: 'system' })
    expect(
      rowToAuditEventView({ ...base, actor_kind: 'apiKey', actor_user_id: null }).actor,
    ).toEqual({ kind: 'system' })
    expect(
      rowToAuditEventView({
        ...base,
        actor_kind: 'apiKey',
        actor_user_id: null,
        actor_api_key_id: 'pak-1',
      }).actor,
    ).toEqual({ kind: 'apiKey', apiKeyId: 'pak-1' })
  })
})
