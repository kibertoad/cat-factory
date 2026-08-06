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
 * Every violation across a list of package directories: `{ package, doc, targets }` per document
 * carrying at least one escaping link. Private packages are skipped, since nothing of theirs ships.
 */
export function findViolations(packageDirs) {
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
      const targets = escapingLinks(readFileSync(doc, 'utf8'), docDir, '.')
      if (targets.length > 0) {
        violations.push({ package: manifest.name ?? dir, doc, targets })
      }
    }
  }
  return violations
}
