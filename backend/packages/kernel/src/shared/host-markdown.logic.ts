// ---------------------------------------------------------------------------
// The TEXT BOUNDARY for anything this platform writes onto a VCS/tracker host.
//
// A pull-request description — or an issue comment — is NOT an inert string sink. The host
// parses it: `#123` becomes an issue link, `@name` notifies a real person, a closing keyword
// in front of an issue reference CLOSES that issue when the PR merges, a newline ends a
// markdown table row, and an unbalanced code fence swallows everything after it — including
// the machine-readable JSON block external tooling ingests.
//
// Almost everything we splice into such a body is written by an agent or a human (a task
// title, a tester summary, a merge rationale, a provisioner's stderr, a requirements
// reviewer's question), so all of those are live hazards rather than theoretical ones: "This
// closes #42" is idiomatic prose for a merge rationale to emit, and it must not close issue
// 42; "@alice should decide the rounding rule" is idiomatic for a reviewer finding, and it
// must not page whoever owns that handle.
//
// This module is the single place that turns untrusted text into something safe to send to a
// host. It lives in kernel because it has TWO consumers on opposite sides of the architecture
// — the PR verification report (orchestration) and the tracker-issue writebacks
// (integrations) — and a second copy of these escapes is exactly how one of them would drift
// into notifying real accounts. It is deliberately separate from the composers (which decide
// WHAT to say) and from the marker splice in `domain/pr-report.ts` (which decides WHERE it
// goes).
//
// Adding a field to any host-bound body means picking one of {@link inline}, {@link cell} or
// {@link prose} for it — never a bare template hole.
// ---------------------------------------------------------------------------

/** Free-text prose (a tester summary, a merge rationale) is capped at this many characters. */
export const MAX_PROSE_CHARS = 4_000
/** A single markdown table cell is capped at this many characters. */
export const MAX_CELL_CHARS = 300
/** Any rendered list/table in the report is capped at this many rows. */
export const MAX_LIST_ITEMS = 50
/**
 * Hard ceiling for the whole rendered section. GitHub rejects a PR body over 65,536
 * characters with a 422, and the body also has to hold the agent's own description, so the
 * managed region keeps well clear of the limit. With the per-field caps above this is
 * unreachable for realistic runs; it exists so that pathological data degrades visibly
 * instead of making every publish fail silently forever.
 */
export const MAX_SECTION_CHARS = 50_000

/** Marks where a value was cut, so a reader never mistakes a truncation for the whole story. */
const TRUNCATION_NOTE = '… (truncated)'

/**
 * The host's closing keywords. A PR body carrying one of these in front of an issue reference
 * closes that issue on merge — a side effect the engine must never trigger on the agent's
 * behalf. Same list on GitHub and GitLab.
 */
const CLOSING_KEYWORDS =
  'close[sd]?|closing|fix|fixe[sd]|fixing|resolve[sd]?|resolving|implement(?:s|ed)?|implementing'

/** An issue/MR URL on either host, in the form a closing keyword can reference. */
const ISSUE_URL = String.raw`https?://\S+?/(?:issues|-/issues|merge_requests|pull)/\d+`

/**
 * Every auto-linking trigger, in ONE alternation.
 *
 * Deliberately a single pass rather than chained `.replace()` calls: each escape EMITS a `#`,
 * so a later rule would re-escape the output of an earlier one (`@` → `&#64;` → `&&#35;64;`).
 * One regex means the replacement text is never rescanned.
 */
const AUTO_LINK_TRIGGERS = new RegExp(
  [
    // A closing keyword in front of an issue/MR URL. The URL form survives the character
    // escapes below (nothing in it is a trigger), so the KEYWORD is what gets defused.
    String.raw`(?<keyword>\b(?:${CLOSING_KEYWORDS}))(?=\s*:?\s+${ISSUE_URL})`,
    // `@name` / `@org/team` — a mention notifies a real account.
    String.raw`(?<at>@(?=[A-Za-z0-9]))`,
    // `#123` and `owner/repo#123` — an issue/PR cross-reference.
    String.raw`(?<hash>#(?=\d))`,
    // `!123` — GitLab's merge-request reference.
    String.raw`(?<bang>!(?=\d))`,
  ].join('|'),
  'gi',
)

/**
 * Neutralise the host's auto-linking triggers in ONE line of untrusted text, leaving inline
 * code spans alone (the host does not auto-link inside them, so escaping there would only
 * show the reader a literal `&#35;`).
 *
 * The escapes are numeric HTML entities, which render as the original character but are
 * invisible to the reference parser — so the reader sees exactly what the agent wrote while
 * the mention/close side effects are defused.
 */
function inertLine(line: string): string {
  return mapOutsideCodeSpans(line, (text) =>
    text.replace(AUTO_LINK_TRIGGERS, (match, ...args) => {
      const groups = args[args.length - 1] as Record<string, string | undefined>
      // Entity-escaping the FIRST character is enough to break the parser's match while
      // rendering identically — which matters most for the keyword, whose remaining letters
      // are ordinary prose the reader should still see.
      return `&#${match.charCodeAt(0)};${groups.keyword ? match.slice(1) : ''}`
    }),
  )
}

