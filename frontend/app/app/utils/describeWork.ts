/** The longest title the one-box intake derives. Long enough for a sentence, short for a card. */
export const DERIVED_TITLE_MAX = 80

/**
 * Split what a person typed into the one-box intake into a task title and a description.
 *
 * The title is the first line, cut at its first sentence end, and shortened at a word boundary
 * to {@link DERIVED_TITLE_MAX} with an ellipsis. The description is the WHOLE text, unedited,
 * whenever it says more than the title does: nothing the person wrote is dropped, and the agents
 * read the description, never the title alone. Returns an empty title for blank input.
 */
export function splitDescribedWork(text: string): { title: string; description?: string } {
  const body = text.trim()
  if (!body) return { title: '' }
  const firstLine = body.split(/\r?\n/, 1)[0]!.trim()
  const sentenceEnd = firstLine.search(/[.!?](\s|$)/)
  const sentence = sentenceEnd >= 0 ? firstLine.slice(0, sentenceEnd).trim() : firstLine
  const title = shorten(sentence || firstLine)
  return title === body ? { title } : { title, description: body }
}

function shorten(line: string): string {
  if (line.length <= DERIVED_TITLE_MAX) return line
  const cut = line.slice(0, DERIVED_TITLE_MAX - 1)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > DERIVED_TITLE_MAX / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}
