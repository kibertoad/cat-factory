// The detection half of the documentation-link guard (the CI entry point is
// `check-doc-links.mjs`; the fixtures are `doc-links.test.mjs`).
//
// One rule, two mechanisms: a documentation link this repository publishes must RESOLVE.
//
// Mechanism 1: a website link names a page the site actually serves. The docs split sends readers
// to catfactory.ai for anything actionable without a checkout, and a link to a page that is planned
// rather than published is invisible to everyone who works here: nothing typechecks it, no test
// covers it, and it renders as a perfectly ordinary link. It is invisible in the OTHER direction
// too, which is the half nobody expects: the two repositories merge independently, so a link can be
// correct when written, dead for a week, and correct again, and reviewing it means holding a moving
// third-party deployment in your head. `docs/website-pages.txt` replaces that with a diff. It reads
// markdown and SOURCE alike, because a remedy in `SITE_DOCS` reaches an operator who is already
// stuck and can least afford a 404.
//
// Mechanism 2: an in-repo doc URL built in CODE resolves to a real file AND a real heading. `DOCS.*`
// (server) and `VCS_DOC_URLS` (kernel) put GitHub blob URLs into operator-facing error messages and
// boot warnings, several of them deep-linked to a section anchor. That anchor is a string in one
// file and a heading in another, with nothing joining them: reducing `vcs-providers.md` deleted the
// `## Setup` the GitLab webhook-rejection warning pointed at, in the same commit that removed the
// `GITLAB_WEBHOOK_SECRET` content the operator was sent for. The unit test asserting the message
// contains `vcs-providers.md#setup` passed throughout, because it only ever knew about the string.
// (That remedy now names the website page that owns setup, which is what mechanism 1 covers.)
//
// Both halves stay pure: the caller supplies the files. That keeps the fixtures free of a tmpdir
// and keeps this module honest about what it can actually see.

/** Markdown inline links and reference definitions, the same shapes `shipped-doc-links.mjs` reads. */
const LINK_RE = /\]\(\s*(<[^>]*>|[^)\s]+)/g
const REF_DEF_RE = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/gm

/** Every link target in a markdown document, in source order. */
export function linkTargets(markdown) {
  const targets = []
  for (const match of markdown.matchAll(LINK_RE)) targets.push(match[1].replace(/^<|>$/g, ''))
  for (const match of markdown.matchAll(REF_DEF_RE)) targets.push(match[1])
  return targets
}

/**
 * Parse `docs/website-pages.txt`: one URL path per line, `#` comments and blank lines dropped.
 * A leading `/` is optional in the file and normalised away here, so `/` itself becomes `''` (the
 * site root) and every other entry is stored bare.
 */
export function parseWebsitePages(text) {
  const pages = new Set()
  for (const line of text.split('\n')) {
    const trimmed = line.split('#')[0].trim()
    if (!trimmed) continue
    pages.add(trimmed.replace(/^\//, ''))
  }
  return pages
}

/**
 * Every website URL in a body of text, found RAW rather than through markdown link syntax.
 *
 * Raw is what makes this work on a `.ts` remedy string and a `.md` link with one rule, and it is
 * also the stricter reading for prose: a bare URL in a paragraph is a URL somebody will follow.
 * The terminators are the characters that end a URL in markdown, in a template literal and in a
 * quoted string; trailing prose punctuation is trimmed after the match rather than excluded from
 * it, since a `.` is legal inside a path but never ends one here.
 */
const WEBSITE_URL_RE = /https:\/\/(?:www\.)?catfactory\.ai\/[^\s)"'`<>\]]*/g

/**
 * Website URLs in `text` whose page is not in `pages`.
 *
 * The fragment and query are stripped before the lookup: whether a HEADING exists on a page is a
 * different and weaker claim than whether the page does, and only the second is checkable without
 * the network. So an anchor is carried into the message but never decides the verdict.
 */
export function unknownWebsiteLinks(text, pages) {
  const unknown = []
  for (const raw of text.match(WEBSITE_URL_RE) ?? []) {
    const url = raw.replace(/[.,;:]+$/, '')
    const path = url.slice(url.indexOf('catfactory.ai/') + 'catfactory.ai/'.length)
    if (!pages.has(path.split('#')[0].split('?')[0])) unknown.push(url)
  }
  return unknown
}

/**
 * GitHub's heading slug: lowercase, drop everything that is not a letter, digit, space, hyphen or
 * underscore, then turn each space into a hyphen.
 *
 * Punctuation is DROPPED rather than replaced, which is why `## Storage & retention` is
 * `storage--retention` and not `storage-retention`: the `&` leaves the two spaces around it behind.
 * `ENV_VARS_ANCHORS` in `config/docs.ts` hand-writes exactly these slugs, and this is what proves
 * they are still right.
 */
export function headingSlug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} \-_]/gu, '')
    .replace(/ /g, '-')
}

