// The detection half of the doc-anchor guard (the CI entry point is `check-doc-anchors.mjs`; the
// fixtures are `doc-anchors.test.mjs`).
//
// The rule: a doc URL built in CODE must name a markdown file that exists, and any section anchor it
// deep-links must exist as a heading in that file.
//
// `DOCS.*` (server) and `VCS_DOC_URLS` (kernel) put GitHub blob URLs into operator-facing error
// messages and boot warnings, several deep-linked to a section. That anchor is a string in one file
// and a heading in another, with nothing joining them, so the coupling breaks in total silence:
// reducing `vcs-providers.md` deleted the `## Setup` the GitLab webhook-rejection warning pointed
// at, in the same commit that removed the `GITLAB_WEBHOOK_SECRET` content the operator was being
// sent for. `signatureLog.test.ts` asserts that message contains `vcs-providers.md#setup` and passed
// throughout, because a test over a composed string cannot see whether the heading exists.
//
// Deliberately NOT covered: whether a `catfactory.ai` link resolves. That needs either the network
// (flaky, and it fails on the website's outages rather than on our mistakes) or a checked-in copy of
// the site's page list, which is a second routing table to keep in step and rots in the direction
// that matters most: a page deleted from the site would stay listed here and keep passing.
//
// Pure: the caller supplies the files, so the fixtures need no tmpdir.

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
 * `repoDocUrl('path')` / `repoDocUrl('path', 'anchor')` calls whose arguments are both literal.
 *
 * There are THREE doc-URL modules, not one: `config/docs.ts` (server), `vcs-errors.ts` (kernel) and
 * `providers/docs.ts` (agents), because each layer sits below the last and cannot import it. The
 * agents one spells its anchors out at the definition (`MODEL_SUPPORT_DOCS.provisioning`), so it has
 * no call-site pass to catch it, and its two anchors are the load-bearing ones: a model-provisioning
 * failure sends an operator to `model-support.md#8-provisioning-per-runtime`, which is why that
 * doc's section NUMBERING may be reduced but never renumbered.
 *
 * The trailing `\)` is what keeps this off `repoDocUrl('path', anchor)` in the server module, where
 * the anchor is a parameter and the call sites are the thing to resolve.
 */
export function parseDirectDocUrlCalls(source) {
  return [...source.matchAll(/repoDocUrl\(\s*'([^']+)'\s*(?:,\s*'([^']*)')?\s*\)/g)].map((m) => ({
    path: m[1],
    anchor: m[2] ?? null,
    call: m[0],
  }))
}

/**
 * Every `(doc, anchor)` a source file asks `DOCS` for: `DOCS.key('literal')` and
 * `DOCS.key(ENV_VARS_ANCHORS.name)`. A bare `DOCS.key()` names the doc with no anchor, which is
 * still worth checking (the file must exist), so it comes back with `anchor: null`.
 *
 * A COMPUTED argument is skipped rather than treated as "no anchor": reporting a call this cannot
 * resolve as checked is how a guard ends up green over the case it was written for.
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
    else if (rawArg !== '') continue
    found.push({ key, path, anchor, call: match[0] })
  }
  return found
}

/**
 * Resolve a batch of `{ path, anchor }` references against the tree.
 *
 * `readDoc(path)` answers the markdown at a repo-relative path, or `null` when there is none.
 * Returns one `{ path, anchor, reason }` per failure, because "the doc is gone" and "the heading is
 * gone" are different edits and a guard saying only "bad link" makes the reader find that out.
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
    if (anchors === null) broken.push({ ...ref, reason: 'no such document in the repo' })
    else if (ref.anchor && !anchors.has(ref.anchor)) {
      broken.push({ ...ref, reason: `no heading slugs to #${ref.anchor}` })
    }
  }
  return broken
}
