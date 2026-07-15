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
// are the files whose content goes into that image — kept in sync with the `image*`
// paths-filters in .github/workflows/deploy.yml.
export const IMAGES = [
  {
    label: 'executor',
    image: 'cat-factory-executor',
    harnessPkg: 'backend/internal/executor-harness/package.json',
    // RECOMMENDED_HARNESS_IMAGE — the tag local mode pins + pulls at boot; must stay a
    // matched set with the backend (see CLAUDE.md → Releases & changesets). The guard only
    // verifies DEPLOY_PKG/WRANGLER, but the sync keeps this in step too.
    extraPins: ['backend/runtimes/local/src/harnessImage.ts'],
    sourcePrefixes: ['backend/internal/executor-harness/src/'],
    sourceFiles: [
      'backend/internal/executor-harness/Dockerfile',
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
    // deploy image. The guard only verifies DEPLOY_PKG/WRANGLER, but the sync keeps this in step too.
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
