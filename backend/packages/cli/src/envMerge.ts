// MERGING into an existing `.env`, which is the other half of writing one.
//
// `env.ts` renders a fresh file. This is what a setup command needs the second time it runs, and the
// two belong together: a generator that can only overwrite is a generator nobody runs twice.
//
// Published rather than kept inside whichever command needed it first, because five judgements here
// are each a SILENT failure when you get them wrong (the command reports success and the file means
// something else), and every consumer that writes its own generator has to make all five:
//
//   1. **Unmanaged content is carried over VERBATIM**, never re-rendered from a parse, and a
//      multi-line quoted value is ONE assignment rather than a line and some debris. A parse-then-
//      requote round trip is how a PEM acquires a stray escape and stops matching the certificate it
//      was pasted from; a line-at-a-time strip is how one loses its opening line and has the rest
//      re-filed as somebody else's content, which the reader then takes for a set of garbage keys.
//   2. **The report is four categories, not a boolean.** "Nothing was overwritten" is the claim such
//      a command makes, and only `kept` / `changed` / `added` / `preserved` can state it.
//   3. **A managed value is QUOTED where the READER would otherwise disagree with the writer.**
//      `renderEnvFile` emits a bare `KEY=value`; `node:util`'s `parseEnv` treats an unquoted `#` as a
//      comment, so `A=cf-kargo #2` reads back as `cf-kargo`. A value carrying both quote characters
//      is unrepresentable and THROWS rather than being written as something else.
//   4. **The carried-over header must be RECOGNISED as well as written**, or the file grows by one
//      identical line per run, and recognised by a STABLE PREFIX rather than the whole sentence, or
//      the day the wording changes every file written by a previous run grows one anyway.
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
 * The part of the header that IDENTIFIES it, and the only part any recognition may depend on.
 *
 * Split off the sentence because recognising the whole of it is a trap that has already fired: the
 * header used to name `configure`, and generalising the wording for a published helper meant every
 * file a previous run had written carried a line the next run no longer matched. It was then filed as
 * an ordinary comment above unmanaged content, a fresh header was prepended above it, and the file
 * kept both, which is precisely the growth rule 4 exists to prevent. Matching a prefix that does not
 * carry the changeable half makes the next rewording free.
 */
const CARRIED_OVER_PREFIX = '# Carried over unchanged from the previous file;'

/**
 * The header written above the content the merge did not manage.
 *
 * Exported because a consumer rendering its own report matches on it. Recognition on the way IN goes
 * through {@link CARRIED_OVER_PREFIX}, not through this: it introduces an UNMANAGED assignment, so
 * the ordinary comment-block rule carries it over, and a merge that then prepended a fresh copy grew
 * the file by one line per run.
 */
export const CARRIED_OVER_HEADER = `${CARRIED_OVER_PREFIX} this command does not manage these.`

/** Whether a line is the carried-over header, in whichever words the run that wrote it used. */
function isCarriedOverHeader(line: string): boolean {
  return line.trim().startsWith(CARRIED_OVER_PREFIX)
}

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
  for (const line of readEnvLines(text)) {
    if (line.kind === 'assignment') found[line.key] = line.value
  }
  return found
}

/** `export FOO=bar` and `FOO=bar` alike, since both appear in a hand-written file. */
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/

/**
 * One LOGICAL line of a `.env`, carrying every physical line it spans.
 *
 * `text` is what gets written back for content the merge keeps, so it is the original bytes rather
 * than anything re-rendered (rule 1), joined with newlines where the value spanned several lines.
 */
type EnvLine =
  | { kind: 'comment'; text: string }
  | { kind: 'blank'; text: string }
  | { kind: 'assignment'; key: string; value: string; text: string }
  /** Anything else a hand-written file may hold. Never interpreted, only carried. */
  | { kind: 'other'; text: string }

