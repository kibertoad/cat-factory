import { redactSecrets } from './redact-secrets.logic.js'

// Composing the one thing a dead container leaves behind.
//
// A transport that discovers its backend is gone gets exactly one chance to say WHY: the
// `RunnerJobView.detail` it mints beside the eviction, which the engine persists as the step's
// `firstEvictionDetail` and renders on the run. Every producer of that text has the same two
// obligations, and each was being restated per transport:
//
//   - **Scrub it.** The material is a container's own output, a kubelet message, a harness's
//     stderr: free text that routinely echoes a token it was handed. It is persisted and
//     rendered to a person, so it goes through `redactSecrets` before either happens.
//   - **Bound it.** A post-mortem is a diagnostic, not a log sink, and it rides a row every
//     read of the run pays for.
//
// Both live here so a new transport inherits them by calling this rather than by someone
// remembering. Sibling of `describeProcessExit`, which owns the other half of the same job:
// how the death is WORDED.

/**
 * The cap on a composed post-mortem, matching the debug API's own `MAX_EVICTION_DETAIL_CHARS`
 * read budget: past it the text is not merely long, it is text no reader can be served in one
 * response anyway.
 */
export const MAX_POST_MORTEM_CHARS = 4_000

/**
 * Join a post-mortem's parts into the scrubbed, bounded `detail` a transport reports beside an
 * eviction. Empty/blank parts are dropped, so a caller composes with plain optionals rather than
 * building an array conditionally; everything empty ⇒ `undefined`, which is the honest answer
 * ("nothing could be read") and the one the eviction view omits the field for.
 *
 * ORDER MATTERS: the cap keeps the HEAD, so the caller's own one-line verdict ("the container
 * exited with code 137") must come first and any bulk material (a log tail, a kubelet message)
 * after it. A caller passing bulk is expected to have tailed it already: this cap is the
 * backstop, not the sizing decision, and it says what it dropped rather than ending mid-word
 * and reading like the whole of what was there.
 */
export function composePostMortem(parts: Array<string | undefined>): string | undefined {
  const joined = parts
    .map((part) => part?.trim())
    .filter((part): part is string => !!part)
    .join('\n')
  if (!joined) return undefined
  // Scrub BEFORE the cap, so the two can't disagree about where a redacted span started.
  const scrubbed = redactSecrets(joined)
  if (!scrubbed) return undefined
  if (scrubbed.length <= MAX_POST_MORTEM_CHARS) return scrubbed
  const dropped = scrubbed.length - MAX_POST_MORTEM_CHARS
  return `${scrubbed.slice(0, MAX_POST_MORTEM_CHARS)}\n…(${dropped} more characters of post-mortem detail dropped)`
}
