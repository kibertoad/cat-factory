#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Pilot golden detection — regenerate / drift-check the stack-recipes pilot goldens.
//
// The `stack-recipes-and-shared-stacks` initiative's acceptance pilot is a complex
// consumer monolith + a sibling shared-infra stack. This script runs the deterministic
// provisioning detector (the SAME code the app runs) over each repo via a filesystem
// `ProvisioningRepoReader`, and either writes or diffs the committed goldens under
// `src/modules/environments/__fixtures__/pilot/`.
//
// Two sources per target, in priority order:
//   1. A LIVE clone, when its env var is set (ACME_MONOLITH_DIR / ACME_SHARED_SERVICES_DIR)
//      — the upstream-drift alarm: run `--check` after pulling the pilot repos to catch a
//      structural change (a new service, a renamed override, a moved seed dir).
//   2. The committed, sanitized FIXTURES (the default) — regenerate the goldens after a
//      deliberate detector or fixture change with `--write`.
//
// SANITIZATION: the fixtures are already sanitized, so running against them needs no map.
// A live clone carries upstream-specific names, so supply a replacement map to translate
// them to the fixtures' placeholders BEFORE comparing — either PILOT_SANITIZE_MAP (a JSON
// array of {"from","to"}) or a gitignored `scripts/pilot-sanitize.local.json` of the same
// shape. Keeping the map out of the repo is deliberate: no upstream name is committed here.
// `--write` REFUSES to run against a live clone with no map (exit 2), so a golden refresh can
// never accidentally bake upstream names into the committed files.
//
// Usage:
//   node scripts/pilot-detect-golden.mjs            # --check (default): diff, exit 1 on drift
//   node scripts/pilot-detect-golden.mjs --write     # regenerate the committed goldens
//   ACME_MONOLITH_DIR=/path/to/consumer node scripts/pilot-detect-golden.mjs --check
//
// Exit codes: 0 = up to date, 1 = drift detected (--check), 2 = usage / not built.
// Requires a build first (imports the compiled detector): `pnpm build`.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const FIX = join(PKG, 'src', 'modules', 'environments', '__fixtures__', 'pilot')
const DIST = join(PKG, 'dist', 'modules', 'environments', 'provision-detect.logic.js')

const mode = process.argv.includes('--write') ? 'write' : 'check'

if (!existsSync(DIST)) {
  console.error(`Detector not built at ${DIST}\nRun: pnpm --filter @cat-factory/integrations build`)
  process.exit(2)
}

const { detectKubernetesProvisioning, detectSharedStack } = await import(pathToFileURL(DIST).href)

/** A `ProvisioningRepoReader` backed by a directory on disk (missing path ⇒ null / []). */
function fsReader(rootAbs) {
  return {
    async getFile(path) {
      try {
        return { content: readFileSync(join(rootAbs, path), 'utf-8') }
      } catch {
        return null
      }
    },
    async listDirectory(path) {
      let entries
      try {
        entries = readdirSync(join(rootAbs, path), { withFileTypes: true })
      } catch {
        return []
      }
      return entries.map((e) => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file',
        path: (path ? `${path}/` : '') + e.name,
      }))
    },
  }
}

function loadSanitizeMap() {
  const raw = process.env.PILOT_SANITIZE_MAP
  if (raw) return JSON.parse(raw)
  const local = join(HERE, 'pilot-sanitize.local.json')
  if (existsSync(local)) return JSON.parse(readFileSync(local, 'utf-8'))
  return []
}

function sanitize(str, map) {
  let out = str
  for (const { from, to } of map) out = out.split(from).join(to)
  return out
}

const sanitizeMap = loadSanitizeMap()

const targets = [
  {
    name: 'consumer-main',
    golden: 'consumer-main.detect.golden.json',
    liveEnv: 'ACME_MONOLITH_DIR',
    detect: (reader) => detectKubernetesProvisioning(reader, { prefer: 'docker-compose' }),
  },
  {
    name: 'shared-services',
    golden: 'shared-services.detect.golden.json',
    liveEnv: 'ACME_SHARED_SERVICES_DIR',
    detect: (reader) => detectSharedStack(reader, { repoName: 'acme-shared-services' }),
  },
]

// Refuse to REGENERATE goldens from a live clone with no sanitize map: that would write raw
// upstream names into the committed goldens, defeating "no upstream name is committed here".
// (The --check path only warns; --write is the committing action, so it hard-fails instead.)
if (mode === 'write' && sanitizeMap.length === 0) {
  const liveTargets = targets.filter((t) => process.env[t.liveEnv])
  if (liveTargets.length > 0) {
    console.error(
      `Refusing to --write goldens from a LIVE clone (${liveTargets.map((t) => t.liveEnv).join(', ')}) ` +
        'with no sanitize map — this would commit unsanitized upstream names. Set PILOT_SANITIZE_MAP ' +
        'or scripts/pilot-sanitize.local.json first, or regenerate from the committed fixtures ' +
        '(unset the live env var(s)).',
    )
    process.exit(2)
  }
}

let drift = 0
for (const target of targets) {
  const liveDir = process.env[target.liveEnv]
  const source = liveDir ? `live:${liveDir}` : 'fixtures'
  const dir = liveDir || join(FIX, target.name)
  const result = await target.detect(fsReader(dir))
  // Sanitize on the wire form, then parse back — so the comparison is on VALUES, immune to
  // JSON formatting (indent / trailing newline / oxfmt re-styling of the committed golden).
  const sanitized = JSON.parse(sanitize(JSON.stringify(result), sanitizeMap))
  const goldenPath = join(FIX, target.golden)

  if (mode === 'write') {
    writeFileSync(goldenPath, `${JSON.stringify(sanitized, null, 2)}\n`)
    console.log(`wrote  ${target.golden}  (source: ${source})`)
    continue
  }
  const golden = existsSync(goldenPath) ? JSON.parse(readFileSync(goldenPath, 'utf-8')) : null
  if (isDeepStrictEqual(sanitized, golden)) {
    console.log(`ok     ${target.golden}  (source: ${source})`)
  } else {
    drift++
    console.error(`DRIFT  ${target.golden}  (source: ${source})`)
    if (liveDir && sanitizeMap.length === 0) {
      console.error(
        '       (checking a LIVE clone with no sanitize map — set PILOT_SANITIZE_MAP or ' +
          'scripts/pilot-sanitize.local.json to translate upstream names to the fixture placeholders)',
      )
    }
  }
}

if (mode === 'check' && drift > 0) {
  console.error(
    `\n${drift} golden(s) drifted. If this is an intentional detector/fixture change, ` +
      'run with --write and commit; if it is upstream drift, update the fixtures to match.',
  )
  process.exit(1)
}