/**
 * Apply `fn` to the parts of `line` that are NOT inline code spans. Code spans are matched by
 * a backtick run and its matching closer, which is CommonMark's rule and — more to the point
 * — the rule the host renderer applies when deciding where to auto-link.
 */
function mapOutsideCodeSpans(line: string, fn: (text: string) => string): string {
  const out: string[] = []
  let index = 0
  const span = /(`+)[\s\S]*?\1/g
  let match: RegExpExecArray | null
  while ((match = span.exec(line)) !== null) {
    out.push(fn(line.slice(index, match.index)), match[0])
    index = match.index + match[0].length
  }
  return out.join('') + fn(line.slice(index))
}

/** A line that opens or closes a fenced code block, with the fence it uses. */
function fenceAt(line: string): { char: string; length: number; info: boolean } | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
  if (!match) return null
  const fence = match[1]!
  // A ``` fence's info string may not contain a backtick (CommonMark), which is what stops an
  // inline span from being read as a fence.
  if (fence.startsWith('`') && match[2]!.includes('`')) return null
  return { char: fence[0]!, length: fence.length, info: match[2]!.trim().length > 0 }
}

/**
 * Walk `lines`, tracking fenced-code state, and hand each line to `visit` together with
 * whether it sits INSIDE a fenced block. Returns the fence still open at the end, if any.
 *
 * One shared walker so the three things that care about fences (leaving code untouched, closing
 * what the text left open, and dropping a block a hard cut landed inside) can never disagree
 * about where a block starts and ends. `at` is the index of the line that OPENED the fence still
 * standing, which is the only thing a caller cutting text back needs and the walker alone knows.
 */
function walkFences(
  lines: readonly string[],
  visit: (line: string, insideFence: boolean) => void,
): { char: string; length: number; at: number } | null {
  let open: { char: string; length: number; at: number } | null = null
  for (const [index, line] of lines.entries()) {
    const fence = fenceAt(line)
    // The fence line itself belongs to the code block, so it is never rewritten.
    visit(line, open !== null || fence !== null)
    if (!fence) continue
    if (!open) open = { char: fence.char, length: fence.length, at: index }
    else if (fence.char === open.char && fence.length >= open.length && !fence.info) open = null
  }
  return open
}

/**
 * Close any code fence the text leaves open.
 *
 * An unbalanced fence in agent prose — an interrupted transcript, a truncated tool dump — would
 * otherwise swallow every section rendered after it, including the fenced JSON block that is
 * the report's machine-readable contract. Balancing preserves the agent's own formatting
 * (unlike escaping the fences) while guaranteeing the enclosing document stays well-formed.
 */
export function balanceFences(text: string): string {
  const open = walkFences(text.split('\n'), () => {})
  return open ? `${text}\n${open.char.repeat(open.length)}` : text
}

/**
 * Drop the trailing fenced block that `text` leaves OPEN, back to the line that opened it.
 *
 * The sibling of {@link balanceFences}, for the one caller that cannot use it: a hard cut against
 * a byte budget. Closing the fence there would ADD characters to text that is already over the
 * limit, and the fence is sized to the longest backtick run in the block, so the amount added is
 * not knowable in advance. Removing is the disposition that fits by construction.
 *
 * It is also the better half to keep. Captured output is bounded from the END (see
 * {@link boundOutput}), so the fragment a cut leaves behind is the head of a log whose failure was
 * reported at its tail: the part nobody opened the report for. The caller's own truncation note is
 * what states the cut.
 */
export function dropOpenFence(text: string): string {
  const lines = text.split('\n')
  const open = walkFences(lines, () => {})
  return open ? lines.slice(0, open.at).join('\n').trimEnd() : text
}

/** Cut `value` to `max` characters, marking the cut. Prefers a line boundary when one is near. */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  const head = value.slice(0, max)
  const lastNewline = head.lastIndexOf('\n')
  const body = lastNewline > max * 0.6 ? head.slice(0, lastNewline) : head
  return `${body.trimEnd()}\n\n${TRUNCATION_NOTE}`
}

/**
 * Render untrusted multi-line prose as a safe markdown block: auto-link triggers defused,
 * length capped, and any code fence the value leaves open closed again.
 *
 * `max` lets a caller with a tighter budget than a PR body (a tracker comment renders many of
 * these into one payload, and Jira rejects an oversized comment outright) cut to ITS limit —
 * the cut happens BEFORE the escapes, so an entity can never be sliced in half.
 */
export function prose(value: string, max: number = MAX_PROSE_CHARS): string {
  const capped = truncate(value.replace(/\r\n?/g, '\n'), max)
  const rewritten: string[] = []
  const open = walkFences(capped.split('\n'), (line, insideFence) => {
    rewritten.push(insideFence ? line : inertLine(line))
  })
  const text = rewritten.join('\n')
  return open ? `${text}\n${open.char.repeat(open.length)}` : text
}

