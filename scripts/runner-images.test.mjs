// Fixtures for the shared runner-image pin pattern. Run by `node --test 'scripts/*.test.mjs'`.
//
// The pattern is the one thing the tag GUARD and the tag SYNC both read a pin through, so a
// mismatch between them is unrepresentable, but only as long as the pattern itself matches what a
// pin actually looks like. A pattern that stopped matching would make the guard collect an empty
// pin set and the sync rewrite nothing, and both would report green while a facade's constant sat a
// release behind. That is the failure this file pins, in both directions.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { DEPLOY_PKG, IMAGES, readRepoFile, semverPinsIn, WRANGLER } from './runner-images.mjs'

test('collects every semver pin in a file, and no placeholder ref', () => {
  // The real shape of the facade-side pin file: two live pins plus the two placeholder refs its
  // doc comments carry. Reading a placeholder as a pin would grade an unbumpable comment as drift;
  // missing a live pin is how the drift ships.
  const source = `
// published as \`ghcr.io/o/cat-factory-executor:<harness-version>\` and \`:latest\`
export const RECOMMENDED_HARNESS_IMAGE = 'ghcr.io/o/cat-factory-executor:1.125.0'
export const RECOMMENDED_UI_HARNESS_IMAGE = 'ghcr.io/o/cat-factory-executor-ui:1.125.0'
// a locally-built tag (e.g. \`cat-factory-executor:local\`): nothing to pull
`
  assert.deepEqual(semverPinsIn('cat-factory-executor', source), ['1.125.0'])
  assert.deepEqual(semverPinsIn('cat-factory-executor-ui', source), ['1.125.0'])
})

test('does not read the base image pin out of the -ui image ref', () => {
  // The two images share a name prefix and are pinned in ONE file, so a pattern that matched the
  // base name inside `cat-factory-executor-ui:` would grade the UI pin as the base image's and let
  // a genuine disagreement between them pass.
  const uiOnly = `image = "registry/cat-factory-executor-ui:1.125.0"`
  assert.deepEqual(semverPinsIn('cat-factory-executor', uiOnly), [])
  assert.deepEqual(semverPinsIn('cat-factory-executor-ui', uiOnly), ['1.125.0'])
})

test('reports a drifted pin beside the pin it disagrees with', () => {
  // What the guard compares: several pins of one image across the descriptor's files, folded into
  // one set. The guard's own consistency check is against the harness version, so what matters
  // here is that a second, differing pin in the same file is SEEN rather than shadowed by the first.
  const drifted = `
export const A = 'ghcr.io/o/cat-factory-executor:1.125.0'
export const B = 'ghcr.io/o/cat-factory-executor:1.124.0'
`
  assert.deepEqual(semverPinsIn('cat-factory-executor', drifted), ['1.125.0', '1.124.0'])
})

test('finds a pin for every image in every file the descriptors name', () => {
  // Derived from the descriptor list rather than restated, so an image or a pin location added
  // there is covered with no edit here. This is the assertion the guard's own green run could not
  // make before: it read the deploy pair only, so a facade-side pin that stopped matching (renamed
  // constant, moved file, reformatted ref) went on passing while the pin drifted.
  for (const image of IMAGES) {
    for (const relPath of [DEPLOY_PKG, WRANGLER, ...(image.extraPins ?? [])]) {
      assert.ok(
        semverPinsIn(image.image, readRepoFile(relPath)).length > 0,
        `${image.label}: no ${image.image}:<version> pin found in ${relPath}`,
      )
    }
  }
})
