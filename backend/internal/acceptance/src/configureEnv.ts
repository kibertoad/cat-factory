// The pure half of `configure`: what the `.env` becomes, and where a repository is created.
//
// Separated from the interactive flow (`configure.ts`) for the same reason `config.ts` is separate
// from the suite: the properties worth pinning are properties of the WRITE, and they are the ones
// whose failure is silent. A merge that dropped a hand-added variable, or one that echoed a token
// into a summary, looks exactly like a successful run.

import type { EnvEntry } from '@cat-factory/cli'
import { renderEnvFile } from '@cat-factory/cli'
import type { PrReportRunProvider } from '@cat-factory/sdk'

/**
 * The variables whose VALUE must never be printed, listed rather than pattern-matched.
 *
 * A `key.includes('TOKEN')` test would pass today and quietly stop covering the next secret whose
 * name does not say so, and the failure is one nobody sees: a token on someone's scrollback.
 */
export const SECRET_KEYS: ReadonlySet<string> = new Set([
  'CAT_FACTORY_API_KEY',
  'ACCEPTANCE_K3S_TOKEN',
])

/** What one managed variable becomes, and where its value came from. */
export type ManagedEntry = EnvEntry

/**
 * The write, and what it did to each key an operator might care about.
 *
 * Four categories rather than a boolean, because "nothing was overwritten" is the claim this
 * command makes and only the split can state it: `kept` is a value the file already held and this
 * run reused, `changed` is one it REPLACED (the case that owes the operator a sentence), `added` is
 * new, and `preserved` is everything in the file `configure` does not manage and therefore must not
 * lose.
 */
export type EnvMerge = {
  text: string
  kept: readonly string[]
  changed: readonly string[]
  added: readonly string[]
  preserved: readonly string[]
}

/**
 * Merge the managed entries into an existing `.env`, keeping every unmanaged line VERBATIM.
 *
 * Unmanaged content is carried over as its original bytes rather than re-rendered from a parse,
 * and that is not fussiness: `ACCEPTANCE_K3S_CA_PEM` is a multi-line quoted PEM, and a round trip
 * through parse-then-quote is exactly how such a value acquires a stray escape and stops matching
 * the cluster's certificate. Only keys this command owns are rewritten.
 */
export function mergeEnvFile(existing: string | null, entries: readonly ManagedEntry[]): EnvMerge {
  const managed = entries.map((entry) => entry.key)
  const previous = existing === null ? {} : readAssignments(existing)
  const kept: string[] = []
  const changed: string[] = []
  const added: string[] = []
  for (const entry of entries) {
    const before = previous[entry.key]
    if (before === undefined) added.push(entry.key)
    else if (before === entry.value) kept.push(entry.key)
    else changed.push(entry.key)
  }

  const leftover = existing === null ? '' : stripAssignments(existing, managed)
  const preserved = Object.keys(previous).filter((key) => !managed.includes(key))
  const tail =
    leftover.length > 0
      ? `\n# Carried over unchanged from the previous file; \`configure\` does not manage these.\n${leftover}\n`
      : ''
  return { text: `${renderEnvFile([...entries])}${tail}`, kept, changed, added, preserved }
}

/**
 * The `KEY=` assignments a `.env` holds, by key, with each value unquoted.
 *
 * Hand-rolled rather than `node:util`'s `parseEnv`, because what this needs is the SET of keys and
 * whether each still holds the value being written, and the comparison has to be against the same
 * unquoted form the writer produces. A value this command does not manage is never read for its
 * meaning, only skipped, so the shallow read is sufficient exactly where it is used.
 *
 * An assignment with an EMPTY value is kept, so `preserved` can report a `FOO=` line the merge
 * carried over. A caller using this for prompt DEFAULTS filters those itself, because blank is
 * absent everywhere else in this package (`resolveConfig` reads it that way too).
 */
