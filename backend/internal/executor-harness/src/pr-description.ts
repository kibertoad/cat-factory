import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { inertInline, inertMarkdown, walkFences } from './host-markdown.js'
import { redactSecrets } from './redact.js'

// ---------------------------------------------------------------------------
// The agent-authored pull-request description side channel. A coding agent whose
// dispatch opens a PR is asked (via the backend-composed system prompt) to end its
// run by writing a reviewer briefing — the problem, the decisions made, what to
// look out for — to a sentinel file at the root of the checkout the PR belongs to.
// The harness reads it after the agent settles, removes it (so it never lands in a
// commit), and uses it as the PR body in place of the generic dispatch-time text
// the job body carries. Absent or unusable ⇒ the dispatch-time fallback, unchanged.
//
// The briefing is MODEL-AUTHORED text landing verbatim on a host-parsed surface, so
// it crosses `host-markdown.ts` (auto-link triggers defused, open code fences closed)
// on the way out — see that module for why a PR body is not an inert string sink.
//
// The filename is kept in sync with `PR_DESCRIPTION_FILE` in `@cat-factory/agents`
// (the executor-harness has no dependency on that package), exactly like the
// effort-report and follow-ups sentinels.
// ---------------------------------------------------------------------------

/** The sentinel file the agent writes its PR description to (relative to the checkout root). */
export const PR_DESCRIPTION_FILE = '.cat-pr-description.md'

/**
 * Ceiling on the agent-authored body.
 *
 * The engine appends its verification report to the SAME body later, and that section carries
 * its own 50,000-character ceiling (`MAX_SECTION_CHARS` in kernel's `hostMarkdown`). GitHub
 * rejects a body over 65,536 with a 422, and the report publisher swallows its own failures —
 * so a briefing budget that does not leave the report room would surface as a report that
 * silently never publishes. 15,000 + 50,000 stays under the limit with room to join them.
 */
const MAX_PR_BODY_CHARS = 15_000

/** Ceiling on an agent-supplied title (GitHub truncates around 256; a title should be short). */
const MAX_PR_TITLE_CHARS = 160

/** Opens the engine-managed region of a PR body (kept in sync with `kernel/domain/pr-report.ts`). */
export const PR_REPORT_MARKER_START = '<!-- cat-factory:verification-report:start -->'
/** Closes the engine-managed region of a PR body. */
export const PR_REPORT_MARKER_END = '<!-- cat-factory:verification-report:end -->'

/**
 * A marker inside the agent-authored briefing would make the engine's splice treat part of the
 * briefing as its own managed region and rewrite it, so any occurrence is stripped up front.
 * Deliberately laxer than the exact constants above (whitespace-tolerant), so a near-miss the
 * splice itself would not match cannot survive here either.
 */
const MANAGED_SECTION_MARKER = /<!--\s*cat-factory:verification-report:(?:start|end)\s*-->/g

/** An agent-authored PR description: an optional title plus the briefing body. */
export interface AgentPrDescription {
  title?: string
  body?: string
}

/**
 * Read + parse + REMOVE the agent's PR-description sentinel from `dir`. Lenient: returns
 * undefined when the file is absent (the agent wrote none) or carries nothing usable. Never
 * throws — a bad description must never fail an otherwise-good run; the caller falls back to
 * the dispatch-time text.
 *
 * A SINGLE `# <title>` heading on the first line sets the PR title; everything after it is the
 * body (see {@link splitTitle} for why a LONE heading is required). The whole text is
 * secret-scrubbed, an over-budget body is truncated WITH a visible note (a silent cut would
 * read as the complete briefing), and both halves are made inert for the host.
 *
 * On scrubbing: `redactSecrets`'s credential-assignment rule is deliberately eager, so a
 * briefing sentence like "the token: handling changed" loses its next word. That is the right
 * trade for a surface this public — the rule is shared with every other redaction path, and
 * narrowing it so prose reads better would weaken all of them.
 */
