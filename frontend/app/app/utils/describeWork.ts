/** The longest title the one-box intake derives. Long enough for a sentence, short for a card. */
export const DERIVED_TITLE_MAX = 80

/**
 * Abbreviations whose period does not end a sentence. Only the common ones a task description
 * starts with: the title is derived, so a miss costs a short title, never lost text (the whole text
 * is the description).
 */
const ABBREVIATIONS = new Set(['e.g', 'i.e', 'etc', 'vs', 'cf', 'dr', 'mr', 'mrs', 'ms', 'st'])

/** Ends a sentence. Full-width marks end one with or without a following space. */
const FULL_WIDTH_END = new Set(['。', '！', '？'])
const KEPT_END = new Set(['?', '!', '？', '！'])

/**
 * Split what a person typed into the one-box intake into a task title and a description.
 *
 * The title is the first line, cut at its first sentence end, and shortened at a word boundary
 * to {@link DERIVED_TITLE_MAX} with an ellipsis. A question or an exclamation keeps its mark, which
 * is part of what it says; a period does not. The description is the WHOLE text, unedited,
 * whenever it says more than the title does: nothing the person wrote is dropped, and the agents
 * read the description, never the title alone. Returns an empty title for blank input.
 */
export function splitDescribedWork(text: string): { title: string; description?: string } {
  const body = text.trim()
  if (!body) return { title: '' }
  const firstLine = body.split(/\r?\n/, 1)[0]!.trim()
  const title = shorten(firstSentence(firstLine) || firstLine)
  return stripEnd(title) === stripEnd(body) ? { title } : { title, description: body }
}

/** The first sentence of a line, ending mark included only when it is `?` or `!`. */
function firstSentence(line: string): string {
  const chars = Array.from(line)
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!
    const next = chars[i + 1]
    const ends =
      FULL_WIDTH_END.has(c) || ('.!?'.includes(c) && (next === undefined || /\s/.test(next)))
    if (!ends) continue
    if (c === '.' && isAbbreviation(chars.slice(0, i).join(''))) continue
    const sentence = chars.slice(0, KEPT_END.has(c) ? i + 1 : i).join('')
    return sentence.trim()
  }
  return line
}

/** Whether the word before a period is an abbreviation ("e.g", "Dr"), not a sentence's last word. */
function isAbbreviation(before: string): boolean {
  const word = before.split(/\s/).pop() ?? ''
  return ABBREVIATIONS.has(word.toLowerCase())
}

/** The text without its final sentence mark, so "Fix the login." says no more than "Fix the login". */
function stripEnd(s: string): string {
  return s.replace(/[.!?。！？…]+$/u, '')
}

/** Shorten by CODE POINTS, so a cut never splits an emoji or another astral character in half. */
function shorten(line: string): string {
  const chars = Array.from(line)
  if (chars.length <= DERIVED_TITLE_MAX) return line
  const cut = chars.slice(0, DERIVED_TITLE_MAX - 1).join('')
  const lastSpace = cut.lastIndexOf(' ')
  const keep = lastSpace > cut.length / 2 ? cut.slice(0, lastSpace) : cut
  return `${keep.trimEnd()}…`
}
