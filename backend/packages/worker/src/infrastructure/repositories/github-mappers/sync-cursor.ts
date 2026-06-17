import type { SyncCursor } from '@cat-factory/kernel'

export interface SyncCursorRow {
  etag: string | null
  last_synced_at: number | null
  since_iso: string | null
}

export function rowToCursor(row: SyncCursorRow): SyncCursor {
  return { etag: row.etag, lastSyncedAt: row.last_synced_at, sinceIso: row.since_iso }
}
