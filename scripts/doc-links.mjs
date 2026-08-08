// The detection half of the documentation-link guard (the CI entry point is
// `check-doc-links.mjs`; the fixtures are `doc-links.test.mjs`).
//
// One rule, two mechanisms: a documentation link this repository publishes must RESOLVE.
//
// Mechanism 1: a website link names a page that exists. The docs split sends readers to
// catfactory.ai for anything actionable without a checkout, and a link to a page that was planned
// rather than published is invisible to everyone who works here: nothing typechecks it, no test
// covers it, and it renders as a perfectly ordinary link. `docs/website-pages.txt` is the recorded
// inventory, so adding a link to a new page is a two-line diff a reviewer sees rather than a claim
// they have to take on trust.
//
// Mechanism 2: a doc URL built in CODE resolves to a real file AND a real heading. `DOCS.*`
// (server) and `VCS_DOC_URLS` (kernel) put GitHub blob URLs into operator-facing error messages and
// boot warnings, several of them deep-linked to a section anchor. That anchor is a string in one
// file and a heading in another, with nothing joining them: deleting `## Setup` from
// `vcs-providers.md` left the GitLab webhook-rejection warning pointing an operator at a page with
// no setup section, in the same commit that removed the `GITLAB_WEBHOOK_SECRET` content they were
// sent for. The unit test asserting the message contains `vcs-providers.md#setup` still passed,
// because it only ever knew about the string.
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

const WEBSITE_LINK_RE = /^https:\/\/(?:www\.)?catfactory\.ai\/(.*)$/

/**
 * Website links in `markdown` whose page is not in `pages`.
 *
 * The fragment and query are stripped before the lookup: a heading on a page that exists is a
 * different (weaker) claim than the page existing at all, and only the second one is checkable from
 * here. A trailing `.` or `,` is prose punctuation that ran into the URL, not part of it.
 */
export function unknownWebsiteLinks(markdown, pages) {
  const unknown = []
  for (const target of linkTargets(markdown)) {
    const match = WEBSITE_LINK_RE.exec(target.replace(/[.,]$/, ''))
    if (!match) continue
    const path = match[1].split('#')[0].split('?')[0]
    if (!pages.has(path)) unknown.push(target)
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
