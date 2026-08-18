// Pure extractors for the external-API inventory guard. Run by `node --test 'scripts/*.test.mjs'`
// through `external-api-inventory.test.mjs`; the CLI half is `check-external-api-inventory.mjs`,
// which owns the classification map and the file walk.
//
// Kept separate for the reason every guard here splits: the guard's whole output is a set
// difference, so a detector that quietly stopped matching yields an EMPTY candidate set, which
// every classification map trivially satisfies. Fixtures pin the detectors against the call forms
// this repo actually uses.
//
// There are TWO directions a vendor surface arrives from, and the second is not a refinement of
// the first: we SEND the request (a call site), or we DECLARE the endpoint and something else
// sends it (a binary generator's descriptor an agent calls, a provider base URL an SDK appends
// to). A walk that knew only about call sites reported "all classified" while a hand-written
// Gemini image contract sat outside the inventory entirely.

/** Comments are prose about calls, not calls: a header quoting `fetch(` is not a call site. */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')
}

/**
 * An outbound HTTP call, or the resolution of the transport that makes one.
 *
 * The first three alternatives are call POSITION: the global, our own wrappers by name (most
 * vendor traffic goes through `safeFetch`, the SSRF/redirect-guarded one, or a
 * `createHostPinnedFetch` closure, so a detector that knew only `fetch(` would miss Confluence,
 * Zeplin, Figma, Notion and the MCP OAuth walk outright), and the OAuth transport method.
 *
 * The last two are the fix for what those still missed: a call through a LOCALLY BOUND alias
 * (`const doFetch = deps.fetch ?? fetch; doFetch(url)`, `ctx.fetch(url)`, `this.doFetch(url)`).
 * The alias can be named anything, so no name list finds it, and matching `<anything>.fetch(`
 * instead sweeps in Hono's `app.fetch(request)`, a Durable Object stub's `.fetch()` and every
 * domain method that happens to be called `fetch`. What IS distinctive is the binding: a file
 * that falls back to the global (`?? fetch`) or types an injected one (`typeof fetch`) either
 * calls out through it or hands the call on, and both need classifying.
 *
 * Deliberately NOT matched: a bare `fetch(` in statement position. A Worker entry point and nine
 * Durable Objects declare `async fetch(request)` / `fetch(request: Request)` as their INBOUND
 * handler, which is indistinguishable from it, and classifying "this is a server" nine times over
 * would bury the vendor calls. Such a file reaches the inventory through the binding signals
 * above instead.
 */
export const OUTBOUND_CALL = new RegExp(
  [
    String.raw`(?:await|return|void|yield|=|\?\?|\(|,|:)\s*(?:globalThis\.)?fetch\(`,
    String.raw`\b(?:fetchImpl|safeFetch|createHostPinnedFetch)\(`,
    String.raw`this\.http\(`,
    String.raw`\?\?\s*(?:globalThis\.)?fetch\b`,
    String.raw`\btypeof fetch\b`,
  ].join('|'),
)

/** Whether a source file makes, or resolves the transport for, at least one outbound call. */
export function makesOutboundCall(source) {
  return OUTBOUND_CALL.test(stripComments(source))
}

/**
 * A host declared as an endpoint, base URL or server: what something ELSE sends to.
 *
 * Narrow on purpose. Any `https://` in a string matched 107 files, nearly all of them fakes on
 * `.test` hosts, doc links inside error messages and placeholder UI copy. Requiring the host to be
 * ASSIGNED as an endpoint leaves the ones a vendor page can make wrong.
 */
export const VENDOR_ENDPOINT = new RegExp(
  String.raw`(?:endpoint|base_?url|api_?host|api_?base|servers?)\s*[:=]\s*[[{(]?\s*\{?\s*` +
    String.raw`(?:url\s*:\s*)?['"\x60](?:https?:\/\/)?([a-z0-9][a-z0-9.-]*\.[a-z]{2,})`,
  'gi',
)

/**
 * Hosts no vendor page settles: ours, a reserved test name, or a documentation placeholder.
 * `.test`, `.local`, `.internal`, `.invalid` and `example` are reserved by RFC 2606 / RFC 6761,
 * which is exactly why the fakes use them.
 */
const NOT_A_VENDOR_HOST =
  /(^|\.)(?:localhost|catfactory\.ai|example\.(?:com|org|net)|(?:test|local|internal|invalid|example))$/i

/** Every vendor host a file declares as an endpoint, deduplicated and lowercased. */
export function vendorEndpointHosts(source) {
  const hosts = new Set()
  for (const [, host] of stripComments(source).matchAll(VENDOR_ENDPOINT)) {
    if (!NOT_A_VENDOR_HOST.test(host)) hosts.add(host.toLowerCase())
  }
  return [...hosts].sort()
}

/** Whether a file declares a vendor endpoint something else sends to. */
export function declaresVendorEndpoint(source) {
  return vendorEndpointHosts(source).length > 0
}

/**
 * The classification covering a file, or null.
 *
 * An entry whose `path` ends in `/` covers everything beneath it; otherwise it names one file.
 * The LONGEST match wins, so one vendor file can sit inside an internal directory without
 * restating the directory: `executor-harness/src/` is ours, `executor-harness/src/vcs-api.ts` is
 * GitHub's.
 */
export function classificationFor(file, map) {
  let best = null
  for (const entry of map) {
    if (typeof entry.path !== 'string' || entry.path.length === 0) continue
    const covers = entry.path.endsWith('/') ? file.startsWith(entry.path) : file === entry.path
    if (!covers) continue
    if (!best || entry.path.length > best.path.length) best = entry
  }
  return best
}

