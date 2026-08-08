#!/usr/bin/env node
// Fails when a doc URL built in code names a markdown file or a section heading that is not there.
//
// Why this needs a guard rather than care: these URLs go into operator-facing error messages and
// boot warnings, so the reader who follows a stale one is already stuck, and nothing else can see
// the coupling. It is a string in `config/docs.ts` and a heading in a `.md` file, joined by nothing;
// the full account, and what this deliberately does NOT check, is in `doc-anchors.mjs`.
//
// Usage:  node scripts/check-doc-anchors.mjs
// Exit 0 = clean; exit 1 = at least one doc URL cannot be followed.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  brokenDocAnchors,
  docsReferences,
  parseBlobTemplatePaths,
  parseDirectDocUrlCalls,
  parseDocsMap,
  parseEnvVarAnchors,
} from './doc-anchors.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DOCS_MODULE = 'backend/packages/server/src/config/docs.ts'
const VCS_ERRORS_MODULE = 'backend/packages/kernel/src/domain/vcs-errors.ts'
const SKIP_DIRS = new Set(['node_modules', 'dist', '.nuxt', '.output', 'coverage'])

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else yield full
  }
}

const read = (path) => readFileSync(join(repoRoot, path), 'utf8')
const readDoc = (path) => {
  try {
    const full = join(repoRoot, path)
    return statSync(full).isFile() ? readFileSync(full, 'utf8') : null
  } catch {
    return null
  }
}

const docsSource = read(DOCS_MODULE)
const docsMap = parseDocsMap(docsSource)
const envAnchors = parseEnvVarAnchors(docsSource)

if (docsMap.size === 0 || envAnchors.size === 0) {
  // A guard that silently stops matching reports green forever, which is worse than a false alarm.
  console.error(
    `check-doc-anchors: read no DOCS entries (${docsMap.size}) or no ENV_VARS_ANCHORS ` +
      `(${envAnchors.size}) from ${DOCS_MODULE}. The declarations moved or changed shape; ` +
      'update `parseDocsMap` / `parseEnvVarAnchors` in scripts/doc-anchors.mjs to follow them.',
  )
  process.exit(1)
}

// Every DOCS entry's own target, whether or not anything calls it yet.
const references = [...docsMap.entries()].map(([key, path]) => ({
  key,
  path,
  anchor: null,
  call: `DOCS.${key}`,
  where: DOCS_MODULE,
}))
// The paths kernel spells out itself, since it sits below the server layer and keeps its own copy.
for (const path of parseBlobTemplatePaths(read(VCS_ERRORS_MODULE))) {
  references.push({ key: path, path, anchor: null, call: path, where: VCS_ERRORS_MODULE })
}
// Every anchored call site, plus every module that spells a URL out directly (the agents package
// keeps its own `repoDocUrl`, since it sits below the server layer and cannot import that module).
for (const file of walk(join(repoRoot, 'backend'))) {
  if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue
  const rel = relative(repoRoot, file).split('\\').join('/')
  const source = readFileSync(file, 'utf8')
  for (const ref of parseDirectDocUrlCalls(source)) references.push({ ...ref, where: rel })
  if (rel === DOCS_MODULE || !source.includes('DOCS.')) continue
  for (const ref of docsReferences(source, docsMap, envAnchors)) {
    references.push({ ...ref, where: rel })
  }
}

const broken = brokenDocAnchors(references, readDoc)

if (broken.length === 0) {
  console.log(
    `check-doc-anchors: all ${references.length} code-built doc URLs resolve to a file and a heading.`,
  )
  process.exit(0)
}

console.error('An error message points at documentation that is not there:\n')
for (const { where, call, path, reason } of broken) {
  console.error(`  ${where}\n      ${call} → ${path}: ${reason}`)
}
console.error(
  '\nRestore the heading, or move the remedy to whatever now owns that instruction (`SITE_DOCS` ' +
    'when the website took over a setup step). Repointing at the top of the page is not a fix: the ' +
    'reader following one of these is mid-failure and needs the section, not the document.',
)
process.exit(1)
