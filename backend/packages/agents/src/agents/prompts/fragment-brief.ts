// ---------------------------------------------------------------------------
// The prompt-fragment BRIEF generator — the inline LLM call that condenses a long
// best-practice standard into the terse variant implementer kinds fold on every turn of
// their loop (the `brief-standards` trait). A one-shot completion (no thread, no tools),
// so this file is just its role prompt plus the pure prompt assembly the service feeds it.
//
// The whole safety property of this feature lives in this prompt: a brief REPLACES the
// body for the kinds that actually write the code, so a condensation that drops a rule
// silently lowers the bar those agents are held to. Hence the rule the role prompt leads
// with — compress the elaboration, never the obligations — mirroring the authoring
// contract stated for hand-written briefs in `@cat-factory/prompt-fragments`' README.
// ---------------------------------------------------------------------------

/** The inline agent kind the brief generator runs under (for observability + model scope). */
export const FRAGMENT_BRIEF_AGENT_KIND = 'fragment-brief'

/**
 * The role prompt the brief generator runs under. Two properties the caller depends on:
 * the reply is the brief VERBATIM (no preamble, no fences), and every distinct rule in the
 * body survives — the model may drop rationale, examples and elaboration, nothing else.
 */
export const FRAGMENT_BRIEF_SYSTEM_PROMPT =
  'You condense engineering best-practice standards. You are given the full text of one standard ' +
  "that is injected into an AI coding agent's system prompt on EVERY turn of a long loop, and you " +
  'produce a shorter restatement of it.\n\n' +
  'The single rule that governs your output: KEEP EVERY OBLIGATION, DROP ONLY THE ELABORATION. ' +
  'The agent reading your condensation is held to everything the original demands, so each distinct ' +
  'rule, prohibition, threshold, named tool and required step must still be present and still be ' +
  'unambiguous. What you remove is rationale, motivation, background, worked examples, repetition ' +
  'and anything that merely explains WHY a rule exists. If you cannot shorten the text without ' +
  'losing a rule, return it close to its original length rather than dropping one.\n\n' +
  'Write imperative, densely packed prose or terse bullets — whichever the original uses. Aim for ' +
  'roughly a quarter of the original length. Reply with ONLY the condensed standard: no preamble, ' +
  'no heading, no code fences, no commentary about what you removed.'

/** Assemble the brief-generator prompt from a fragment's content. Pure (unit-testable without a model). */
export function renderFragmentBriefPrompt(input: {
  title: string
  body: string
  summary?: string
}): string {
  const lines: string[] = [`Standard: ${input.title.trim()}`]
  const summary = input.summary?.trim()
  if (summary) lines.push(`Summary: ${summary}`)
  lines.push('', 'Full text of the standard:', input.body.trim(), '', 'Condensed standard:')
  return lines.join('\n')
}
