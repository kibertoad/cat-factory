// How this suite renders a value INTO text an operator reads: a thrown value, an address, and a
// command they are expected to paste.
//
// Three one-liners, and each is here because it was written more than once. The suite's whole
// premise is that a refusal is worth more than a failure, which makes every one of these strings a
// deliverable rather than a log line, and the three mistakes below are the ones that quietly take
// the value back out of them.

import { getErrorMessage, redactSecrets } from '@cat-factory/kernel'

/**
 * A thrown value as text, with the ONE fallback for a chain that said nothing.
 *
 * `getErrorMessage` reads the whole cause chain (which is why nothing here rolls its own
 * `error instanceof Error ? error.message : String(error)`; see `probeFailure.ts` for what that
 * costs), and it answers EMPTY for an error with nothing to say. That is deliberate on its part and
 * it is what this fallback is for: interpolated bare, an empty answer renders as `could not be read
 * ()`, which states less than naming the absence. One helper rather than the phrase re-invented at
 * each site, so the sentence a reader sees for an undescribable failure is one sentence.
 */
export function describeThrown(error: unknown): string {
  return getErrorMessage(error) || 'no reason reported'
}

/**
 * A value as it may be PRINTED: scrubbed.
 *
 * A base URL may legitimately carry userinfo (`https://svc:secret@backend.example.com`), which no
 * URL policy rejects, and every string this suite builds from one is thrown out of `beforeAll` and
 * printed to a console. kernel scrubs the target inside its own hints for exactly this reason, and
 * it scrubs an error chain on the way out; a value that came from THIS suite's config or from a
 * response body gets neither, so it is scrubbed at the emit site instead.
 */
export function scrubbed(value: string): string {
  return redactSecrets(value) ?? value
}

/**
 * A value as ONE single-quoted shell word, scrubbed, and safe whatever it holds.
 *
 * The scrub is the same one as above: these commands are printed beside the steps. The quoting is
 * the other half, and it is not theoretical for a value a human typed into a `.env`: a raw
 * interpolation into `'…'` breaks the whole command the moment the value holds a quote of its own,
 * and a remedy whose command does not parse is worse than one with no command, because it is
 * offered as the thing to run. POSIX has no escape inside single quotes, so the closing quote is
 * the escape: `'` becomes `'\''`.
 */
export function shellQuoted(value: string): string {
  return `'${scrubbed(value).replaceAll("'", `'\\''`)}'`
}
