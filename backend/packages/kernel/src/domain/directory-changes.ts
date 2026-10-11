import { type DirectoryEntityType, isDirectoryEntityType } from '@cat-factory/contracts'
import type { DirectoryChangeRecord } from '../ports/directory-changes.js'

// The rules both facades' directory repositories apply to stored change-feed rows
// (backend/docs/adr/0067-directory-sync.md), kept here so the D1 and Postgres readers cannot drift.

/** A `directory_changes` row as both facades store it. */
export interface StoredDirectoryChange {
  account_id: string
  seq: number
  entity_type: string
  workspace_id: string | null
  entity_id: string
  at: number
}

/** The entity types a key limited to some workspaces may read: the ones that belong to a board. */
export const WORKSPACE_DIRECTORY_ENTITY_TYPES: readonly DirectoryEntityType[] = [
  'workspace',
  'workspace_membership',
  'repo',
]

/**
 * Map a stored change row to its record. The vocabulary is append-only, so an unknown entity type
 * is a row this build cannot interpret and it throws rather than skipping it: a reader that
 * dropped the row would advance its cursor past a change it never served.
 */
export function directoryChangeFromRow(row: StoredDirectoryChange): DirectoryChangeRecord {
  if (!isDirectoryEntityType(row.entity_type)) {
    throw new Error(`Unknown directory entity type '${row.entity_type}' at seq ${row.seq}`)
  }
  return {
    accountId: row.account_id,
    seq: row.seq,
    entityType: row.entity_type,
    workspaceId: row.workspace_id,
    entityId: row.entity_id,
    at: row.at,
  }
}
