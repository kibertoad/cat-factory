/**
 * Build an `INSERT … ON CONFLICT(pk) DO UPDATE` statement from a value map.
 * Columns in `conflictColumns` (the primary key) and `excludeFromUpdate` are not
 * overwritten on conflict — the latter protects fields owned elsewhere (e.g. a
 * repo's `block_id` link, set independently of sync).
 */
export function buildUpsert(
  table: string,
  values: Record<string, unknown>,
  conflictColumns: string[],
  excludeFromUpdate: string[] = [],
): { sql: string; binds: unknown[] } {
  const columns = Object.keys(values)
  const placeholders = columns.map(() => '?').join(', ')
  const protectedCols = new Set([...conflictColumns, ...excludeFromUpdate])
  const updates = columns
    .filter((c) => !protectedCols.has(c))
    .map((c) => `${c} = excluded.${c}`)
    .join(', ')
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT(${conflictColumns.join(', ')}) DO UPDATE SET ${updates}`
  return { sql, binds: Object.values(values) }
}