/** Every candidate file no entry covers: the direction that catches a new, unswept integration. */
export function unclassifiedFiles(files, map) {
  return files.filter((file) => classificationFor(file, map) === null).sort()
}

/**
 * Every entry no candidate file matches: the direction that catches the map rotting into fiction.
 *
 * Without it a classification outlives the call it described, and the next reader takes a stale
 * `vendor` row as evidence that vendor is still reached from here.
 */
export function unmatchedEntries(files, map) {
  const covered = new Set(files.map((file) => classificationFor(file, map)).filter(Boolean))
  return map
    .filter((entry) => !covered.has(entry))
    .map((entry) => entry.path)
    .sort()
}

/**
 * `vendor` is a service we do not run, reached over a path WE typed. `internal` stays inside
 * something this repo defines. `sdk` leaves the building but on a wire shape a pinned dependency
 * owns, so currency there is a version bump under the `minimumReleaseAge` rules rather than this
 * sweep: true of the AI SDK provider wiring, which either of the other two kinds would misdescribe.
 */
const KINDS = new Set(['vendor', 'internal', 'sdk'])

/** A vendor label is a lowercase slug, so a stray capital or space fails here, not silently. */
const VENDOR_LABEL = /^[a-z0-9][a-z0-9.+-]*$/

/**
 * The structural faults an entry can carry: a vendor row naming no vendor is exactly the silent
 * hole this guard exists to close, and a row with no reason is an assertion with no argument.
 *
 * Shape is checked before meaning, because both failures below reported as something else. A
 * `vendors: 'github'` string satisfied a `?.length > 0` test and reached the swept-vendor line as
 * a list of characters. A duplicate `path` can only be matched once, so the copy surfaced through
 * `unmatchedEntries` as "it has moved or gone", sending the reader after a deleted file that was
 * right there.
 */
export function malformedEntries(map) {
  const faults = []
  const seen = new Set()
  for (const entry of map) {
    const path = entry.path
    if (typeof path !== 'string' || path.length === 0) {
      faults.push(`${JSON.stringify(entry)}: entry with no path`)
      continue
    }
    if (seen.has(path)) faults.push(`${path}: a second entry names the same path`)
    seen.add(path)
    if (!KINDS.has(entry.kind)) {
      faults.push(`${path}: unknown kind '${entry.kind}'`)
    } else if (entry.kind === 'vendor') {
      faults.push(...vendorFaults(path, entry))
    } else {
      if (!entry.reason) faults.push(`${path}: kind '${entry.kind}' with no reason given`)
      if (entry.vendors) faults.push(`${path}: kind '${entry.kind}' may not list vendors`)
    }
  }
  return faults.sort()
}

function vendorFaults(path, entry) {
  if (!Array.isArray(entry.vendors)) {
    return [`${path}: kind 'vendor' needs a vendors ARRAY, got ${typeof entry.vendors}`]
  }
  if (entry.vendors.length === 0) return [`${path}: kind 'vendor' with no vendors listed`]
  return entry.vendors
    .filter((vendor) => typeof vendor !== 'string' || !VENDOR_LABEL.test(vendor))
    .map((vendor) => `${path}: '${vendor}' is not a lowercase vendor slug`)
}

/** Every vendor a `vendor` entry claims is reached, deduplicated and sorted. */
export function sweptVendors(map) {
  const vendors = map
    .filter((entry) => entry.kind === 'vendor' && Array.isArray(entry.vendors))
    .flatMap((entry) => entry.vendors)
  return [...new Set(vendors)].sort()
}

const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '')

/** Whether a vendor label accounts for a host: `brave-search` for `api.search.brave.com`. */
function accountsForHost(vendor, host) {
  const flat = normalize(host)
  if (flat.includes(normalize(vendor))) return true
  return vendor
    .split(/[^a-z0-9]+/i)
    .some((token) => token.length >= 3 && flat.includes(token.toLowerCase()))
}

/**
 * Every candidate whose content does not support the vendors its entry claims.
 *
 * This is what makes a DIRECTORY-wide vendor entry safe. Without it such an entry is structurally
 * unable to fail: `modules/tasks/` listing only `jira` silently absorbed the GitHub, GitLab and
 * Linear providers beside it, and an Asana provider dropped in tomorrow would have been verified
 * against Atlassian's documentation. A declared host attributable to none of the listed vendors is
 * that bug, stated. A file that declares no host at all (its base URL arrives from config, as a
 * self-hosted GitLab or a Jira site does) has to at least NAME one of them, which is also what
 * catches a typo minting a vendor nothing reaches.
 *
 * `evidence` on the entry waives both, and costs a sentence saying where the identity comes from.
 */
export function vendorEvidenceGaps(files, map, readSource) {
  const gaps = []
  for (const file of files) {
    const entry = classificationFor(file, map)
    if (entry?.kind !== 'vendor' || entry.evidence || !Array.isArray(entry.vendors)) continue
    const source = readSource(file)
    const hosts = vendorEndpointHosts(source)
    const listed = entry.vendors.join(', ')
    const stray = hosts.filter((host) => !entry.vendors.some((v) => accountsForHost(v, host)))
    if (stray.length > 0) {
      gaps.push(
        `${file}: declares ${stray.join(', ')}, which the entry for ${entry.path} (${listed}) does not account for`,
      )
    } else if (
      hosts.length === 0 &&
      !entry.vendors.some((v) => normalize(source).includes(normalize(v)))
    ) {
      gaps.push(`${file}: covered by the ${listed} entry for ${entry.path} but names none of them`)
    }
  }
  return gaps.sort()
}
