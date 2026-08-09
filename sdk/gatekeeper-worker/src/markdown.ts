// The one Markdown-safety primitive this Worker needs.
//
// Every description this Gatekeeper composes is MARKDOWN rendered to a person who is about to
// decide something, and several of the holes in it carry text an agent or a task author wrote: the
// argument bag of a call, the title of an approval card. Those are parsed surfaces, not inert
// string sinks, and the failure is not cosmetic: an unbalanced fence swallows everything after it,
// so a payload closing the block early makes the rest of OUR prose render as the payload's, right
// where "here is what you are approving" is being said.
//
// It sits beside `masking.ts` rather than inside `os/` because both doors compose descriptions and
// neither owns the rule. It is the same sizing rule the platform's own `fencedOutput` uses for
// captured command output reaching a model.

/**
 * Fence a payload so it cannot break out of the code block that holds it.
 *
 * Sized one backtick longer than the longest run the payload contains, which is what makes it
 * total: a payload holding ```` closes a ``` fence and everything after it, including the rest of
 * the description, renders as prose the reader takes for ours.
 *
 * The language tag is the caller's, because a JSON argument bag and a free-text title are both
 * fenced and only one of them is JSON.
 */
export function fenced(payload: string, language = 'json'): string {
  const longestRun = [...payload.matchAll(/`+/g)].reduce(
    (longest, match) => Math.max(longest, match[0].length),
    0,
  )
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  return `${fence}${language}\n${payload}\n${fence}`
}
