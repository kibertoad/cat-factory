// Pure extractors for the external-API inventory guard. Run by `node --test 'scripts/*.test.mjs'`
// through `external-api-inventory.test.mjs`; the CLI half is `check-external-api-inventory.mjs`,
// which owns the classification map and the file walk.
//
// Kept separate for the reason every guard here splits: the guard's whole output is a set
// difference, so a detector that quietly stopped matching yields an EMPTY candidate set, which
// every classification map trivially satisfies. Fixtures pin the detector against the call forms
// this repo actually uses.

/**
 * An outbound HTTP call in CALL position.
 *
 * Two things this deliberately does NOT do. It does not match a bare `fetch(` after `async` or
 * `function`, because a Cloudflare Durable Object's `async fetch(request)` is an INBOUND handler
 * and there are nine of them; matching those would bury the vendor calls under entries whose
 * honest classification is "this is a server". And it does not stop at the global: most of this
 * repo's vendor traffic goes through `safeFetch` (the SSRF/redirect-guarded wrapper), a
 * `createHostPinnedFetch` closure, or an injected `fetchImpl`, so a detector that knew only about
 * `fetch(` would miss Confluence, Zeplin, Figma, Notion and the MCP OAuth walk outright.
 */
export const OUTBOUND_CALL =
  /(?:await|return|=|\?\?|\(|,|:)\s*(?:globalThis\.)?fetch\(|\b(?:fetchImpl|safeFetch|createHostPinnedFetch)\(|this\.http\(/

/** Whether a source file contains at least one outbound HTTP call site. */
export function makesOutboundCall(source) {
  return OUTBOUND_CALL.test(source)
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
 * The structural faults an entry can carry: a vendor row naming no vendor is exactly the silent
 * hole this guard exists to close, and an internal row with no reason is an assertion with no
 * argument.
 */
export function malformedEntries(map) {
  const faults = []
  for (const entry of map) {
    if (entry.kind === 'vendor' && !(entry.vendors?.length > 0)) {
      faults.push(`${entry.path}: kind 'vendor' with no vendors listed`)
    } else if (entry.kind === 'internal' && !entry.reason) {
      faults.push(`${entry.path}: kind 'internal' with no reason given`)
    } else if (entry.kind !== 'vendor' && entry.kind !== 'internal') {
      faults.push(`${entry.path}: unknown kind '${entry.kind}'`)
    }
  }
  return faults.sort()
}

/** The vendors the classification map claims are reached, deduplicated and sorted. */
export function sweptVendors(map) {
  return [...new Set(map.flatMap((entry) => entry.vendors ?? []))].sort()
}
