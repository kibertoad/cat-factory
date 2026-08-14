// Pure extractors for the runner-image path guard (see check-runner-image-paths.mjs).
//
// Split from the CLI for the reason every guard here is: a guard whose whole output is a set
// difference DISARMS ITSELF when an extractor stops matching, because an empty expected set is
// trivially satisfied and the run reports green. So each extractor THROWS on a missing anchor
// rather than returning nothing, and the fixtures in runner-image-paths.test.mjs pin that
// alongside the happy path.
//
// GitHub Actions workflows are YAML, but no YAML parser is available to repo scripts, so these
// read the two fixed shapes by hand: a `filters: |` block scalar (dorny/paths-filter's config)
// and an `on.pull_request.paths` list. Both are plain nested lists of single-quoted globs.

/** A `- 'glob'` list item, or null for anything else. */
function listItem(line) {
  const match = /^\s*-\s*'([^']+)'\s*$/.exec(line)
  return match ? match[1] : null
}

/** The indentation width of a line (tabs are not used in these workflows). */
function indentOf(line) {
  return line.length - line.trimStart().length
}

/**
 * The lines of the block that follows `anchorLine`: everything indented deeper than it, up to the
 * first line that is not (blank lines and comments ride along).
 */
function blockAfter(lines, anchorIndex) {
  const baseIndent = indentOf(lines[anchorIndex])
  const block = []
  for (let i = anchorIndex + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') {
      block.push(line)
      continue
    }
    if (indentOf(line) <= baseIndent) break
    block.push(line)
  }
  return block
}

/** The index of the first line matching `pattern`, or -1. */
function lineMatching(lines, pattern, from = 0) {
  for (let i = from; i < lines.length; i++) if (pattern.test(lines[i])) return i
  return -1
}

/**
 * The per-filter glob lists of a dorny/paths-filter `filters: |` block, as
 * `{ <filterName>: string[] }`. Comment lines are ignored; a filter with no items yields `[]`.
 *
 * Throws when the workflow has no `filters: |` block: that is the guard's anchor, and reading a
 * moved one as "no filters" would make every comparison below pass vacuously.
 */
export function filterGlobs(workflowYaml) {
  const lines = workflowYaml.split(/\r?\n/)
  const anchor = lineMatching(lines, /^\s*filters:\s*\|\s*$/)
  if (anchor === -1) {
    throw new Error("no `filters: |` block found; the workflow's paths-filter config moved")
  }
  const block = blockAfter(lines, anchor)
  const filters = {}
  let current = null
  for (const line of block) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const named = /^\s*([A-Za-z][\w-]*):\s*$/.exec(line)
    if (named) {
      current = named[1]
      filters[current] = []
      continue
    }
    const glob = listItem(line)
    if (glob && current) filters[current].push(glob)
  }
  if (Object.keys(filters).length === 0) {
    throw new Error('the `filters: |` block declared no filters; its shape changed')
  }
  return filters
}

/**
 * The `on.pull_request.paths` list of a workflow.
 *
 * Throws when there is none: a workflow that lost its path gate runs on every PR, which is a
 * different bug from the drift this guard watches but must not read as "the gate is complete".
 */
export function triggerPaths(workflowYaml) {
  const lines = workflowYaml.split(/\r?\n/)
  const trigger = lineMatching(lines, /^\s*pull_request:\s*$/)
  if (trigger === -1) throw new Error('no `pull_request:` trigger found')
  const anchor = lineMatching(blockAfter(lines, trigger), /^\s*paths:\s*$/)
  if (anchor === -1) throw new Error('the `pull_request:` trigger declares no `paths:` filter')
  const block = blockAfter(blockAfter(lines, trigger), anchor)
  const paths = block.map(listItem).filter((glob) => glob !== null)
  if (paths.length === 0) throw new Error('the `paths:` filter is empty')
  return paths
}

/**
 * The globs an image descriptor's sources amount to: each source PREFIX as a recursive glob, plus
 * each source FILE verbatim. This is the one translation between `scripts/runner-images.mjs` (which
 * declares what goes INTO an image) and a workflow's path filter (which declares when to act on it).
 */
export function expectedGlobs(descriptor) {
  return [
    ...(descriptor.sourcePrefixes ?? []).map((prefix) => `${prefix}**`),
    ...(descriptor.sourceFiles ?? []),
  ]
}

/**
 * Compare an actual glob list against what a descriptor requires: what is `missing` (a source the
 * image is built from that the workflow ignores) and what is `unexpected` (a path the workflow acts
 * on that is neither a source nor a declared extra).
 *
 * Both directions matter and they fail differently: a missing glob means CI never runs for a change
 * that DOES reach the image, and an unexpected one means the two lists have quietly diverged in a
 * way the next descriptor edit will not reconcile.
 */
export function diffGlobs(actual, required, extras = []) {
  const allowed = new Set([...required, ...extras])
  return {
    missing: required.filter((glob) => !actual.includes(glob)),
    unexpected: actual.filter((glob) => !allowed.has(glob)),
  }
}
