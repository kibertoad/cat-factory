// ---------------------------------------------------------------------------
// Reading a MACHINE-READ declaration block out of an agent's final reply.
//
// Several agent contracts end the same way: "END your reply with a fenced ```<tag> block".
// The foundational-services declaration and the binary-output declaration each parse one, and
// a third will follow — so the extraction itself lives here, once, and each parser owns only
// what its block's BODY means. Two copies of this is two places to get the last-block rule
// (below) wrong, and the failure is silent in both.
// ---------------------------------------------------------------------------

/** Escape the regex metacharacters in a literal tag. Our own tags are kebab slugs, but this is
 *  an exported seam and a caller's tag must never be able to reshape the pattern. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The body of the LAST fenced ` ```<tag> ` block in `output`, trimmed — or null when the reply
 * carries no such block at all, which every caller reports as its own "undeclared" state rather
 * than as an empty declaration.
 *
 * **LAST, not first**, and that is the whole reason this is shared. Every contract using it asks
 * the agent to END its reply with the block, but models routinely ILLUSTRATE the shape earlier —
 * restating the instruction, or narrating "I will finish with:" before doing the work. Taking the
 * first match parses that example and discards the real answer, which is strictly worse than
 * parsing nothing: an empty example reads as "the agent declared none" and a placeholder example
 * reads as a confident claim about artifacts nobody stored. Taking the last match makes the
 * closing block win, which is exactly what the guidance asked for.
 *
 * Only the fence's own syntax is recognised — never prose. Scanning the surrounding text would
 * "find" a service an agent merely considered, and a declaration's value is that it says what
 * the agent DID.
 */
export function extractFencedDeclaration(output: string | undefined, tag: string): string | null {
  if (!output) return null
  // The tag must END its line (horizontal whitespace only before the newline), so a mention of
  // the block in prose — "finish with a ```binary-outputs block" — is not an opening fence.
  const fence = new RegExp(`\`\`\`${escapeRegExp(tag)}[^\\S\\r\\n]*\\r?\\n([\\s\\S]*?)\`\`\``, 'gi')
  let body: string | null = null
  for (const match of output.matchAll(fence)) body = match[1] ?? ''
  return body === null ? null : body.trim()
}
