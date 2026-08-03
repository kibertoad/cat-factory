// Generate the four public-API SDK clients (TypeScript, Python, Go, Java) from
// `docs/openapi.json`, and write them into `sdk/<language>/`.
//
// The chain is contracts → spec → SDKs, with no hand-editing at any link: the Valibot route
// contracts are the source of truth, `scripts/generate-openapi.mjs` renders them to the spec,
// and this renders the spec to four clients. Twinned with `scripts/check-sdks.mjs` (the CI drift
// guard), exactly like `gen:openapi` ⇄ `check:openapi`.
//
// What is generated is deliberately narrow — the wire MODELS and the operation methods. Each
// SDK's transport, error hierarchy, retry policy, pagination helper and SSE reader are
// hand-written and live beside the generated files. That split is what keeps a contract change
// from rewriting behaviour, and a behaviour fix from having to be re-applied across 38
// operations × 4 languages.
//
// Prereqs: `docs/openapi.json` must be current (`pnpm build && pnpm gen:openapi`).
//
// Usage:  node scripts/generate-sdks.mjs

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildIr } from './sdk/ir.mjs'
import { placeOperations } from './sdk/surface.mjs'
import * as typescript from './sdk/emit-typescript.mjs'
import * as python from './sdk/emit-python.mjs'
import * as go from './sdk/emit-go.mjs'
import * as java from './sdk/emit-java.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SDK_ROOT = resolve(repoRoot, 'sdk')

/**
 * The emitters, each returning `{ '<path relative to its sdk dir>': '<file contents>' }`.
 *
 * `generatedDirs` names the directories this generator OWNS completely: they are wiped before a
 * write, so a type that stops existing in the spec stops existing in the SDK. A hand-written
 * file must therefore never live in one — which is why every SDK keeps its runtime beside, not
 * inside, its generated tree.
 */
// TypeScript, Python and Go each emit a FIXED set of files (`*.generated.ts`, `models.py`,
// `models_gen.go`), so a dropped type simply disappears from a file that is rewritten whole and
// there is nothing to sweep. Java emits one file per type, so it owns whole directories instead.
const EMITTERS = [
  { dir: 'typescript', emit: typescript.emit, generatedDirs: [] },
  { dir: 'python', emit: python.emit, generatedDirs: [] },
  { dir: 'go', emit: go.emit, generatedDirs: [] },
  { dir: 'java', emit: java.emit, generatedDirs: java.GENERATED_DIRS },
]

/** Build every SDK's generated files, keyed by repo-relative path. */
export async function buildSdkFiles(doc) {
  const ir = await buildIr(doc)
  const placed = placeOperations(ir)
  const files = new Map()
  for (const { dir, emit } of EMITTERS) {
    for (const [rel, contents] of Object.entries(emit(ir, placed))) {
      files.set(`sdk/${dir}/${rel}`, contents)
    }
  }
  return files
}

/** Every file currently inside a generator-owned directory, repo-relative. */
async function existingGeneratedFiles() {
  const found = []
  for (const { dir, generatedDirs } of EMITTERS) {
    for (const generated of generatedDirs) {
      const abs = join(SDK_ROOT, dir, generated)
      let entries
      try {
        entries = await readdir(abs, { recursive: true, withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue
        found.push(
          relative(repoRoot, join(entry.parentPath ?? abs, entry.name)).replaceAll('\\', '/'),
        )
      }
    }
  }
  return found
}

/**
 * Files inside a generator-owned directory that the emitters no longer produce — a model the spec
 * dropped. Removed on a write and REPORTED by the drift guard, because a stale generated type
 * still compiles and still ships.
 */
export async function findStaleGeneratedFiles(files) {
  const existing = await existingGeneratedFiles()
  return existing.filter((rel) => !files.has(rel))
}

async function main() {
  const files = await buildSdkFiles()
  const stale = await findStaleGeneratedFiles(files)

  for (const rel of stale) await rm(resolve(repoRoot, rel))
  for (const [rel, contents] of files) {
    const abs = resolve(repoRoot, rel)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, contents, 'utf8')
  }
  console.log(
    `Wrote ${files.size} generated SDK files across ${EMITTERS.length} languages` +
      (stale.length ? `, removed ${stale.length} stale` : '') +
      '.',
  )
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
