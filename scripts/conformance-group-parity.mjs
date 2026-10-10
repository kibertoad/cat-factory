// Detection for `check-conformance-group-parity.mjs`: the three extractors, split out so their
// behaviour is testable in isolation (`scripts/conformance-group-parity.test.mjs`). Same split,
// and for the same reason, as `test-lane-parity.mjs` / `silent-catch.mjs`: a guard nothing tests is
// a guard that is trusted without evidence.
//
// Textual rather than a TypeScript-aware walk: this runs in the install-free `repo-guards` job, so
// there is no compiler to borrow. Every extractor throws rather than returning empty when its
// anchor is gone, because an empty group list would compare as "every facade runs everything" and
// the guard would report green having read nothing.

/** A group function of the split conformance suite: `defineCoreConformance` and its siblings. */
const GROUP = /\bdefine\w+Conformance\b/g

/**
 * The groups `suite.ts` publishes, from its `export { … }` block.
 *
 * The export block is the source of truth rather than the imports beside it: a group that is
 * imported but not exported is unreachable from a facade, which is the same hole from the other
 * side. `define*Suite` exports (the cache suite, the LLM-metrics suite) are deliberately out of
 * scope — those are per-capability suites a facade opts into, not the split halves of one suite
 * every facade owes.
 */
export function exportedGroups(source) {
  const names = new Set()
  for (const block of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const match of block[1].matchAll(GROUP)) names.add(match[0])
  }
  if (names.size === 0) {
    throw new Error(
      'no `define…Conformance` group is exported from suite.ts; if the groups were renamed, ' +
        'update scripts/conformance-group-parity.mjs to match',
    )
  }
  return [...names].sort()
}

/**
 * The groups the aggregate (`defineConformanceSuite`) calls, from its body.
 *
 * Anchored on the function rather than on the whole file so a group merely mentioned in the prose
 * above it does not count as called.
 */
export function aggregateCalls(source, aggregate = 'defineConformanceSuite') {
  const start = source.indexOf(`export function ${aggregate}(`)
  if (start === -1) {
    throw new Error(
      `could not find \`export function ${aggregate}(\` in suite.ts; if the aggregate was ` +
        'renamed or removed, update scripts/check-conformance-group-parity.mjs to match',
    )
  }
  const rest = source.slice(start)
  const end = rest.indexOf('\n}')
  if (end === -1) {
    throw new Error(
      `could not find the end of \`${aggregate}\`; the extractor expects a closing brace in ` +
        'the first column',
    )
  }
  const names = new Set()
  for (const match of rest.slice(0, end).matchAll(GROUP)) names.add(match[0])
  return [...names].sort()
}

/**
 * The groups a facade's test tree REGISTERS, across every spec file in it.
 *
 * A call, not a mention: the name has to be followed by `(`, so the comment a split spec file
 * carries about its siblings does not read as coverage.
 */
export function registeredGroups(sources) {
  const names = new Set()
  for (const source of sources) {
    for (const match of source.matchAll(/\b(define\w+Conformance)\s*\(/g)) names.add(match[1])
  }
  return [...names].sort()
}

/** The expected names a set is missing. */
export function missingGroups(expected, actual) {
  const have = new Set(actual)
  return expected.filter((name) => !have.has(name))
}