/**
 * Split a `.env` into logical lines, joining a QUOTED VALUE that spans several of them.
 *
 * The one place the multi-line rule lives, because both readers need it and neither can be right
 * alone: a line-at-a-time reader takes `KEY="-----BEGIN CERTIFICATE-----` for the whole value, and a
 * line-at-a-time stripper drops that first line and re-emits the certificate's body as unmanaged
 * content, which the merge then writes back under the carried-over header and the reader takes for a
 * set of garbage keys (a base64 line ending `Qm9keQ==` even parses as an assignment). A PEM is the
 * commonest such value and is exactly what the module header promises to survive.
 *
 * Continuation is decided by the OPENING quote only: a value whose first character is `"` or `'` and
 * which does not close it on the same line continues until a line that does. That matches what
 * `node:util`'s `parseEnv` accepts, which is the reader this writer has to agree with, and it leaves
 * every ordinary bare value exactly as it was.
 */
function readEnvLines(text: string): EnvLine[] {
  const physical = text.split('\n')
  const out: EnvLine[] = []
  for (let index = 0; index < physical.length; index++) {
    const line = physical[index]!
    if (line.trim().startsWith('#')) {
      out.push({ kind: 'comment', text: line })
      continue
    }
    if (line.trim().length === 0) {
      out.push({ kind: 'blank', text: line })
      continue
    }
    const match = ASSIGNMENT.exec(line)
    const key = match?.[1]
    if (key === undefined) {
      out.push({ kind: 'other', text: line })
      continue
    }
    const raw = match?.[2] ?? ''
    const quote = unclosedQuote(raw)
    if (quote === null) {
      out.push({ kind: 'assignment', key, value: unquote(raw), text: line })
      continue
    }
    const spanned = [raw]
    while (index + 1 < physical.length) {
      const next = physical[++index]!
      spanned.push(next)
      if (next.includes(quote)) break
    }
    // An unterminated quote is REFUSED rather than guessed at. Where the value ends is then unknowable,
    // so every answer this module gives about the file (which keys it holds, what is unmanaged, what it
    // preserved) would be a guess reported as a fact, and the whole point of the four-way report is
    // that it can be trusted. The file is already unreadable to `parseEnv` for the same reason.
    if (!spanned.at(-1)?.includes(quote)) {
      throw new Error(
        `${key} opens a ${quote === '"' ? 'double' : 'single'}-quoted value that is never closed, ` +
          `so where it ends cannot be known and neither can what else this file holds. Close the ` +
          `quote (or remove it) and run this again.`,
      )
    }
    const joined = spanned.join('\n')
    out.push({
      kind: 'assignment',
      key,
      value: unquote(joined),
      text: `${line.slice(0, line.length - raw.length)}${joined}`,
    })
  }
  return out
}

/**
 * The quote character a value OPENS and does not close on its own line, or null.
 *
 * The opening character only, and never a quote found mid-value: `A=it's fine` opens nothing, so
 * treating a stray apostrophe as a continuation would swallow every line after it.
 */
function unclosedQuote(raw: string): string | null {
  const value = raw.trimStart()
  const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : null
  if (quote === null) return null
  return value.indexOf(quote, 1) === -1 ? quote : null
}

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
 * The carried-over header is dropped wherever it appears rather than only above a managed key: the
 * merge re-writes it, and it introduces UNMANAGED content, so the ordinary comment-block rule carries
 * it over and the file grows by one line per run. Matched by {@link isCarriedOverHeader}, so a header
 * a previous version of this code wrote in different words is still recognised.
 *
 * A managed key whose value spans several lines takes ALL of them with it, which is what reading
 * through {@link readEnvLines} buys: dropped a line at a time, the continuation lines are neither
 * comments nor blanks nor assignments to a managed key, so they survive as "unmanaged" content and
 * the file is written back corrupted.
 */
function stripAssignments(text: string, managed: readonly string[]): string {
  const out: string[] = []
  let comments: string[] = []
  for (const line of readEnvLines(text)) {
    if (line.kind === 'comment') {
      if (!isCarriedOverHeader(line.text)) comments.push(line.text)
      continue
    }
    if (line.kind === 'blank') {
      // A blank line ends a comment block: whatever it introduced is above it, so the comments are
      // free-standing and belong with the content that is kept.
      out.push(...comments, line.text)
      comments = []
      continue
    }
    if (line.kind === 'assignment' && managed.includes(line.key)) {
      comments = []
      continue
    }
    out.push(...comments, line.text)
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
