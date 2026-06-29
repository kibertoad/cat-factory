#!/usr/bin/env node
// Guards the executor-harness runner image tag against the footgun that turns `main`
// red post-merge: the pinned tag is hand-maintained in THREE places that must stay in
// lockstep, and a change to the image sources that forgets to bump the tag means
// `wrangler deploy` republishes over the live tag without rolling out a new digest (new
// per-run containers then keep running stale code — see CLAUDE.md → Releases & changesets).
//
// Two checks:
//   1. Consistency (always): the harness `version` and the `cat-factory-executor:<tag>`
//      pins in deploy/backend/{package.json,wrangler.toml} are all equal.
//   2. Bump-vs-base (only with `--since <ref>`): if any image-source file changed in
//      `<ref>...HEAD`, the wrangler tag MUST differ from the tag at `<ref>`.
//
// Usage:
//   node scripts/check-runner-image-tag.mjs                 # consistency only
//   node scripts/check-runner-image-tag.mjs --since <ref>   # + bump-vs-base
//
// The deploy.yml guard runs the same logic post-merge; this lets PR CI catch it first.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const HARNESS_PKG = 'backend/internal/executor-harness/package.json'
const DEPLOY_PKG = 'deploy/backend/package.json'
const WRANGLER = 'deploy/backend/wrangler.toml'

// The set of files whose content goes into the runner image. Kept in sync with the
// `image:` paths-filter in .github/workflows/deploy.yml (the deploy-time guard).
const IMAGE_SOURCE_PREFIXES = ['backend/internal/executor-harness/src/']
const IMAGE_SOURCE_FILES = new Set([
  'backend/internal/executor-harness/Dockerfile',
  'backend/internal/executor-harness/tsconfig.json',
  'backend/internal/executor-harness/package.json',
])

// Matches the exact `extract()` regex used by deploy.yml: the tag is everything after
// `cat-factory-executor:` up to the first quote or whitespace.
const TAG_RE = /cat-factory-executor:([^"'\s]+)/

function fail(message) {
  console.error(`::error::${message}`)
  process.exitCode = 1
}

function readRepoFile(relPath) {
  return readFileSync(resolve(repoRoot, relPath), 'utf8')
}

function extractTag(relPath) {
  const match = TAG_RE.exec(readRepoFile(relPath))
  return match ? match[1] : null
}

function isImageSource(path) {
  return IMAGE_SOURCE_FILES.has(path) || IMAGE_SOURCE_PREFIXES.some((p) => path.startsWith(p))
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

function checkConsistency() {
  const harnessVersion = JSON.parse(readRepoFile(HARNESS_PKG)).version
  const deployTag = extractTag(DEPLOY_PKG)
  const wranglerTag = extractTag(WRANGLER)

  console.log(`harness version (${HARNESS_PKG}): ${harnessVersion ?? '<none>'}`)
  console.log(`deploy publish tag (${DEPLOY_PKG}): ${deployTag ?? '<none>'}`)
  console.log(`wrangler image tag (${WRANGLER}): ${wranglerTag ?? '<none>'}`)

  if (!harnessVersion) fail(`Could not read "version" from ${HARNESS_PKG}.`)
  if (!deployTag) fail(`Could not read the cat-factory-executor tag from ${DEPLOY_PKG}.`)
  if (!wranglerTag) fail(`Could not read the cat-factory-executor tag from ${WRANGLER}.`)
  if (!harnessVersion || !deployTag || !wranglerTag) return wranglerTag

  if (harnessVersion !== deployTag || harnessVersion !== wranglerTag) {
    fail(
      `Runner image tag drift: the harness version (${harnessVersion}), the ` +
        `deploy/backend/package.json image:publish tag (${deployTag}), and the ` +
        `deploy/backend/wrangler.toml [[containers]] image tag (${wranglerTag}) must all ` +
        `match. Bump every cat-factory-executor:<tag> to ${harnessVersion}.`,
    )
  }
  return wranglerTag
}

function checkBumpedSince(ref, currentTag) {
  let changed
  try {
    changed = git(['diff', '--name-only', `${ref}...HEAD`])
      .split('\n')
      .filter(Boolean)
  } catch {
    console.log(`::warning::Could not diff against ${ref}; skipping the bump-vs-base check.`)
    return
  }

  const touched = changed.filter(isImageSource)
  if (touched.length === 0) {
    console.log(`No runner image sources changed since ${ref}; bump-vs-base check skipped.`)
    return
  }
  console.log(`Runner image sources changed since ${ref}:\n  ${touched.join('\n  ')}`)

  let previousTag = null
  try {
    const match = TAG_RE.exec(git(['show', `${ref}:${WRANGLER}`]))
    previousTag = match ? match[1] : null
  } catch {
    console.log(`::warning::Could not read ${WRANGLER} at ${ref}; skipping the bump-vs-base check.`)
    return
  }

  console.log(`previously-pinned image tag: ${previousTag ?? '<none>'}`)
  console.log(`current image tag:           ${currentTag ?? '<none>'}`)

  if (previousTag && currentTag && previousTag === currentTag) {
    fail(
      `Runner image sources changed but the pinned tag (${currentTag}) was not bumped. ` +
        `Bump @cat-factory/executor-harness's version AND the matching ` +
        `cat-factory-executor:<tag> in BOTH deploy/backend/package.json (image:publish) ` +
        `AND deploy/backend/wrangler.toml ([[containers]] image), or wrangler will publish ` +
        `over the live tag without rolling out a new digest.`,
    )
  }
}

const since = parseSinceArg(process.argv.slice(2))
const currentTag = checkConsistency()
if (since && currentTag) checkBumpedSince(since, currentTag)

if (process.exitCode) {
  console.error('Runner image tag guard FAILED.')
} else {
  console.log('Runner image tag guard passed.')
}
