// The detection half of the repo-relative link guard (the CI entry point is
// `check-doc-links.mjs`; the fixtures are `doc-links.test.mjs`).
//
// The rule: a relative link written in a markdown file under this repository must name a path that
// exists, and any `#anchor` it deep-links must exist as a heading in the markdown it lands on.
//
// Why this needs a guard, when two neighbouring ones sound like they already cover it. Neither
// does, and the gap between them is exactly where the rot lives:
//
//   check-shipped-doc-links.mjs   walks the PUBLISHED package directories only, so it never opens a
//                                 file under `backend/docs/` or `docs/`.
//   check-doc-anchors.mjs         resolves only the URLs that CODE builds.
//
// So nothing read an ordinary markdown link. `git rm`ing a doc, renaming one, or getting the `../`
// depth wrong was green, and that matters most where this repo deletes docs ON PURPOSE: CLAUDE.md
// says a completed initiative tracker converts to an ADR and is `git rm`ed in the same pull request,
// which dangles every doc that linked it. Three such links were live when this guard was written,
// pointing at trackers that became ADRs 0013, 0016 and 0028.
//
// Two deliberate exclusions, each because including it would make the guard un-greenable rather
// than useful:
//
//   Generated CHANGELOGs are FROZEN HISTORY. An entry correctly names what was true when it was
//   written, and rewriting one to chase a moved file would falsify the record. Thirty-three of the
//   forty-three dangling targets on `main` were in them. They are already on `.oxfmtrc.json`'s
//   ignore list for the same reason.
//
//   A link into a NON-markdown file is checked for EXISTENCE only. There is no anchor to resolve in
//   a `.ts` file, and a line-number fragment (`#L42`) names something a filesystem check cannot
//   speak for.
//
// Pure: the caller supplies the files, so the fixtures need no tmpdir.

import { posix } from 'node:path'
import { documentAnchors } from './doc-anchors.mjs'
import { isRelativePath, linkTargets } from './shipped-doc-links.mjs'

/** Whether a path is a CHANGELOG this guard leaves alone. */
export function isFrozenHistory(repoRelPath) {
  return repoRelPath.split('/').pop() === 'CHANGELOG.md'
}

/**
 * The document with fenced code blocks blanked out, keeping the line count so a reported line
 * number still lands.
 *
 * A link inside a fence is an ILLUSTRATION, not a link a reader follows, and reading one as real
 * produces both halves of a bad guard at once. It misses nothing (an example link is meant not to
 * resolve) and it invents failures: a reference definition is only a definition outside a fence,
 * and this repo's setup docs carry PowerShell lines like `[Net.ServicePointManager]::SecurityProtocol`
 * at the start of a line, which the reference-definition pattern reads as a link to `:SecurityProtocol`.
 */
export function stripFences(markdown) {
  const lines = markdown.split('\n')
  let fence = null
  return lines
    .map((line) => {
      const marker = /^\s{0,3}(```+|~~~+)/.exec(line)
      if (marker && fence === null) {
        fence = marker[1][0]
        return ''
      }
      if (marker && marker[1][0] === fence) {
        fence = null
        return ''
      }
      return fence === null ? line : ''
    })
    .join('\n')
}

/**
 * Every in-repo link a markdown document makes, as `{ target, path, anchor }`.
 *
 * `path` is repo-relative and already normalised against `docDir`; a SAME-DOCUMENT link (`#foo`)
 * comes back with `path` set to the document itself, because `public-api.md`'s own `#scopes`
 * pointed at a heading that had been renumbered and nothing noticed. An absolute URL, a served
 * route and a `mailto:` are not in-repo links and are left out.
 */
export function repoLinks(markdown, docRelPath) {
  const docDir = posix.dirname(docRelPath)
  const found = []
  for (const target of linkTargets(stripFences(markdown))) {
    if (target.startsWith('#')) {
      found.push({ target, path: docRelPath, anchor: target.slice(1) })
      continue
    }
    if (!isRelativePath(target)) continue
    const [rawPath, anchor] = target.split('#')
    const withoutQuery = rawPath.split('?')[0]
    if (!withoutQuery) continue
    let decoded
    try {
      decoded = decodeURIComponent(withoutQuery)
    } catch {
      // A target that is not valid percent-encoding is not a path this can resolve, and guessing
      // would report a link that works in a browser as broken.
      continue
    }
    found.push({
      target,
      path: posix.normalize(posix.join(docDir, decoded)).replace(/\/$/, ''),
      anchor: anchor || null,
    })
  }
  return found
}

/**
 * Resolve a batch of `{ path, anchor }` links against the tree.
 *
 * `lookup(path)` answers `'file' | 'dir' | null` for a repo-relative path and `readDoc(path)`
 * answers the markdown at one, so this stays pure. Returns one `{ ...link, reason }` per failure,
 * because "the path is gone", "you deep-linked a directory" and "the heading is gone" are three
 * different edits and a guard that says only "bad link" makes the reader work out which.
 */
export function brokenLinks(links, lookup, readDoc) {
  const anchorsByPath = new Map()
  const broken = []
  for (const link of links) {
    const found = lookup(link.path)
    if (!found) {
      broken.push({ ...link, reason: 'no such path in the repo' })
      continue
    }
    if (!link.anchor) continue
    if (found === 'dir') {
      broken.push({ ...link, reason: 'a directory cannot carry a heading anchor' })
      continue
    }
    if (!link.path.endsWith('.md')) continue
    if (!anchorsByPath.has(link.path)) {
      anchorsByPath.set(link.path, documentAnchors(readDoc(link.path)))
    }
    if (!anchorsByPath.get(link.path).has(link.anchor)) {
      broken.push({ ...link, reason: `no heading slugs to #${link.anchor}` })
    }
  }
  return broken
}
