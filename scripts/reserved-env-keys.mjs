// Detection for `check-reserved-env-keys.mjs` — the two extractors, split out so their behaviour
// is testable in isolation (`scripts/reserved-env-keys.test.mjs`). Same split, and for the same
// reason, as `silent-catch.mjs` / `component-imports.mjs`: a guard nothing tests is a guard that
// is trusted without evidence.

/**
 * Every variable name documented in `docs/environment-variables.md`.
 *
 * The doc's tables put the variable in the FIRST cell, backticked, and a few rows list several
 * spellings of one setting (`PUBLIC_URL` / `WORKER_PUBLIC_URL` / `APP_BASE_URL`) or a family
 * (`LANGFUSE_*`) — so every backticked token in that cell is taken, and a trailing `*`/`…` is
 * dropped to leave the prefix itself.
 *
 * Deliberately reads the DOC rather than scanning source for `env.FOO`. A textual source scan
 * cannot tell the platform's own `env.ENCRYPTION_KEY` from a test fixture's or an interpolated
 * name, and the doc is where CLAUDE.md's documentation sweep already requires a new variable to
 * appear — so this guard fails in the same PR that introduces one, which is the only moment the
 * reserved set can be updated without archaeology.
 */
export function documentedEnvVars(markdown) {
  const names = new Set()
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) continue
    const cell = line.split('|')[1]
    if (!cell) continue
    // Skip the header separator rows (`| ---- | ---- |`) and prose columns with no code span.
    for (const match of cell.matchAll(/`([A-Z][A-Z0-9_]*?)_?[*…]?`/g)) {
      names.add(match[1])
    }
  }
  return [...names].sort()
}

/**
 * Drop `//` line comments and block comments, so a member scan never reads prose.
 *
 * Deliberately naive (these two arrays hold only string literals and comments, never a regex or a
 * quote-carrying string), and naive in the SAFE direction: over-stripping would drop members and
 * fail the guard loudly, where under-stripping is what silently un-reserves them.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/**
 * The reserved exact names + prefixes, read out of the contracts module's source.
 *
 * Textual rather than an import because this guard is pure node with no build step (the module is
 * TypeScript). Both arrays are plain string literals precisely so this stays a two-line parse; if
 * one ever becomes computed, this extractor should fail loudly rather than silently read half a
 * list — hence the explicit "did we find both arrays" check.
 */
export function reservedSpec(source) {
  // Comments come out FIRST, before either list is located.
  //
  // The scan that reads the members is a single-quote pair match, so one apostrophe inside a
  // comment in these arrays ("the deployment's own …") opens a string that swallows every entry
  // after it. The guard then reports a long list of newly-unreserved variables and names none of
  // the real cause, which is the exact silent rot it exists to prevent, aimed at itself. Stripping
  // comments removes the hazard rather than asking every future editor to avoid apostrophes.
  const code = stripComments(source)
  const list = (name) => {
    // Anchored on the DECLARATION, not the first occurrence of the name: each list is also
    // mentioned in the other's doc comment, and an unanchored match read the prefixes twice.
    const match = code.match(new RegExp(`export const ${name}[^=]*=\\s*\\[([^\\]]*)\\]`))
    if (!match) throw new Error(`could not find ${name} in reserved-env-keys.ts`)
    return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  }
  return {
    keys: list('PLATFORM_RESERVED_ENV_KEYS'),
    prefixes: list('PLATFORM_RESERVED_ENV_PREFIXES'),
  }
}

/**
 * The same predicate `isReservedPlatformEnvKey` implements, over an extracted spec — plus one
 * thing the runtime predicate has no reason to know: the doc names some families by the family
 * itself (`AWS_*`, `PLATFORM_ALERTS_*`), which the extractor leaves as the bare stem. A stem that
 * IS one of our prefixes is covered, even though no variable is literally called that.
 */
export function isReserved(spec, name) {
  const upper = name.trim().toUpperCase()
  if (!upper) return false
  if (spec.keys.some((key) => key.toUpperCase() === upper)) return true
  return spec.prefixes.some((raw) => {
    const prefix = raw.toUpperCase()
    return upper.startsWith(prefix) || `${upper}_` === prefix
  })
}
