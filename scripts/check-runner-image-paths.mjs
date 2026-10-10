#!/usr/bin/env node
// Requires every workflow that GATES on a runner image's sources to gate on the SAME list
// `scripts/runner-images.mjs` declares that image is built from.
//
// The rule it protects: `runner-images.mjs` exists to be the one place an image's sources are
// named, and both the tag guard and the tag sync already derive from it. The workflows did not:
// `docker-publish.yml` restated the executor list twice (once for the base image, once for the UI
// image that layers on it) and `ui-image-smoketest.yml` a third time, each by hand and each with
// nothing joining it to the descriptor. Every failure of that drift is SILENT in the direction
// that matters: a source directory added to a descriptor but not to a workflow makes the tag guard
// demand a version bump for a change the publisher then never publishes, and makes the PR-side
// smoketest skip a change that does reach the image.
//
// Usage:  node scripts/check-runner-image-paths.mjs
// Exit 0 = every gate matches its descriptor; exit 1 = one has drifted.

import { IMAGES, readRepoFile } from './runner-images.mjs'
import { diffGlobs, expectedGlobs, filterGlobs, triggerPaths } from './runner-image-paths.mjs'

/**
 * The publish workflow's per-image paths-filters. `extras` are the publishing MACHINERY: a change
 * to the workflow or its composite actions rebuilds every image regardless of sources, which is
 * deliberate and is not part of any descriptor.
 */
const PUBLISH = {
  file: '.github/workflows/docker-publish.yml',
  extras: ['.github/workflows/docker-publish.yml', '.github/actions/**'],
  /** paths-filter name → the `runner-images.mjs` descriptor label it gates. */
  filters: { executor: 'executor', executorUi: 'executor-ui', deploy: 'deploy' },
}

/**
 * The PR-side UI-image smoketest. `extras` are the smoketest's OWN scripts: they change what the
 * check does without changing what the image contains, so they belong to this gate and to no
 * descriptor.
 */
const SMOKETEST = {
  file: '.github/workflows/ui-image-smoketest.yml',
  label: 'executor-ui',
  extras: [
    'backend/internal/executor-harness/scripts/ui-image-checks.sh',
    'backend/internal/executor-harness/scripts/smoketest-ui-image.sh',
    '.github/workflows/ui-image-smoketest.yml',
  ],
}

const byLabel = new Map(IMAGES.map((image) => [image.label, image]))
const failures = []

function report(where, label, { missing, unexpected }) {
  for (const glob of missing) {
    failures.push(
      `${where} ignores '${glob}', which the '${label}' image IS built from ` +
        '(add it there, or drop it from the descriptor in scripts/runner-images.mjs)',
    )
  }
  for (const glob of unexpected) {
    failures.push(
      `${where} acts on '${glob}', which is neither a source of the '${label}' image nor a ` +
        'declared extra of that gate (add it to the descriptor, or to `extras` here with a reason)',
    )
  }
}

const filters = filterGlobs(readRepoFile(PUBLISH.file))
for (const [filterName, label] of Object.entries(PUBLISH.filters)) {
  const descriptor = byLabel.get(label)
  if (!descriptor) {
    failures.push(`scripts/runner-images.mjs declares no '${label}' image, which ${PUBLISH.file}'s
      \`${filterName}\` filter gates`)
    continue
  }
  const actual = filters[filterName]
  if (!actual) {
    failures.push(`${PUBLISH.file} declares no \`${filterName}\` paths-filter`)
    continue
  }
  report(`${PUBLISH.file}'s \`${filterName}\` filter`, label, {
    ...diffGlobs(actual, expectedGlobs(descriptor), PUBLISH.extras),
  })
}

const smoketestDescriptor = byLabel.get(SMOKETEST.label)
if (!smoketestDescriptor) {
  failures.push(`scripts/runner-images.mjs declares no '${SMOKETEST.label}' image`)
} else {
  report(`${SMOKETEST.file}'s pull_request \`paths\``, SMOKETEST.label, {
    ...diffGlobs(
      triggerPaths(readRepoFile(SMOKETEST.file)),
      expectedGlobs(smoketestDescriptor),
      SMOKETEST.extras,
    ),
  })
}

if (failures.length > 0) {
  console.error('check-runner-image-paths: a workflow no longer gates on the image it builds.\n')
  for (const failure of failures) console.error(`  - ${failure}`)
  console.error(
    '\nThe descriptors in scripts/runner-images.mjs are the single source of truth for what goes ' +
      'into each image; the workflows must gate on exactly that.',
  )
  process.exit(1)
}

console.log(
  `Runner image path gates OK (${Object.keys(PUBLISH.filters).length} publish filters + the UI smoketest).`,
)
