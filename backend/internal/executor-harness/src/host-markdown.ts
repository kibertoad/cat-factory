// ---------------------------------------------------------------------------
// The TEXT BOUNDARY for agent-authored text the harness writes onto a VCS host.
//
// A pull-request description is NOT an inert string sink. The host parses it: `#123` becomes
// an issue link, `@name` notifies a real person, a closing keyword in front of an issue
// reference CLOSES that issue when the PR merges, and an unbalanced code fence swallows
// everything rendered after it — including the fenced JSON block the engine later appends as
// the verification report's machine-readable contract.
//
// The agent's reviewer briefing (`pr-description.ts`) is model-authored prose that lands
// verbatim on that surface, so it crosses this boundary first. "This closes #42" is idiomatic
// for a briefing to emit and must not close issue 42; "@alice owns the rounding rule" is
// idiomatic and must not page whoever holds that handle.
//
// This is a deliberate COPY of `hostMarkdown` in `@cat-factory/kernel`
// (`src/shared/host-markdown.logic.ts`), for the same reason `isSafeTestPath` is copied: the
// container image is built from `src/` plus typescript alone (the Dockerfile cannot resolve a
// `workspace:*` dependency), so the harness carries no runtime dependency on any package here.
// `test/host-markdown.conformity.test.ts` pins the two implementations to byte-identical
// output over a shared corpus, so the copy cannot drift — change one, change the other.
// ---------------------------------------------------------------------------

/**
 * The host's closing keywords. A PR body carrying one of these in front of an issue reference
 * closes that issue on merge — a side effect the harness must never trigger on the agent's
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
 * One shared walker so the three things that care about fences — leaving code untouched,
 * closing what the text left open, and finding the briefing's title heading — can never
 * disagree about where a block starts and ends.
 */
export function walkFences(
  lines: readonly string[],
  visit: (line: string, insideFence: boolean) => void,
): { char: string; length: number } | null {
  let open: { char: string; length: number } | null = null
  for (const line of lines) {
    const fence = fenceAt(line)
    // The fence line itself belongs to the code block, so it is never rewritten.
    visit(line, open !== null || fence !== null)
    if (!fence) continue
    if (!open) open = { char: fence.char, length: fence.length }
    else if (fence.char === open.char && fence.length >= open.length && !fence.info) open = null
  }
  return open
}

/**
 * Render untrusted multi-line markdown safe to send to a host: auto-link triggers defused
 * outside fenced code, and any fence the text leaves open closed again.
 *
 * Unlike kernel's `hostMarkdown.prose` this does NOT cap the length — the caller
 * ({@link import('./pr-description.js')}) applies its own budget with its own visible note
 * BEFORE calling here, so an escape entity can never be sliced in half. With that one
 * difference the output is identical, which the conformity test pins.
 */
export function inertMarkdown(text: string): string {
  const normalised = text.replace(/\r\n?/g, '\n')
  const rewritten: string[] = []
  const open = walkFences(normalised.split('\n'), (line, insideFence) => {
    rewritten.push(insideFence ? line : inertLine(line))
  })
  const joined = rewritten.join('\n')
  return open ? `${joined}\n${open.char.repeat(open.length)}` : joined
}

/**
 * Render untrusted text INLINE (a pull-request title): newlines folded to spaces because the
 * surrounding line has its own meaning, and auto-link triggers defused. The caller caps the
 * length first, for the same reason as {@link inertMarkdown}.
 */
export function inertInline(text: string): string {
  return inertLine(text.replace(/\s+/g, ' '))
}
