// ---------------------------------------------------------------------------
// The prompt-fragment TITLE generator — the inline LLM call behind the fragment
// editor's "auto-generate title" button. Given a fragment's body (and optional
// summary), it returns a short, human title. It is a one-shot completion (no thread,
// no tools), so this file is just its role prompt plus the pure prompt assembly the
// service feeds it. The response is a bare title line — no JSON, no quotes.
// ---------------------------------------------------------------------------

/** The inline agent kind the title generator runs under (for observability + model scope). */
export const FRAGMENT_TITLE_AGENT_KIND = 'fragment-title'

/**
 * The role prompt the title generator runs under. It must answer with ONLY the title text — a
 * short noun phrase naming the standard the fragment encodes — so the caller can use the reply
 * verbatim. Kept deliberately terse; the deliverable is one line.
 */
export const FRAGMENT_TITLE_SYSTEM_PROMPT =
  'You name best-practice guideline snippets. Given the body of a best-practice prompt fragment ' +
  '(a coding/writing standard fed to AI agents), produce a SHORT, specific title — a noun phrase ' +
  'of at most 8 words that names the standard the fragment encodes (e.g. "Backend error handling", ' +
  '"React state management", "Concise API docs"). Reply with ONLY the title text on a single line: ' +
  'no quotes, no trailing punctuation, no explanation, no code fences, no "Title:" prefix.'

/** Assemble the title-generator prompt from a fragment's content. Pure (unit-testable without a model). */
export function renderFragmentTitlePrompt(input: { body: string; summary?: string }): string {
  const lines: string[] = []
  const summary = input.summary?.trim()
  if (summary) lines.push(`Summary: ${summary}`, '')
  lines.push('Fragment body:', input.body.trim(), '', 'Title:')
  return lines.join('\n')
}
