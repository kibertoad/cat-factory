import { readFile } from 'node:fs/promises'
import { log } from './logger.js'

// The Coder's forward-looking side channel. As the implementer works it appends one
// JSON line per item to a sentinel file in its working directory; the harness tails
// that file and streams the new items OUT on the job view (drain-on-read), so the
// backend lifts them onto the run's step and the "Follow-up companion" lights up
// while the container is still running. This is the OUT-bound half only — there is no
// in-bound path back into a running container (an answer reaches the Coder via a
// backend-driven re-run, not by resuming the live process).

/** The sentinel file the Coder appends items to, relative to its working directory. */
export const FOLLOW_UPS_FILENAME = '.cat-follow-ups.jsonl'

/** One streamed item the Coder surfaced. Mirrors the backend's `streamedFollowUpSchema`. */
export interface FollowUpLine {
  kind: 'follow_up' | 'question'
  title: string
  detail: string
  suggestedAction?: string
}

/** Coerce one parsed JSON line into a {@link FollowUpLine}, or null when unusable. */
function coerceLine(value: unknown): FollowUpLine | null {
  if (typeof value !== 'object' || value === null) return null
  const o = value as Record<string, unknown>
  const title = typeof o.title === 'string' ? o.title.trim() : ''
  if (!title) return null
  const kind = o.kind === 'question' ? 'question' : 'follow_up'
  const detail = typeof o.detail === 'string' ? o.detail : ''
  const suggestedAction =
    typeof o.suggestedAction === 'string' && o.suggestedAction.trim()
      ? o.suggestedAction.trim()
      : undefined
  return { kind, title: title.slice(0, 300), detail, ...(suggestedAction ? { suggestedAction } : {}) }
}

/**
 * Tails an append-only JSONL sentinel file, yielding only the NEW complete lines on each
 * {@link poll}. Tracks how many characters have been consumed so a partially-written
 * trailing line (no newline yet) is held back until it completes. Tolerant: a malformed
 * line is skipped, a missing file yields nothing — surfacing follow-ups must never
 * disturb the coding run.
 */
export class FollowUpTailer {
  private consumed = 0

  constructor(
    private readonly filePath: string,
    private readonly onItems: (items: FollowUpLine[]) => void,
  ) {}

  /** Read any new complete lines and emit the coerced items. Best-effort; never throws. */
  async poll(): Promise<void> {
    let content: string
    try {
      content = await readFile(this.filePath, 'utf8')
    } catch {
      // Not created yet (or vanished): nothing to surface.
      return
    }
    if (content.length <= this.consumed) return
    const fresh = content.slice(this.consumed)
    // Only consume up to the last newline; hold any trailing partial line for next poll.
    const lastNewline = fresh.lastIndexOf('\n')
    if (lastNewline === -1) return
    this.consumed += lastNewline + 1
    const items: FollowUpLine[] = []
    for (const raw of fresh.slice(0, lastNewline).split('\n')) {
      const line = raw.trim()
      if (!line) continue
      try {
        const coerced = coerceLine(JSON.parse(line))
        if (coerced) items.push(coerced)
      } catch {
        // A non-JSON / half-written line — skip it (a later poll re-reads from `consumed`,
        // which only advanced past complete newline-terminated lines).
      }
    }
    if (items.length > 0) {
      log.info('follow-ups: surfaced items', { count: items.length })
      this.onItems(items)
    }
  }
}
