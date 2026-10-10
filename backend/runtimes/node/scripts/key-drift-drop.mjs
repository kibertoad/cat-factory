// Drop ONE unrecoverable sealed credential surfaced by the ENCRYPTION_KEY-drift sweep, so the
// app stops throwing on it and the operator can re-enter it (ADR 0026 D6.3). The value is
// ALREADY gone (sealed under a key this deployment no longer has); this only removes the dead
// ciphertext and flips its connection to "needs re-entry".
//
//   Usage (from backend/runtimes/node, or `pnpm --filter @cat-factory/node-server key-drift:drop`):
//     DATABASE_URL=postgres://… node scripts/key-drift-drop.mjs \
//       --source environment_connection --id "<workspaceId>|<provisionType>|<manifestId>"
//     DATABASE_URL=postgres://… node scripts/key-drift-drop.mjs \
//       --source observability_connection --id "<workspaceId>"
//
// The `--source` / `--id` come verbatim from the `key_drift` notification card (or the sweep
// log). This mirrors the in-app "drop all stale" action, one credential at a time.
//
// IRREVERSIBLE for the value itself: if the key was changed BY MISTAKE, do NOT drop — restore
// the previous ENCRYPTION_KEY instead and every affected credential decrypts again. Dropping is
// for when the old key is genuinely gone. Destructive + operator-invoked; never runs on boot.

import { Pool } from 'pg'

const SCHEMA_IDENTIFIER = /^[a-z_][a-z0-9_]*$/

function argOf(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined
}

function resolveSchema() {
  const value = (process.env.DB_SCHEMA || 'public').trim() || 'public'
  if (!SCHEMA_IDENTIFIER.test(value)) {
    console.error(`Invalid DB_SCHEMA "${value}": must be a plain lowercase Postgres identifier.`)
    process.exit(1)
  }
  return value
}

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is required (the database holding the sealed credential).')
    process.exit(1)
  }
  const source = argOf('source')
  const id = argOf('id')
  if (!source || id === undefined) {
    console.error('Both --source and --id are required (copy them from the key_drift card).')
    process.exit(1)
  }

  const schema = resolveSchema()
  console.warn('')
  console.warn('  [destructive] cat-factory key-drift:drop')
  console.warn(`  source: ${source}   id: ${id}`)
  console.warn('  Dropping the dead ciphertext; the connection will need re-entry.')
  console.warn(
    '  If the ENCRYPTION_KEY was changed by MISTAKE, restore it instead — that recovers the value.',
  )
  console.warn('')

  // Set search_path via the connection `options` (mirrors `createDbClient`) so EVERY connection the
  // pool hands out lands in the right schema. A separate `SET search_path` query would only bind the
  // one pooled connection it happened to run on, not the connection the UPDATE/DELETE later acquires.
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    let changes = 0
    if (source === 'environment_connection') {
      // The composite id is `workspaceId|provisionType|manifestId`. workspaceId/provisionType are
      // system slugs with no `|`; manifestId may contain one, so it captures everything after the
      // second delimiter (keeping the round-trip with `envId`'s `join('|')` lossless).
      const parts = id.split('|')
      const workspaceId = parts[0] ?? ''
      const provisionType = parts[1] ?? ''
      const manifestId = parts.slice(2).join('|')
      const res = await pool.query(
        `UPDATE environment_connections SET deleted_at = $1
         WHERE workspace_id = $2 AND provision_type = $3 AND manifest_id = $4 AND deleted_at IS NULL`,
        [Date.now(), workspaceId, provisionType, manifestId],
      )
      changes = res.rowCount ?? 0
    } else if (source === 'observability_connection') {
      const res = await pool.query(
        'DELETE FROM observability_connections WHERE workspace_id = $1',
        [id],
      )
      changes = res.rowCount ?? 0
    } else {
      console.error(
        `Unknown --source "${source}". Expected environment_connection or observability_connection.`,
      )
      process.exit(1)
    }
    if (changes > 0) {
      console.warn(
        `  done. Dropped ${changes} sealed credential(s). Re-enter the connection to re-seal.`,
      )
    } else {
      console.warn('  no matching sealed credential (already dropped, or wrong --source/--id).')
    }
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error('key-drift:drop failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
