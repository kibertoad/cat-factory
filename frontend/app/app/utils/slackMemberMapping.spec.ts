import { describe, it, expect } from 'vitest'
import type { SlackMemberMappingEntry } from '~/types/slack'
import {
  type MemberRow,
  emptyMemberRow,
  hasHalfFilledRow,
  toMemberEntries,
  toMemberRow,
} from './slackMemberMapping'

const row = (partial: Partial<MemberRow> & { uid: string }): MemberRow => ({
  userId: '',
  slackUserId: '',
  role: 'engineering',
  ...partial,
})

describe('hasHalfFilledRow', () => {
  it('is false for fully-filled rows', () => {
    expect(hasHalfFilledRow([row({ uid: 'a', userId: 'usr_1', slackUserId: 'U1' })])).toBe(false)
  })

  it('is false for fully-empty rows (unused slots)', () => {
    expect(hasHalfFilledRow([row({ uid: 'a' }), row({ uid: 'b' })])).toBe(false)
  })

  it('is true when only the user id is filled', () => {
    expect(hasHalfFilledRow([row({ uid: 'a', userId: 'usr_1' })])).toBe(true)
  })

  it('is true when only the Slack id is filled', () => {
    expect(hasHalfFilledRow([row({ uid: 'a', slackUserId: 'U1' })])).toBe(true)
  })

  it('treats whitespace-only ids as blank', () => {
    expect(hasHalfFilledRow([row({ uid: 'a', userId: '  ', slackUserId: 'U1' })])).toBe(true)
  })

  it('flags a half-filled row among valid ones', () => {
    expect(
      hasHalfFilledRow([
        row({ uid: 'a', userId: 'usr_1', slackUserId: 'U1' }),
        row({ uid: 'b', userId: 'usr_2' }),
      ]),
    ).toBe(true)
  })
})

describe('toMemberEntries', () => {
  it('keeps fully-filled rows, drops empty slots, and strips uid', () => {
    const rows: MemberRow[] = [
      row({ uid: 'a', userId: 'usr_1', slackUserId: 'U1', role: 'product' }),
      row({ uid: 'b' }), // empty slot — dropped
      row({ uid: 'c', userId: 'usr_2', slackUserId: 'U2' }),
    ]
    expect(toMemberEntries(rows)).toEqual([
      { userId: 'usr_1', slackUserId: 'U1', role: 'product' },
      { userId: 'usr_2', slackUserId: 'U2', role: 'engineering' },
    ])
  })

  it('does not leak the client-only uid onto the wire payload', () => {
    const [entry] = toMemberEntries([row({ uid: 'a', userId: 'usr_1', slackUserId: 'U1' })])
    expect(entry).not.toHaveProperty('uid')
  })
})

describe('toMemberRow', () => {
  it('stamps the uid and defaults a missing role', () => {
    const entry: SlackMemberMappingEntry = { userId: 'usr_1', slackUserId: 'U1' }
    expect(toMemberRow(entry, 'm1')).toEqual({
      userId: 'usr_1',
      slackUserId: 'U1',
      role: 'engineering',
      uid: 'm1',
    })
  })

  it('preserves an explicit role', () => {
    const entry: SlackMemberMappingEntry = { userId: 'usr_1', slackUserId: 'U1', role: 'product' }
    expect(toMemberRow(entry, 'm2').role).toBe('product')
  })
})

describe('emptyMemberRow', () => {
  it('builds a blank engineering row with the given uid', () => {
    expect(emptyMemberRow('m9')).toEqual({
      uid: 'm9',
      userId: '',
      slackUserId: '',
      role: 'engineering',
    })
  })
})
