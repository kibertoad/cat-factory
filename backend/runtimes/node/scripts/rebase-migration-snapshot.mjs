// Rebase a Drizzle migration's snapshot onto the current merged migration lineage.
//
//   Usage (run from backend/runtimes/node):
//     node scripts/rebase-migration-snapshot.mjs <migration-folder-name>
//
//   e.g. node scripts/rebase-migration-snapshot.mjs 20260625190253_telemetry_schema_and_agent_context
//
// WHY THIS EXISTS
// ---------------
// Drizzle (drizzle-kit 1.x, snapshot format v8) stores migrations as a DAG: each
// `drizzle/<ts>_<name>/snapshot.json` carries a content-addressed `id` plus a
// `prevIds` array pointing at the snapshot(s) it was generated on top of. There is
// NO `meta/_journal.json`; ordering/lineage is derived purely from `prevIds`.
//
// When two branches each add a migration and you merge them, git happily keeps BOTH
// migration folders (no textual conflict — they are different files). But the later
// branch's snapshot still points (via `prevIds`) at the PRE-MERGE lineage tip, so the
// two migrations look like divergent siblings off a common ancestor. `drizzle-kit
// check` then reports "Non-commutative migrations detected" (both branches "create"
// the same already-existing tables when diffed from that shared ancestor).
//
// The fix is to re-root the LATER migration so it becomes a linear descendant of the
// other branch's migration. This script rewrites the named migration's snapshot.json
// so that:
//   - its `ddl` reflects the CURRENT, merged src/db/schema.ts (the single source of
//     truth — by definition already includes both branches' schema changes), and
//   - its `prevIds` point at the leaf snapshot(s) of every OTHER migration (the merged
//     lineage tip), making it the new sole leaf.
//
// It does NOT touch the hand-written migration.sql. That file must still encode the
// delta from the prior state to the merged schema — usually it already does, since it
// was the human-authored intent; eyeball it after running, then `pnpm db:check`.
//
// See CLAUDE.md → "Resolving conflicting Drizzle migrations" for the full playbook.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const drizzleDir = join(here, '..', 'drizzle')
const schemaPath = join(here, '..', 'src', 'db', 'schema.ts')

const target = process.argv[2]
if (!target) {
  console.error('error: pass the migration folder name to rebase, e.g.')
  console.error(
    '  node scripts/rebase-migration-snapshot.mjs 20260625190253_telemetry_schema_and_agent_context',
  )
  process.exit(1)
}

const targetSnapshot = join(drizzleDir, target, 'snapshot.json')
if (!existsSync(targetSnapshot)) {
  console.error(`error: ${targetSnapshot} not found`)
  process.exit(1)
}

// Leaf ids of every OTHER migration = ids that no other snapshot references as a
// parent. These become the rebased migration's prevIds (one id ⇒ linear; several ⇒ a
// merge node that collapses multiple leaves, mirroring drizzle-kit's own behaviour).
const others = readdirSync(drizzleDir)
  .filter((name) => name !== target)
  .map((name) => join(drizzleDir, name, 'snapshot.json'))
  .filter((p) => existsSync(p))
  .map((p) => JSON.parse(readFileSync(p, 'utf8')))

const allIds = new Set(others.map((s) => s.id))
const referenced = new Set(others.flatMap((s) => s.prevIds ?? []))
const leafIds = [...allIds].filter((id) => !referenced.has(id))
if (leafIds.length === 0) {
  console.error('error: could not determine a leaf snapshot to rebase onto')
  process.exit(1)
}

// generateDrizzleJson is the NON-interactive half of `drizzle-kit generate`: it
// serialises the live schema to a v8 snapshot (no rename/move prompts). We then set
// prevIds to the full leaf set. (`drizzle-kit generate` would prompt to disambiguate
// table moves like `SET SCHEMA`, which can't run in CI / non-TTY shells — that prompt
// is exactly why this script exists.)
const { generateDrizzleJson } = await import('drizzle-kit/api-postgres')
const schema = await import(pathToFileURL(schemaPath).href)
const snapshot = await generateDrizzleJson(schema, leafIds[0])
snapshot.prevIds = leafIds

writeFileSync(targetSnapshot, JSON.stringify(snapshot, null, 2))
console.log(`rebased ${target}`)
console.log(`  id      = ${snapshot.id}`)
console.log(`  prevIds = ${JSON.stringify(leafIds)}`)
console.log("next: review the folder's migration.sql, then run `pnpm db:check`")
