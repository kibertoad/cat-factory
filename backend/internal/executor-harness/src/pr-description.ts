import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
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
// The filename is kept in sync with `PR_DESCRIPTION_FILE` in `@cat-factory/agents`
// (the executor-harness has no dependency on that package), exactly like the
// effort-report and follow-ups sentinels.
// ---------------------------------------------------------------------------

/** The sentinel file the agent writes its PR description to (relative to the checkout root). */
export const PR_DESCRIPTION_FILE = '.cat-pr-description.md'

/** Ceiling on the agent-authored body — the engine's verification report is appended to the
 * same PR body later, so the briefing must leave it room under the provider's body limit. */
const MAX_PR_BODY_CHARS = 20_000

/** Ceiling on an agent-supplied title (GitHub truncates around 256; a title should be short). */
const MAX_PR_TITLE_CHARS = 160

/**
 * The engine maintains a managed verification-report section on the PR body, delimited by these
 * markers (kept in sync with `kernel/src/domain/pr-report.ts` — no dependency from here). A marker
 * inside the agent-authored briefing would make the engine's splice treat part of the briefing as
 * its own managed region and rewrite it, so any occurrence is stripped up front.
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
 * A first line of the form `# <title>` sets the PR title; everything after it is the body.
 * The whole text is secret-scrubbed, and an over-budget body is truncated WITH a visible note
 * (a silent cut would read as the complete briefing).
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

  const lines = text.split('\n')
  let title: string | undefined
  let bodyLines = lines
  const heading = /^#\s+(.+)$/.exec(lines[0]?.trim() ?? '')
  if (heading) {
    const candidate = heading[1]!.trim()
    if (candidate) {
      title = candidate.slice(0, MAX_PR_TITLE_CHARS)
      bodyLines = lines.slice(1)
    }
  }
  let body: string | undefined = bodyLines.join('\n').trim()
  if (!body) body = undefined
  if (body && body.length > MAX_PR_BODY_CHARS) {
    body =
      body.slice(0, MAX_PR_BODY_CHARS) +
      '\n\n_Truncated by the platform: the description exceeded the size budget._'
  }
  if (!title && !body) return undefined
  return { ...(title ? { title } : {}), ...(body ? { body } : {}) }
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
