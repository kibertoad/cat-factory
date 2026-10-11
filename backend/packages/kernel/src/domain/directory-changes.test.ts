import { describe, expect, it } from 'vitest'
import { directoryChangeFromRow, type StoredDirectoryChange } from './directory-changes.js'

const row = (overrides: Partial<StoredDirectoryChange> = {}): StoredDirectoryChange => ({
  account_id: 'acc',
  seq: 7,
  entity_type: 'workspace_membership',
  workspace_id: 'ws',
  entity_id: 'usr',
  at: 1_000,
  ...overrides,
})

describe('directoryChangeFromRow', () => {
  it('maps the stored columns onto the record', () => {
    expect(directoryChangeFromRow(row())).toEqual({
      accountId: 'acc',
      seq: 7,
      entityType: 'workspace_membership',
      workspaceId: 'ws',
      entityId: 'usr',
      at: 1_000,
    })
  })

  it('refuses an entity type this build cannot interpret rather than skipping the row', () => {
    expect(() => directoryChangeFromRow(row({ entity_type: 'team' }))).toThrow(
      "Unknown directory entity type 'team' at seq 7",
    )
  })
})
