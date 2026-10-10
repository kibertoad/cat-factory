#!/usr/bin/env node
// Requires every layer component used in a Vue template to be imported by path.
//
// `frontend/app` sets no `components` config, so Nuxt's default `pathPrefix: true` applies and a
// component is registered under its PATH-PREFIXED name only: `components/panels/StepEffortReport.vue`
// becomes `PanelsStepEffortReport`, and a bare `<StepEffortReport>` matches nothing.
//
// The reason this is a guard and not a style note is that the failure is SILENT. An unresolved tag
// warns in dev and then renders nothing, so a built SPA just has a hole where the component should
// be. Nothing catches it: not typecheck (an unknown tag is not a type error), not the unit tests
// (they do not mount these panels), not the e2e suite (it asserts on the surfaces it drives, and a
// missing subsection has no test id to miss), and not the user, who reads it as a backend returning
// no data. Seven components had shipped this way when the guard was written, one of them dropping
// the per-standard adherence ratings from every finished PR review.
//
// Pure node, no install, no `.nuxt` build: registration is derived from the file's own path, so the
// guard runs in the always-on `repo-guards` CI job like its neighbours. Detection lives in
// `component-imports.mjs` with fixtures in `component-imports.test.mjs`, run by
// `node --test 'scripts/*.test.mjs'`.
//
// Usage:  node scripts/check-component-imports.mjs
// Exit 0 = clean; exit 1 = at least one tag that will render nothing.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findUnresolvedComponents, registeredComponentName } from './component-imports.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Scanned roots: each is a `components/` dir Nuxt auto-registers from. Only `frontend/app` today;
 * a second Nuxt layer or a consumer app in this repo would add its own row.
 */
const COMPONENT_ROOTS = ['frontend/app/app/components']

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.nuxt',
  '.output',
  '.turbo',
  'coverage',
  '.stryker-tmp',
])

function* vueFiles(dirAbs) {
  for (const entry of readdirSync(dirAbs)) {
    const abs = join(dirAbs, entry)
    let stat
    try {
      stat = statSync(abs)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue
      yield* vueFiles(abs)
    } else if (entry.endsWith('.vue')) {
      yield abs
    }
  }
}

/** Index every component by basename, and record which ones Nuxt registers bare. */
function indexComponents(rootAbs) {
  const layerComponents = new Map()
  const bareRegistered = new Set()
  const files = [...vueFiles(rootAbs)]
  for (const abs of files) {
    const rel = relative(rootAbs, abs).replaceAll('\\', '/')
    const basename = rel.slice(rel.lastIndexOf('/') + 1, -'.vue'.length)
    if (!layerComponents.has(basename)) layerComponents.set(basename, new Set())
    layerComponents.get(basename).add(relative(repoRoot, abs).replaceAll('\\', '/'))
    // The bare tag resolves only when Nuxt's derived name IS the basename: either the component
    // sits directly in `components/` (empty prefix), or every prefix segment was deduplicated
    // because the filename already repeats it (`pipeline/PipelinePicker.vue`).
    if (registeredComponentName(rel) === basename) bareRegistered.add(basename)
  }
  return { layerComponents, bareRegistered, files }
}

const failures = []

for (const root of COMPONENT_ROOTS) {
  const rootAbs = join(repoRoot, root)
  const { layerComponents, bareRegistered, files } = indexComponents(rootAbs)
  for (const abs of files) {
    const source = readFileSync(abs, 'utf8')
    const rel = relative(repoRoot, abs).replaceAll('\\', '/')
    for (const { tag, definedAt } of findUnresolvedComponents(source, {
      layerComponents,
      bareRegistered,
    })) {
      failures.push({ rel, tag, definedAt })
    }
  }
}

if (failures.length > 0) {
  console.error('Layer components used without an import (each renders NOTHING):\n')
  for (const { rel, tag, definedAt } of failures) {
    console.error(`  - ${rel}: <${tag}>`)
    for (const path of definedAt) console.error(`      defined at ${path}`)
  }
  console.error('\nAdd an explicit import to the SFC, e.g.:')
  console.error("  import StepEffortReport from '~/components/panels/StepEffortReport.vue'")
  console.error('\nNuxt registers a layer component under its path-prefixed name only')
  console.error('(`PanelsStepEffortReport`), so the bare tag resolves to nothing and the')
  console.error('surface renders empty with no error. See frontend/app/README.md.')
  process.exit(1)
}

console.log('Every layer component used in a template is imported.')