/**
 * Render untrusted text as ONE markdown table cell: newlines folded to `<br>` (a raw newline
 * ends the row and spills the rest of the value into the document as loose prose), pipes
 * escaped so a value cannot open a new column, auto-link triggers defused, and the whole thing
 * capped so a stack trace cannot dominate the table.
 */
export function cell(value: string): string {
  const flattened = truncate(value.replace(/\r\n?/g, '\n'), MAX_CELL_CHARS)
    .replaceAll('|', '\\|')
    .replace(/\n+/g, '<br>')
  return inertLine(flattened)
}

/**
 * Render untrusted text INLINE (a title, a label — not a table cell, so pipes are harmless).
 * Newlines are folded to spaces because the surrounding line has its own meaning. `max` caps
 * to a caller's own budget, before the escapes, exactly as in {@link prose}.
 */
export function inline(value: string, max: number = MAX_CELL_CHARS): string {
  return inertLine(truncate(value.replace(/\s+/g, ' '), max))
}

/**
 * Wrap already-flattened text in a code span whose delimiter the text cannot break out of.
 *
 * The inline twin of {@link outputBlock}, and it exists for the same reason: a hand-written
 * `` `${cell(value)}` `` looks safe and is not, because {@link cell} escapes pipes, newlines and
 * the auto-link triggers but NOT backticks. A value carrying one closes the span early, and the
 * rest of it lands in the document as prose, where a `#`/`@`/closing keyword the caller believed
 * was inert (the escapes deliberately skip code spans, since the host does not auto-link there)
 * is suddenly live. Sizing the delimiter one tick past the longest run inside is CommonMark's
 * rule for exactly this.
 *
 * The space padding is CommonMark's too: a span whose content begins or ends with a backtick
 * needs one space on each side, and the renderer strips a single leading+trailing space back off.
 */
function codeSpan(text: string): string {
  if (!text) return ''
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const ticks = '`'.repeat(longestRun + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${ticks}${pad}${text}${pad}${ticks}`
}

/**
 * Render untrusted text as a CODE SPAN in a markdown table cell (a command, a path, a stored id).
 *
 * Pipes are escaped because the GFM table parser splits the row BEFORE inline parsing, so a `\|`
 * reaches the span as a literal `|`. Newlines fold to spaces rather than `cell`'s `<br>`, which
 * inside a code span would render as the four characters it is.
 */
export function codeCell(value: string, max: number = MAX_CELL_CHARS): string {
  return codeSpan(truncate(value.replace(/\s+/g, ' '), max).replaceAll('|', '\\|'))
}

/**
 * Render untrusted text as a CODE SPAN outside a table (a label in a heading, a command on its
 * own line).
 *
 * Deliberately does NOT escape pipes: outside a table row nothing splits on them, and a backslash
 * escape is not honoured inside a code span, so `\|` would reach the reader as `\|`. That is the
 * same split as {@link cell} versus {@link inline}, for the same reason.
 */
export function inlineCode(value: string, max: number = MAX_CELL_CHARS): string {
  return codeSpan(truncate(value.replace(/\s+/g, ' '), max))
}

/**
 * Render captured COMMAND OUTPUT as a fenced block the output itself cannot break out of.
 *
 * A test runner, a linter or a compiler legitimately prints backticks (a rule quoting a template
 * literal, a snapshot echoing a fenced fixture), and a fixed three-tick fence closes on the first
 * such run: everything after it lands in the document as prose — the rest of the log, the sections
 * rendered below it, and the machine-readable JSON block that is the report's contract. Sizing the
 * fence one tick longer than the longest run in the body is CommonMark's rule for exactly this, so
 * the block always spans the whole tail.
 *
 * Deliberately NOT `inertLine`d: the host does not auto-link inside a fenced block, so escaping
 * would only show the reader a literal `&#35;` where the command printed a `#`. The fence is the
 * whole boundary here, which is why it has to be the right length.
 */
export function outputBlock(text: string): string {
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  return `${fence}\n${text.replace(/\r\n?/g, '\n').replace(/\n+$/, '')}\n${fence}`
}

/**
 * Bound a captured output tail, keeping the END of it and SAYING what was cut.
 *
 * The tail is where a failure is reported — a stack trace, an assertion diff, a compiler's error
 * summary — so a prefix cut throws away the half a reviewer opened the report for. Returns the
 * kept text plus how many characters were dropped, so a caller can log the cut in the report's own
 * `truncations` rather than presenting a shortened log as a whole one.
 */
export function boundOutput(
  text: string,
  max: number,
): { text: string; dropped: number; total: number } {
  const total = text.length
  if (total <= max) return { text, dropped: 0, total }
  return { text: text.slice(total - max), dropped: total - max, total }
}

/** Cap a list at {@link MAX_LIST_ITEMS}, returning the kept rows plus how many were dropped. */
export function capList<T>(items: readonly T[]): { items: T[]; dropped: number } {
  if (items.length <= MAX_LIST_ITEMS) return { items: [...items], dropped: 0 }
  return { items: items.slice(0, MAX_LIST_ITEMS), dropped: items.length - MAX_LIST_ITEMS }
}