export function readAssignments(text: string): Record<string, string> {
  const found: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const match = ASSIGNMENT.exec(line)
    if (match?.[1] !== undefined) found[match[1]] = unquote(match[2] ?? '')
  }
  return found
}

/** `export FOO=bar` and `FOO=bar` alike, since both appear in a hand-written file. */
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/

function unquote(raw: string): string {
  const value = raw.trim()
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
  return quoted && value.length >= 2 ? value.slice(1, -1) : value
}

/**
 * Everything in the file that is NOT an assignment to a managed key, with each dropped key's
 * leading comment block dropped with it.
 *
 * The comments go too because they were written by a previous `configure` run to describe the value
 * beneath them; kept, they would sit above whatever unmanaged variable happened to follow and
 * describe it wrongly.
 */
function stripAssignments(text: string, managed: readonly string[]): string {
  const out: string[] = []
  let comments: string[] = []
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('#')) {
      comments.push(line)
      continue
    }
    if (line.trim().length === 0) {
      // A blank line ends a comment block: whatever it introduced is above it, so the comments are
      // free-standing and belong with the content that is kept.
      out.push(...comments, line)
      comments = []
      continue
    }
    const key = ASSIGNMENT.exec(line)?.[1]
    if (key !== undefined && managed.includes(key)) {
      comments = []
      continue
    }
    out.push(...comments, line)
    comments = []
  }
  out.push(...comments)
  return out.join('\n').replace(/^\n+|\n+$/g, '')
}

/**
 * Where the operator creates a repository, prefilled, or null when this platform cannot say.
 *
 * A `Record` over the provider union the public API reports, so a third provider fails to compile
 * here rather than silently taking GitHub's link. GitLab answers NULL on purpose: a project
 * creation form takes no name parameter, and `GET /api/v1/vcs/connection` publishes no instance
 * URL, so the only link this code could build is `gitlab.com`, which for a self-hosted deployment
 * is a stranger's server. CLAUDE.md's rule for exactly this ("null ⇒ WITHHOLD the affordance,
 * never fall back to the public instance") is why the caller prints instructions instead.
 *
 * The GitHub link carries the same residual caveat, which is why the caller PRINTS it before
 * opening it: an Enterprise Server host is not knowable from `/api/v1` either, and an operator who
 * sees `github.com` and is not on it can ignore the offer.
 */
export const REPO_CREATION_URL: Record<
  PrReportRunProvider,
  (owner: string, name: string) => string | null
> = {
  github: (owner, name) => {
    const url = new URL('https://github.com/new')
    url.searchParams.set('name', name)
    url.searchParams.set('owner', owner)
    url.searchParams.set('visibility', 'private')
    return url.href
  },
  gitlab: () => null,
}

/** One line per managed key, with every secret's value withheld rather than masked. */
export function describeEntries(entries: readonly ManagedEntry[]): readonly string[] {
  return entries.map(
    (entry) =>
      `  ${entry.key}=${SECRET_KEYS.has(entry.key) ? '(set, not shown)' : entry.value || '(empty)'}`,
  )
}

/**
 * What the write did, in the order an operator wants it: what changed, then what was left alone.
 *
 * `changed` leads because it is the only category that can surprise anyone, and the promise this
 * command makes is that it never overwrites a value without saying so.
 */
export function describeMerge(merge: EnvMerge, path: string): readonly string[] {
  const lines = [`Wrote ${path}.`]
  if (merge.changed.length > 0) {
    lines.push(`  replaced: ${merge.changed.join(', ')} (the previous values are gone)`)
  }
  if (merge.added.length > 0) lines.push(`  added: ${merge.added.join(', ')}`)
  if (merge.kept.length > 0) lines.push(`  unchanged: ${merge.kept.join(', ')}`)
  if (merge.preserved.length > 0) {
    lines.push(`  left alone (not managed here): ${merge.preserved.join(', ')}`)
  }
  return lines
}