export async function readPrDescription(dir: string): Promise<AgentPrDescription | undefined> {
  const path = join(dir, PR_DESCRIPTION_FILE)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return undefined // no description written — the fallback body applies
  }
  // Remove it so it never lands in a commit (defence in depth; the checkout also excludes it).
  await rm(path, { force: true }).catch(() => {})
  const text = redactSecrets(raw).replace(MANAGED_SECTION_MARKER, '').trim()
  if (!text) return undefined

  const split = splitTitle(text)
  // Cap BEFORE the escapes on both halves, so a numeric entity can never be sliced in half.
  const title = split.title ? inertInline(capTitle(split.title)) : undefined
  const body = split.body ? inertMarkdown(capBody(split.body)) : undefined
  if (!title && !body) return undefined
  return { ...(title ? { title } : {}), ...(body ? { body } : {}) }
}

/**
 * Split a leading `# <title>` heading off the briefing.
 *
 * The heading becomes the title ONLY when it is the single level-1 heading in the whole file,
 * which is exactly what the prompt asks for ("a single `# <title>` heading line"). An agent
 * that instead uses `#` for its section headings — `# Problem`, `# Decisions`, entirely
 * idiomatic for the briefing the prompt describes — would otherwise have its first section
 * silently become the pull request's title, replacing `<block> (<pipeline>)` with the word
 * "Problem". Headings inside fenced code are not headings and are skipped, or a briefing
 * quoting a shell snippet (`# rebuild the image`) would lose its title to the snippet.
 */
function splitTitle(text: string): { title?: string; body: string } {
  const lines = text.split('\n')
  const headings: number[] = []
  let index = 0
  walkFences(lines, (line, insideFence) => {
    if (!insideFence && /^#\s+\S/.test(line)) headings.push(index)
    index += 1
  })
  if (headings.length !== 1 || headings[0] !== 0) return { body: text }
  const title = lines[0]!.replace(/^#\s+/, '').trim()
  if (!title) return { body: text }
  return { title, body: lines.slice(1).join('\n').trim() }
}

/** Cut an over-long title at a word boundary when one is near, marking the cut. */
function capTitle(value: string): string {
  const collapsed = value.trim()
  if (collapsed.length <= MAX_PR_TITLE_CHARS) return collapsed
  const head = collapsed.slice(0, MAX_PR_TITLE_CHARS - 1)
  const space = head.lastIndexOf(' ')
  const kept = space > MAX_PR_TITLE_CHARS * 0.6 ? head.slice(0, space) : head
  return `${kept.trimEnd()}…`
}

/** Cut an over-budget body, marking the cut so it is never read as the whole briefing. */
function capBody(value: string): string {
  if (value.length <= MAX_PR_BODY_CHARS) return value
  return (
    value.slice(0, MAX_PR_BODY_CHARS).trimEnd() +
    '\n\n_Truncated by the platform: the description exceeded the size budget._'
  )
}

/**
 * Fold an agent-authored description over the dispatch-time fallback the job body carries.
 * Field-wise: the agent's title/body each win when present, so a body-only briefing keeps the
 * backend-composed title and vice versa.
 */
export function applyPrDescription(
  fallback: { title: string; body: string },
  agent: AgentPrDescription | undefined,
): { title: string; body: string } {
  if (!agent) return fallback
  return { title: agent.title ?? fallback.title, body: agent.body ?? fallback.body }
}

/**
 * The body to PATCH onto an ALREADY-OPEN pull request when a resumed run produced a fresh
 * briefing: the new description followed by whatever the engine's managed verification-report
 * region currently holds.
 *
 * Carrying the region across is what makes the refresh safe. The engine re-publishes the report
 * on every step settlement, so dropping it here would usually self-heal — but "usually" is not
 * a property to rest the one artefact a reviewer reads on, and a run that settles no further
 * step (the work is already merged, the run failed after its push) would never restore it.
 */
export function preserveManagedSection(currentBody: string | undefined, nextBody: string): string {
  const existing = currentBody ?? ''
  const start = existing.indexOf(PR_REPORT_MARKER_START)
  const end = existing.indexOf(PR_REPORT_MARKER_END)
  if (start === -1 || end <= start) return nextBody
  const region = existing.slice(start, end + PR_REPORT_MARKER_END.length)
  return `${nextBody.trim()}\n\n${region}\n`
}
