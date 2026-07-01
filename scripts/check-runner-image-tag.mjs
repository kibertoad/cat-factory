#!/usr/bin/env node
// Guards the per-run container image tags against the footgun that turns `main` red
// post-merge: each pinned tag is hand-maintained in THREE places that must stay in
// lockstep, and a change to the image sources that forgets to bump the tag means
// `wrangler deploy` republishes over the live tag without rolling out a new digest (new
// per-run containers then keep running stale code — see CLAUDE.md → Releases & changesets).
//
// Two container images are covered, each with its own harness package + registry tag:
//   - executor (the Pi coding-agent image): @cat-factory/executor-harness ⇄ cat-factory-executor:<tag>
//   - deploy   (the k8s render image):       @cat-factory/deploy-harness   ⇄ cat-factory-deploy:<tag>
//
// For EACH image, two checks:
//   1. Consistency (always): the harness `version` and the `<image>:<tag>` pins in
//      deploy/backend/{package.json,wrangler.toml} are all equal.
//   2. Bump-vs-base (only with `--since <ref>`): if any of that image's source files
//      changed in `<ref>...HEAD`, the wrangler tag MUST differ from the tag at `<ref>`.
//
// Usage:
//   node scripts/check-runner-image-tag.mjs                 # consistency only
//   node scripts/check-runner-image-tag.mjs --since <ref>   # + bump-vs-base
//
// The deploy.yml guard runs the same logic post-merge; this lets PR CI catch it first.

import { execFileSync } from 'node:child_process'
import {
  DEPLOY_PKG,
  IMAGES as IMAGE_DESCRIPTORS,
  readRepoFile,
  repoRoot,
  WRANGLER,
} from './runner-images.mjs'

// Adapt the shared descriptors (scripts/runner-images.mjs — the single source of truth this
// and the auto-sync both derive from) to what the guard needs: a `tagRe` that matches the
// `<image>:<tag>` ref in DEPLOY_PKG + WRANGLER (capturing the tag up to the first quote or
// whitespace) and the source files as a Set for fast membership tests.
const IMAGES = IMAGE_DESCRIPTORS.map((d) => ({
  label: d.label,
  harnessPkg: d.harnessPkg,
  tagRe: new RegExp(`${d.image}:([^"'\\s]+)`),
  sourcePrefixes: d.sourcePrefixes,
  sourceFiles: new Set(d.sourceFiles),
}))

function fail(message) {
  console.error(`::error::${message}`)
  process.exitCode = 1
}

function extractTag(tagRe, relPath) {
  const match = tagRe.exec(readRepoFile(relPath))
  return match ? match[1] : null
}

function isImageSource(image, path) {
  return image.sourceFiles.has(path) || image.sourcePrefixes.some((p) => path.startsWith(p))
}

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
}

function parseSinceArg(argv) {
  const idx = argv.indexOf('--since')
  if (idx === -1) return null
  const ref = argv[idx + 1]
  // An empty ref (e.g. `github.base_ref` on a push/dispatch event) means "no base" —
  // run the consistency check only, which is the correct behaviour off-PR.
  return ref && ref.trim() !== '' ? ref.trim() : null
}

function checkConsistency(image) {
  const harnessVersion = JSON.parse(readRepoFile(image.harnessPkg)).version
  const deployTag = extractTag(image.tagRe, DEPLOY_PKG)
  const wranglerTag = extractTag(image.tagRe, WRANGLER)

  console.log(
    `[${image.label}] harness version (${image.harnessPkg}): ${harnessVersion ?? '<none>'}`,
  )
  console.log(`[${image.label}] deploy publish tag (${DEPLOY_PKG}): ${deployTag ?? '<none>'}`)
  console.log(`[${image.label}] wrangler image tag (${WRANGLER}): ${wranglerTag ?? '<none>'}`)

  if (!harnessVersion) fail(`[${image.label}] Could not read "version" from ${image.harnessPkg}.`)
  if (!deployTag)
    fail(`[${image.label}] Could not read the ${image.label} image tag from ${DEPLOY_PKG}.`)
  if (!wranglerTag)
    fail(`[${image.label}] Could not read the ${image.label} image tag from ${WRANGLER}.`)
  if (!harnessVersion || !deployTag || !wranglerTag) return wranglerTag

  if (harnessVersion !== deployTag || harnessVersion !== wranglerTag) {
    fail(
      `[${image.label}] image tag drift: the harness version (${harnessVersion}), the ` +
        `deploy/backend/package.json publish tag (${deployTag}), and the ` +
        `deploy/backend/wrangler.toml [[containers]] image tag (${wranglerTag}) must all ` +
        `match. Bump every ${image.label} image tag to ${harnessVersion}.`,
    )
  }
  return wranglerTag
}

function checkBumpedSince(image, ref, currentTag) {
  let changed
  try {
    changed = git(['diff', '--name-only', `${ref}...HEAD`])
      .split('\n')
      .filter(Boolean)
  } catch {
    console.log(
      `::warning::[${image.label}] Could not diff against ${ref}; skipping the bump-vs-base check.`,
    )
    return
  }

  const touched = changed.filter((p) => isImageSource(image, p))
  if (touched.length === 0) {
    console.log(
      `[${image.label}] No image sources changed since ${ref}; bump-vs-base check skipped.`,
    )
    return
  }
  console.log(`[${image.label}] image sources changed since ${ref}:\n  ${touched.join('\n  ')}`)

  let previousTag = null
  try {
    const match = image.tagRe.exec(git(['show', `${ref}:${WRANGLER}`]))
    previousTag = match ? match[1] : null
  } catch {
    console.log(
      `::warning::[${image.label}] Could not read ${WRANGLER} at ${ref}; skipping the bump-vs-base check.`,
    )
    return
  }

  console.log(`[${image.label}] previously-pinned image tag: ${previousTag ?? '<none>'}`)
  console.log(`[${image.label}] current image tag:           ${currentTag ?? '<none>'}`)

  if (previousTag && currentTag && previousTag === currentTag) {
    fail(
      `[${image.label}] image sources changed but the pinned tag (${currentTag}) was not bumped. ` +
        `Bump the harness version AND the matching ${image.label} image tag in BOTH ` +
        `deploy/backend/package.json (the image:publish* script) AND deploy/backend/wrangler.toml ` +
        `([[containers]] image), or wrangler will publish over the live tag without rolling out a ` +
        `new digest.`,
    )
  }
}

const since = parseSinceArg(process.argv.slice(2))
for (const image of IMAGES) {
  const currentTag = checkConsistency(image)
  if (since && currentTag) checkBumpedSince(image, since, currentTag)
}

if (process.exitCode) {
  console.error('Container image tag guard FAILED.')
} else {
  console.log('Container image tag guard passed.')
}
