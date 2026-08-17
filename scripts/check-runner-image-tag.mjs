#!/usr/bin/env node
// Guards the per-run container image tags: each pinned tag is hand-maintained in several
// places that must stay in lockstep, and a change to the image sources that forgets to
// bump the tag would republish over the live tag without minting a new version, so a
// deployment mirroring that tag never rolls out the change (its per-run containers keep
// running stale code; see CLAUDE.md, Releases & changesets).
//
// Two container images are covered, each with its own harness package + registry tag:
//   - executor (the Pi coding-agent image): @cat-factory/executor-harness ⇄ cat-factory-executor:<tag>
//   - deploy   (the k8s render image):       @cat-factory/deploy-harness   ⇄ cat-factory-deploy:<tag>
//
// For EACH image, two checks:
//   1. Consistency (always): the harness `version` and EVERY `<image>:<semver>` pin in the
//      descriptor's pin files are all equal. That is deploy/backend/{package.json,wrangler.toml}
//      plus the descriptor's `extraPins`, the facade-side constants (local mode's
//      RECOMMENDED_HARNESS_IMAGE and friends). Reading only the deploy pair is what let a
//      release ship with the local facade a version behind: the effective default image then
//      runs a harness that ignores whatever job-body field the release renamed, and every
//      value in it silently vanishes from the agent's env. The auto-sync writes all of them,
//      so this verifies all of them.
//   2. Bump-vs-base (only with `--since <ref>`): if any of that image's source files
//      changed in `<ref>...HEAD`, the wrangler tag MUST differ from the tag at `<ref>`.
//
// Usage:
//   node scripts/check-runner-image-tag.mjs                 # consistency only
//   node scripts/check-runner-image-tag.mjs --since <ref>   # + bump-vs-base
//
// This repo publishes the images but operates no deployment of its own; the pins are what a
// deployment reads as the supported tag. PR CI (repo-guards) is the primary enforcement, and
// docker-publish.yml re-runs the guard against the pushed range before any tag is pushed, so
// a direct-to-main change cannot silently republish over a live tag either.

import { execFileSync } from 'node:child_process'
import {
  DEPLOY_PKG,
  IMAGES as IMAGE_DESCRIPTORS,
  readRepoFile,
  repoRoot,
  semverPinsIn,
  WRANGLER,
} from './runner-images.mjs'

// Adapt the shared descriptors (scripts/runner-images.mjs — the single source of truth this
// and the auto-sync both derive from) to what the guard needs: the files a tag is pinned in,
// a `tagRe` that matches the `<image>:<tag>` ref in one of them (capturing the tag up to the
// first quote or whitespace), and the source files as a Set for fast membership tests.
const IMAGES = IMAGE_DESCRIPTORS.map((d) => ({
  label: d.label,
  image: d.image,
  harnessPkg: d.harnessPkg,
  // Every file carrying a pin, deploy pair first: the wrangler tag is the one the bump-vs-base
  // check compares across revisions, and the first two are named in the drift message.
  pinFiles: [DEPLOY_PKG, WRANGLER, ...(d.extraPins ?? [])],
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

/** Every semver-tagged pin of one image in one file, in the order they appear. */
function pinnedTags(image, relPath) {
  return semverPinsIn(image.image, readRepoFile(relPath))
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
  const wranglerTag = extractTag(image.tagRe, WRANGLER)

  console.log(
    `[${image.label}] harness version (${image.harnessPkg}): ${harnessVersion ?? '<none>'}`,
  )
  if (!harnessVersion) fail(`[${image.label}] Could not read "version" from ${image.harnessPkg}.`)

  // Every pin file, not just the deploy pair. A file the descriptor names but that carries no
  // semver pin is a fault of its own: the pin was renamed or moved, and a guard that treated the
  // absence as "nothing to check" would go on passing while the constant drifted.
  const drifted = []
  for (const relPath of image.pinFiles) {
    const tags = pinnedTags(image, relPath)
    console.log(`[${image.label}] pinned in ${relPath}: ${tags.join(', ') || '<none>'}`)
    if (tags.length === 0) {
      fail(
        `[${image.label}] Could not read a ${image.image}:<version> pin from ${relPath}. ` +
          `scripts/runner-images.mjs names it as a pin location, so either the pin moved (update ` +
          `the descriptor) or it was dropped (restore it).`,
      )
      continue
    }
    if (harnessVersion && tags.some((tag) => tag !== harnessVersion)) drifted.push(relPath)
  }

  if (drifted.length > 0) {
    fail(
      `[${image.label}] image tag drift: the harness version is ${harnessVersion}, but ` +
        `${drifted.join(', ')} pin${drifted.length === 1 ? 's' : ''} a different ${image.image} ` +
        `tag. Every pin must name the published tag, or a facade defaulting to the stale one runs ` +
        `a harness this build was not released against. Run \`node scripts/sync-runner-image-tags.mjs\` ` +
        `to bring them all to ${harnessVersion}.`,
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
