// MERGING into an existing `.env`, which is the other half of writing one.
//
// `env.ts` renders a fresh file. This is what a setup command needs the second time it runs, and the
// two belong together: a generator that can only overwrite is a generator nobody runs twice.
//
// Published rather than kept inside whichever command needed it first, because five judgements here
// are each a SILENT failure when you get them wrong (the command reports success and the file means
// something else), and every consumer that writes its own generator has to make all five:
//
//   1. **Unmanaged content is carried over VERBATIM**, never re-rendered from a parse. A multi-line
//      quoted PEM is exactly how a parse-then-requote round trip acquires a stray escape and stops
//      matching the certificate it was pasted from.
//   2. **The report is four categories, not a boolean.** "Nothing was overwritten" is the claim such
//      a command makes, and only `kept` / `changed` / `added` / `preserved` can state it.
//   3. **A managed value is QUOTED where the READER would otherwise disagree with the writer.**
//      `renderEnvFile` emits a bare `KEY=value`; `node:util`'s `parseEnv` treats an unquoted `#` as a
//      comment, so `A=cf-kargo #2` reads back as `cf-kargo`. A value carrying both quote characters
//      is unrepresentable and THROWS rather than being written as something else.
//   4. **The carried-over header must be RECOGNISED as well as written**, or the file grows by one
//      identical line per run.
//   5. **Secrets are withheld by an ENUMERATED list**, never a pattern match: `key.includes('TOKEN')`
//      passes today and quietly stops covering the next secret whose name does not say so.
//
// The list of secrets itself stays the CALLER's, because only a caller knows its own; the withholding
// behaviour does not.

import { type EnvEntry, renderEnvFile } from './env.js'

/**
 * What the write did, and what it did to each key an operator might care about.
 *
 * Four categories rather than a boolean, because "nothing was overwritten" is the claim this kind of
 * command makes and only the split can state it: `kept` is a value the file already held and this
 * run reused, `changed` is one it REPLACED (the case that owes the operator a sentence), `added` is
 * new, and `preserved` is everything in the file the caller does not manage and therefore must not
 * lose.
 */
export interface EnvMerge {
  text: string
  kept: readonly string[]
  changed: readonly string[]
  added: readonly string[]
  preserved: readonly string[]
}

/**
 * The header written above the content the merge did not manage.
 *
 * Exported because it has to be RECOGNISED as well as written: it introduces an UNMANAGED
 * assignment, so the ordinary comment-block rule carries it over, and a merge that then prepended a
 * fresh copy grew the file by one identical line per run. A consumer rendering its own report can
 * also match on it.
 */
export const CARRIED_OVER_HEADER =
  '# Carried over unchanged from the previous file; this command does not manage these.'

/**
 * Merge the managed entries into an existing `.env`, keeping every unmanaged line VERBATIM.
 *
 * `existing` is `null` for a file that does not exist yet, which writes the whole thing. The managed
 * values are quoted on the way out where they need it (see {@link quoteEnvValue}); the kept/changed
 * comparison stays against the UNQUOTED form, which is what both sides hold.
 */
export function mergeEnvFile(existing: string | null, entries: readonly EnvEntry[]): EnvMerge {
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
  const tail = leftover.length > 0 ? `\n${CARRIED_OVER_HEADER}\n${leftover}\n` : ''
  const rendered = renderEnvFile(
    entries.map((entry) => ({ ...entry, value: quoteEnvValue(entry.value) })),
  )
  return { text: `${rendered}${tail}`, kept, changed, added, preserved }
}

/**
 * Quote a managed value when leaving it bare would make the reader disagree with the writer.
 *
 * `renderEnvFile` emits a bare `KEY=value`, and a `.env` is typically read with `node:util`'s
 * `parseEnv`, which treats an unquoted `#` as the start of a comment and strips surrounding
 * whitespace: `parseEnv('A=with # hash')` is `{ A: 'with' }`. So a value READ as `cf-acc #2` (from a
 * quoted line an operator wrote), offered as a prompt default and accepted unchanged would be
 * written back as a DIFFERENT value while the merge report called it unchanged.
 *
 * Double quotes preferred, single quotes when the value contains a double one, because `parseEnv`
 * supports both delimiters and NO escape inside either (`A="he said \"hi\""` parses as `he said \`).
 * A value carrying both quote characters is therefore unrepresentable, so it throws rather than
 * writing a file that reads back as something else: the whole promise of such a command is that the
 * file it wrote is the file the reader will read.
 */
export function quoteEnvValue(value: string): string {
  if (!/[#\n"']/.test(value) && value.trim() === value) return value
  if (!value.includes('"')) return `"${value}"`
  if (!value.includes("'")) return `'${value}'`
  throw new Error(
    `A value containing both \` " \` and \` ' \` cannot be written to a .env file: neither quoting ` +
      `style survives, and \`parseEnv\` supports no escape inside either. Choose a value without ` +
      `one of them.`,
  )
}

/**
 * The `KEY=` assignments a `.env` holds, by key, with each value unquoted.
 *
 * Hand-rolled rather than `node:util`'s `parseEnv`, because what a merge needs is the SET of keys and
 * whether each still holds the value being written, and the comparison has to be against the same
 * unquoted form the writer produces. A value the caller does not manage is never read for its
 * meaning, only skipped, so the shallow read is sufficient exactly where it is used.
 *
 * An assignment with an EMPTY value is kept, so `preserved` can report a `FOO=` line the merge
 * carried over. A caller using this for prompt DEFAULTS filters those itself, because blank usually
 * means absent to whatever reads the file.
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
 * The comments go too because they were written by a previous run to describe the value beneath
 * them; kept, they would sit above whatever unmanaged variable happened to follow and describe it
 * wrongly.
 *
 * {@link CARRIED_OVER_HEADER} is dropped wherever it appears rather than only above a managed key:
 * the merge re-writes it, and it introduces UNMANAGED content, so the ordinary comment-block rule
 * carries it over and the file grows by one identical line per run.
 */
function stripAssignments(text: string, managed: readonly string[]): string {
  const out: string[] = []
  let comments: string[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === CARRIED_OVER_HEADER) continue
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
 * One line per managed key, with every secret's value WITHHELD rather than masked.
 *
 * `secretKeys` is the caller's, and it is a SET rather than a predicate on purpose: a pattern match
 * (`key.includes('TOKEN')`) passes today and quietly stops covering the next secret whose name does
 * not say so, and the failure is one nobody sees: a token on somebody's scrollback.
 *
 * Withheld and not masked, because a masked value still states its length and its prefix, and this
 * output is routinely pasted into an issue when the setup did not work.
 */
export function describeEntries(
  entries: readonly EnvEntry[],
  secretKeys: ReadonlySet<string>,
): readonly string[] {
  return entries.map(
    (entry) =>
      `  ${entry.key}=${secretKeys.has(entry.key) ? '(set, not shown)' : entry.value || '(empty)'}`,
  )
}

/**
 * What the write did, in the order an operator wants it: what changed, then what was left alone.
 *
 * `changed` leads because it is the only category that can surprise anyone, and the promise such a
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
