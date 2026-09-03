// Fixtures for the files-payload half of the publish-integrity guard. Run by
// `node --test 'scripts/*.test.mjs'`.
//
// The case that motivates all of this is `@cat-factory/app`: a package whose `main` resolves fine
// while the two directories that ARE the package (`app/`, `i18n/`) are absent, which is what its
// `1.0.0` shipped. So the fixtures are real trees on disk rather than a stubbed `fs`: the property
// under test is what a directory probe concludes, and injecting a fake filesystem would test the
// injection instead.

import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  findMissingPayload,
  payloadEntryProblem,
  resolvablePayloadEntries,
} from './publish-payload.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Builds a throwaway package directory; `tree` maps a relative path to its contents. */
function fixturePackage(t, tree) {
  const dir = mkdtempSync(join(tmpdir(), 'cat-factory-publish-payload-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const [rel, contents] of Object.entries(tree)) {
    const abs = join(dir, rel)
    if (contents === null) {
      mkdirSync(abs, { recursive: true })
      continue
    }
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, contents)
  }
  return dir
}

test('a declared directory that does not exist fails', (t) => {
  // The @cat-factory/app shape: `main` resolves, the payload does not.
  const dir = fixturePackage(t, { 'nuxt.config.ts': 'export default {}\n' })
  assert.deepEqual(findMissingPayload(dir, { files: ['app', 'i18n', 'nuxt.config.ts'] }), [
    { entry: 'app', why: 'does not exist' },
    { entry: 'i18n', why: 'does not exist' },
  ])
})

test('a populated declared directory passes', (t) => {
  const dir = fixturePackage(t, {
    'app/app.vue': '<template />\n',
    'i18n/locales/en.json': '{}\n',
    'nuxt.config.ts': 'export default {}\n',
  })
  assert.deepEqual(findMissingPayload(dir, { files: ['app', 'i18n', 'nuxt.config.ts'] }), [])
})

test('a directory holding nothing but empty subdirectories fails', (t) => {
  // Shallow "does it have entries" would call this populated, and npm would pack no file from it.
  const dir = fixturePackage(t, { 'dist/chunks': null })
  assert.deepEqual(findMissingPayload(dir, { files: ['dist'] }), [
    { entry: 'dist', why: 'contains no files' },
  ])
})

test('a declared file that is present but 0 bytes fails, agreeing with the entry-point rule', (t) => {
  const dir = fixturePackage(t, { 'nuxt.config.ts': '' })
  assert.deepEqual(findMissingPayload(dir, { files: ['nuxt.config.ts'] }), [
    { entry: 'nuxt.config.ts', why: 'is empty (0 bytes)' },
  ])
})

test('negations and globs are skipped rather than resolved', () => {
  // `!dist/.tsbuildinfo` subtracts from the payload, and a glob's expansion is npm's business;
  // resolving either as a literal path would fail every package that used one.
  assert.deepEqual(
    resolvablePayloadEntries(['dist', '!dist/.tsbuildinfo', 'app/**/*.vue', 'migrations']),
    ['dist', 'migrations'],
  )
})

test('a missing negated or globbed path cannot fail the guard', (t) => {
  const dir = fixturePackage(t, { 'dist/index.js': 'export {}\n' })
  assert.deepEqual(
    findMissingPayload(dir, { files: ['dist', '!dist/.tsbuildinfo', 'nothing/*.json'] }),
    [],
  )
})

test('leading ./ and trailing / normalise to one entry', () => {
  assert.deepEqual(resolvablePayloadEntries(['./dist/', 'dist', './dist']), ['dist'])
})

test('a package with no files list has nothing to check', (t) => {
  const dir = fixturePackage(t, { 'dist/index.js': 'export {}\n' })
  assert.deepEqual(resolvablePayloadEntries(undefined), [])
  assert.deepEqual(findMissingPayload(dir, {}), [])
})

test('README.md and LICENSE are npm implicit, so their absence is not a payload problem', (t) => {
  // They ship whatever `files` says, which is why no package lists them and none may be made to.
  const dir = fixturePackage(t, { 'dist/index.js': 'export {}\n' })
  assert.equal(payloadEntryProblem(join(dir, 'README.md')), 'does not exist')
  assert.deepEqual(findMissingPayload(dir, { files: ['dist'] }), [])
})

test("frontend/app's declared payload is present in the tree, so the guard passes on a checkout", () => {
  // The guard's own acceptance, on the one package this assertion exists for. It publishes
  // source, so it needs no build: a failure here means a `files` entry outlived its directory.
  const relDir = 'frontend/app'
  const pkgDir = resolve(repoRoot, relDir)
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  assert.deepEqual(findMissingPayload(pkgDir, pkg), [])
})
