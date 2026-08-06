// The detection half of the shipped-doc link guard (the CI entry point is
// `check-shipped-doc-links.mjs`; the fixtures are `shipped-doc-links.test.mjs`).
//
// The rule: a markdown document that SHIPS inside a published tarball may not carry a relative
// link that escapes its own package root. Such a link resolves inside the repo and is dead
// everywhere else, so the reader who most needs it (a consumer who installed the package and has
// no checkout) is precisely the one it fails for.
//
// This was found the expensive way. `@cat-factory/app` ships `app/`, which contains
// `app/docs/consumer-extensions.md`, whose pointer at the reusable-operations reference doc was
// `../../../../backend/docs/reusable-operations.md`. Four levels up leaves the tarball. An org
// building a proprietary operation against the published packages could not read the one document
// that answers most of what they then filed as gaps.
//
// An ABSOLUTE URL is the fix, not a shorter relative path: the material lives in the repo, the
// repo is public, and a link that works from both a checkout and a tarball is one that names the
// canonical location rather than a position relative to the reader.
//
// Which is why this guard checks BOTH halves. Converting a relative link to an absolute one is
// mechanical, and a mechanical conversion carries the original's mistakes across intact: the four
// links this file's own motivating document gained pointed at `frontend/backend/...` and
// `frontend/docs/...`, because the relative paths they were built from were already one level
// short. Checking only the relative half would have called that document clean forever, having
// swapped a link that resolves from a checkout for one that resolves from nowhere at all. A
// repo-absolute link is checkable against the working tree, so it is checked: the path must exist,
// and `blob` (a file) must not name a directory `tree` describes.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix, relative, resolve, sep } from 'node:path'

/**
 * Markdown inline links and reference definitions: `](target)` and `[label]: target`.
 * Deliberately not a markdown parser: this needs only the target, and a link inside a fenced code
 * block is still a link a reader will try to follow.
 */
const LINK_RE = /\]\(\s*(<[^>]*>|[^)\s]+)/g
const REF_DEF_RE = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/gm

/** Every link target in a markdown document, in source order. */
export function linkTargets(markdown) {
  const targets = []
  for (const match of markdown.matchAll(LINK_RE)) {
    targets.push(match[1].replace(/^<|>$/g, ''))
  }
  for (const match of markdown.matchAll(REF_DEF_RE)) targets.push(match[1])
  return targets
}

/**
 * Whether a link target is a RELATIVE path this guard should resolve.
 *
 * Excluded: absolute URLs (the fix), root-relative paths (a served route, not a file), bare
 * fragments and `mailto:`. A protocol-relative `//host/path` is a URL too.
 */
export function isRelativePath(target) {
  if (!target) return false
  if (target.startsWith('#')) return false
  if (target.startsWith('/')) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false
  return true
}

/**
 * The link targets in `markdown` that escape `packageRoot` when resolved from `docPath`.
 *
 * Both paths are given relative to the same base, so this is pure string work and the caller
 * decides what a "package root" is. A target's `#fragment` and `?query` are stripped before
 * resolution; a link to the package root itself does not escape.
 */
export function escapingLinks(markdown, docDir, packageRoot) {
  const escaping = []
  for (const target of linkTargets(markdown)) {
    if (!isRelativePath(target)) continue
    const path = target.split('#')[0].split('?')[0]
    if (!path) continue
    const resolved = posix.normalize(posix.join(toPosix(docDir), path))
    const root = toPosix(packageRoot)
    const inside =
      resolved === root || resolved.startsWith(`${root}/`) || !resolved.startsWith('..')
    if (!inside) escaping.push(target)
  }
  return escaping
}

function toPosix(p) {
  return p.split(sep).join('/')
}

/**
 * A link into THIS repo on the default branch: `https://github.com/<owner>/<repo>/blob|tree/main/<path>`.
 *
 * Only the canonical host/owner/repo and only `main`. A link to a tag, a permalink at a sha, or a
 * line-range on someone else's fork names something this checkout cannot speak for, so it is left
 * alone rather than guessed at.
 */
const REPO_LINK_RE = /^https:\/\/github\.com\/kibertoad\/cat-factory\/(blob|tree)\/main\/([^)\s]+)$/

/**
 * Repo-absolute links whose path does not exist, or whose `blob`/`tree` disagrees with what it is.
 *
 * `lookup(path)` answers `'file' | 'dir' | null` for a repo-relative path; the caller owns the
 * filesystem so these extractors stay pure and the fixtures need no tmpdir. Returns
 * `{ target, reason }`, because "the path is gone" and "you linked a directory as a file" are
 * different edits and a guard that says only "bad link" makes the reader find that out themselves.
 */
export function brokenRepoLinks(markdown, lookup) {
  const broken = []
  for (const target of linkTargets(markdown)) {
    const match = REPO_LINK_RE.exec(target.split('#')[0].split('?')[0])
    if (!match) continue
    const [, kind, path] = match
    const found = lookup(decodeURIComponent(path.replace(/\/$/, '')))
    if (!found) broken.push({ target, reason: 'no such path in the repo' })
    else if (kind === 'blob' && found === 'dir') {
      broken.push({ target, reason: 'a directory linked as `blob`; use `tree`' })
    } else if (kind === 'tree' && found === 'file') {
      broken.push({ target, reason: 'a file linked as `tree`; use `blob`' })
    }
  }
  return broken
}

/**
 * The markdown files a package would publish.
 *
 * `files` decides most of it, but npm ALWAYS includes `README.md` whatever `files` says, so a
 * package README with an escaping link is exactly as broken and is included here regardless. A
 * package with no `files` field publishes everything, which for this repo means a private
 * package (nothing to check) or a mistake the publish-integrity guard owns.
 */
export function shippedMarkdown(packageDir, manifest) {
  const found = new Set()
  const readme = join(packageDir, 'README.md')
  if (exists(readme)) found.add(readme)
  for (const entry of manifest.files ?? []) {
    const target = join(packageDir, entry)
    if (!exists(target)) continue
    if (statSync(target).isDirectory()) {
      for (const file of walk(target)) if (file.endsWith('.md')) found.add(file)
    } else if (target.endsWith('.md')) {
      found.add(target)
    }
  }
  return [...found].sort()
}

function exists(p) {
  try {
    statSync(p)
    return true
  } catch {
    return false
  }
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else yield full
  }
}

/**
 * Every violation across a list of package directories: `{ package, doc, escaping, broken }` per
 * document carrying at least one of either. Private packages are skipped, since nothing of theirs
 * ships. `repoRoot` is what a repo-absolute link's path is resolved against.
 */
export function findViolations(packageDirs, repoRoot) {
  const lookup = (path) => {
    try {
      return statSync(join(repoRoot, path)).isDirectory() ? 'dir' : 'file'
    } catch {
      return null
    }
  }
  const violations = []
  for (const dir of packageDirs) {
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    if (manifest.private) continue
    for (const doc of shippedMarkdown(dir, manifest)) {
      const docDir = relative(dir, resolve(doc, '..')) || '.'
      const markdown = readFileSync(doc, 'utf8')
      const escaping = escapingLinks(markdown, docDir, '.')
      const broken = brokenRepoLinks(markdown, lookup)
      if (escaping.length > 0 || broken.length > 0) {
        violations.push({ package: manifest.name ?? dir, doc, escaping, broken })
      }
    }
  }
  return violations
}