/** Every anchor a markdown document offers, as the set of its headings' slugs. */
export function documentAnchors(markdown) {
  const anchors = new Set()
  let inFence = false
  for (const line of markdown.split('\n')) {
    if (/^\s{0,3}(```|~~~)/.test(line)) inFence = !inFence
    if (inFence) continue
    const match = /^(#{1,6})\s+(.*)$/.exec(line)
    if (match) anchors.add(headingSlug(match[2]))
  }
  return anchors
}

/**
 * The `DOCS` map declared in `config/docs.ts`, as `key -> repo-relative markdown path`.
 *
 * Read out of the source rather than imported, because this guard runs before any build and must
 * stay install-free. Renaming a doc is still the single edit the module promises: the map moves and
 * this follows it.
 */
export function parseDocsMap(source) {
  const map = new Map()
  for (const match of source.matchAll(
    /(\w+):\s*\(anchor\?: string\) =>\s*repoDocUrl\(\s*'([^']+)'/g,
  )) {
    map.set(match[1], match[2])
  }
  return map
}

/** The `ENV_VARS_ANCHORS` constants in `config/docs.ts`, as `name -> slug`. */
export function parseEnvVarAnchors(source) {
  const block = /export const ENV_VARS_ANCHORS = \{([\s\S]*?)\n\} as const/.exec(source)
  const map = new Map()
  if (!block) return map
  for (const match of block[1].matchAll(/(\w+):\s*'([^']+)'/g)) map.set(match[1], match[2])
  return map
}

/** Repo-relative markdown paths named by a `${REPO_DOC_BLOB_BASE}/...` template literal. */
export function parseBlobTemplatePaths(source) {
  return [...source.matchAll(/\$\{REPO_DOC_BLOB_BASE\}\/([^`\s]+\.md)/g)].map((m) => m[1])
}

/**
 * Website paths a source file composes from a local base constant, as
 * `const SITE_BASE = 'https://www.catfactory.ai'` plus `` `${SITE_BASE}/guide/budgets.html` ``.
 *
 * Without this the raw scanner sees the bare origin and the interpolated tail as two unrelated
 * strings and checks NEITHER, which is worse than not scanning source at all: the guard reports
 * green over exactly the shape the code actually uses. The constant's name is read from the file
 * rather than hard-coded, so a second module adopting the idiom is covered by construction.
 */
export function websiteTemplatePaths(source) {
  const bases = [
    ...source.matchAll(/const\s+(\w+)\s*=\s*'https:\/\/(?:www\.)?catfactory\.ai\/?'/g),
  ].map((m) => m[1])
  const paths = []
  for (const base of bases) {
    const re = new RegExp(`\\$\\{${base}\\}/([^\`\\s'"]+)`, 'g')
    for (const match of source.matchAll(re)) paths.push(match[1])
  }
  return paths
}

/**
 * Every `(doc, anchor)` a source file asks `DOCS` for: `DOCS.key('literal')` and
 * `DOCS.key(ENV_VARS_ANCHORS.name)`. A bare `DOCS.key()` names the doc with no anchor, which is
 * still worth checking (the file must exist), so it is returned with `anchor: null`.
 */
export function docsReferences(source, docsMap, envAnchors) {
  const found = []
  for (const match of source.matchAll(/\bDOCS\.(\w+)\(\s*([^)]*?)\s*\)/g)) {
    const [, key, rawArg] = match
    const path = docsMap.get(key)
    if (!path) continue
    let anchor = null
    const literal = /^'([^']*)'$/.exec(rawArg)
    const constant = /^ENV_VARS_ANCHORS\.(\w+)$/.exec(rawArg)
    if (literal) anchor = literal[1]
    else if (constant) anchor = envAnchors.get(constant[1]) ?? null
    else if (rawArg !== '') continue // a computed anchor: nothing static to resolve
    found.push({ key, path, anchor, call: match[0] })
  }
  return found
}

/**
 * Resolve a batch of `{ path, anchor }` references against the tree.
 *
 * `readDoc(path)` answers the markdown at a repo-relative path, or `null` when there is none. The
 * caller owns the filesystem, so this stays pure and the fixtures need no tmpdir. Returns one
 * `{ path, anchor, reason }` per failure, because "the doc is gone" and "the heading is gone" are
 * different edits.
 */
export function brokenDocAnchors(references, readDoc) {
  const anchorsByPath = new Map()
  const broken = []
  for (const ref of references) {
    if (!anchorsByPath.has(ref.path)) {
      const markdown = readDoc(ref.path)
      anchorsByPath.set(ref.path, markdown === null ? null : documentAnchors(markdown))
    }
    const anchors = anchorsByPath.get(ref.path)
    if (anchors === null) {
      broken.push({ ...ref, reason: 'no such document in the repo' })
    } else if (ref.anchor && !anchors.has(ref.anchor)) {
      broken.push({ ...ref, reason: `no heading slugs to #${ref.anchor}` })
    }
  }
  return broken
}
