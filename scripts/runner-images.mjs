// Single source of truth for the per-run container image descriptors shared by
// scripts/check-runner-image-tag.mjs (the VERIFY side) and
// scripts/sync-runner-image-tags.mjs (the WRITE side). Declare an image or a pin
// location HERE ONCE — both the guard and the auto-sync derive from this list, so the
// two can no longer drift (a pin known to one script but not the other would reintroduce
// exactly the release-PR tag drift this machinery exists to prevent).

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The two deploy files every image is pinned in (the `image:publish*` script + the
// [[containers]] image). Named constants because both scripts reference them directly.
export const DEPLOY_PKG = 'deploy/backend/package.json'
export const WRANGLER = 'deploy/backend/wrangler.toml'

// One descriptor per per-run container image. `image` is the bare image name; the tag
// pin `<image>:<semver>` appears in DEPLOY_PKG + WRANGLER (verified for consistency by the
// guard) plus any `extraPins` (kept in step by the sync). `sourcePrefixes`/`sourceFiles`
// are the files whose content goes into that image; `scripts/check-runner-image-paths.mjs`
// holds every workflow that gates on an image (the docker-publish paths-filters and the PR-side
// UI smoketest) to exactly this list, so a source added here cannot leave a gate behind.
export const IMAGES = [
  {
    label: 'executor',
    image: 'cat-factory-executor',
    harnessPkg: 'backend/internal/executor-harness/package.json',
    // RECOMMENDED_HARNESS_IMAGE — the tag local mode pins + pulls at boot; must stay a
    // matched set with the backend (see CLAUDE.md → Releases & changesets). The sync writes it
    // and the guard verifies it, like every other pin below.
    extraPins: ['backend/runtimes/local/src/harnessImage.ts'],
    sourcePrefixes: ['backend/internal/executor-harness/src/'],
    sourceFiles: [
      'backend/internal/executor-harness/Dockerfile',
      // COPY'd into the image and run as its ENTRYPOINT, so it is image content exactly like the
      // Dockerfile: it was missing from this list, which meant a change to how the container boots
      // (the docker daemon start, the harness's own env) could republish over a live tag without
      // minting a version, and a deployment mirroring that tag would never roll it out.
      'backend/internal/executor-harness/entrypoint.sh',
      'backend/internal/executor-harness/tsconfig.json',
      'backend/internal/executor-harness/package.json',
    ],
  },
  {
    // The UI-tester image (Playwright + Chromium + WireMock, layered on the executor image).
    // It has NO package of its own: it is the same harness with extra tooling, so it is
    // versioned by the executor-harness package and rebuilt whenever that image is. That is why
    // its source list is the executor's PLUS `Dockerfile.ui`, and why a change to the base
    // Dockerfile bumps both tags together.
    label: 'executor-ui',
    image: 'cat-factory-executor-ui',
    harnessPkg: 'backend/internal/executor-harness/package.json',
    // RECOMMENDED_UI_HARNESS_IMAGE — the tag local mode dispatches an `image: 'ui'` job to.
    extraPins: ['backend/runtimes/local/src/harnessImage.ts'],
    sourcePrefixes: ['backend/internal/executor-harness/src/'],
    sourceFiles: [
      'backend/internal/executor-harness/Dockerfile',
      'backend/internal/executor-harness/Dockerfile.ui',
      'backend/internal/executor-harness/entrypoint.sh',
      'backend/internal/executor-harness/tsconfig.json',
      'backend/internal/executor-harness/package.json',
    ],
  },
  {
    label: 'deploy',
    image: 'cat-factory-deploy',
    harnessPkg: 'backend/internal/deploy-harness/package.json',
    // RECOMMENDED_DEPLOY_IMAGE — the tag local mode's `container` deploy runner defaults to (the
    // escape-hatch analogue of RECOMMENDED_HARNESS_IMAGE). Kept in step with the Worker's
    // wrangler.toml pin + the deploy-harness version so every facade resolves the SAME supported
    // deploy image.
    extraPins: ['backend/runtimes/local/src/deployImage.ts'],
    sourcePrefixes: ['backend/internal/deploy-harness/src/'],
    sourceFiles: [
      'backend/internal/deploy-harness/Dockerfile',
      'backend/internal/deploy-harness/tsconfig.json',
      'backend/internal/deploy-harness/package.json',
    ],
  },
]

export function readRepoFile(relPath) {
  return readFileSync(resolve(repoRoot, relPath), 'utf8')
}

/**
 * The `<image>:<semver>` pin pattern, capturing the `<image>:` prefix and the tag separately so
 * the same expression serves a read and a rewrite.
 *
 * Anchored on a DIGIT, which is what keeps a PLACEHOLDER ref out of the pin set: a doc comment's
 * `cat-factory-executor:<harness-version>` and an example's `:local` are not pins and must not be
 * rewritten or graded as drift. Stated here once because the guard that VERIFIES the pins and the
 * sync that WRITES them have to agree exactly about which refs are pins: one that recognised a pin
 * the other did not is the drift the pair exists to prevent.
 */
export function semverPinRe(image) {
  return new RegExp(`(${image}:)(\\d[^"'\\s]*)`, 'g')
}

/** Every semver pin of `image` in `text`, in the order they appear. */
export function semverPinsIn(image, text) {
  return [...text.matchAll(semverPinRe(image))].map((match) => match[2])
}
