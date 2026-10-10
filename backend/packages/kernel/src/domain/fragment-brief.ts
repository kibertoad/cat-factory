import { contentHash } from '../shared/markdown.logic.js'

// ---------------------------------------------------------------------------
// Pure logic for a best-practice standard's CONDENSED variant (its `brief`).
//
// An implementer kind (`coder` / `fixer` / `ci-fixer` / `conflict-resolver` — the
// `brief-standards` trait) re-sends its whole system prompt on every turn of a long
// agentic loop, so a long standard is paid for again and again. A `brief` states the same
// standard tersely; the fold in `@cat-factory/agents` prefers it for exactly those kinds.
//
// Two ways a fragment gets one, in precedence order:
//
//  1. AUTHORED — a built-in's `brief`, or the `brief` a tenant linked on a managed row
//     (the repo-sourced `brief:` frontmatter key included). Always wins: a human's
//     condensation of their own standard is better than any we could synthesize.
//  2. GENERATED — for a body over {@link FRAGMENT_BRIEF_MIN_BODY_CHARS} with no authored
//     brief, condensed once by a model and persisted, keyed by a FINGERPRINT of the body
//     it condenses so a changed body (an edit, a repo resync, a re-resolved living
//     document) invalidates it and the next implementer dispatch regenerates.
//
// A body under the threshold gets neither: it is already cheap enough per turn that a
// condensation round-trip would cost more than it saves, and every condensation risks
// losing a rule. Below the threshold the full `body` is folded for every kind, which is
// byte-for-byte the pre-feature behaviour.
//
// A third stored state exists and is load-bearing: NOT-CONDENSABLE. The generator's own
// safety rule tells the model to return text close to the original length rather than drop
// a rule, so "this standard cannot be usefully shortened" is an ORDINARY outcome, not an
// error — and it has to be REMEMBERED against the body that produced it. Without that, the
// standards most worth condensing (the longest ones, the ones whose faithful condensation
// stays long) re-pay a wasted model call on every single implementer dispatch, forever.
// It is persisted as an EMPTY `brief` beside the body's fingerprint; see
// {@link isNotCondensableMarker}.
// ---------------------------------------------------------------------------

/**
 * The body size, in characters, at or above which a fragment with no authored brief gets
 * a generated one. ~1,500 chars is roughly 375 tokens — the point where re-sending the
 * full standard on every turn of a 50-turn implementer loop is worth one condensation
 * call. Deliberately a plain constant rather than a per-workspace knob: it is a property
 * of how implementer prompts are billed, not a tenant preference.
 */
export const FRAGMENT_BRIEF_MIN_BODY_CHARS = 1500

/**
 * The identity of the body a generated brief condenses. Length is prefixed to the 32-bit
 * FNV-1a digest because a collision here does not merely skip a re-import (as it does for
 * {@link contentHash}'s document-import use) — it would serve a STALE brief as if it were
 * the current standard, which is a silently wrong prompt on every implementer turn.
 */
export function fragmentBodyFingerprint(body: string): string {
  const trimmed = body.trim()
  return `${trimmed.length}-${contentHash(trimmed)}`
}

/** Whether a body is long enough for a generated brief to be worth its condensation call. */
export function bodyWarrantsBrief(body: string): boolean {
  return body.trim().length >= FRAGMENT_BRIEF_MIN_BODY_CHARS
}

/**
 * The largest a generated brief may be RELATIVE to the body it condenses. A brief exists to
 * cut what an implementer re-sends every turn, so the only question that decides whether a
 * generation is usable is "did it actually shorten the standard" — which is a RATIO, never a
 * fixed character count. An absolute cap pinned to the hand-authored wire limit gets this
 * exactly backwards at the top of the range: it refuses a 20k standard condensed to 5k (a 4x
 * per-turn saving, the single best outcome this feature can produce) while happily accepting
 * a 2k standard "condensed" to 1.9k.
 *
 * 0.6 is deliberately loose. The generator aims for ~a quarter, so anything near the target
 * passes comfortably; this bound is here to catch the model handing back a restatement that
 * saves nothing — at which point folding the full body is strictly better, since it is the
 * text nobody had to trust a condensation of.
 */
export const FRAGMENT_BRIEF_MAX_BODY_RATIO = 0.6

/**
 * Absolute ceiling on a stored brief, independent of the ratio. Only reachable for a
 * document-backed body of ~33k+ chars (a linked Confluence/Notion page, which no wire schema
 * caps), and present purely so one pathological page cannot write an unbounded row and then
 * fold it into every implementer turn.
 */
export const FRAGMENT_BRIEF_MAX_CHARS = 20_000

/**
 * Whether a model's condensation is usable AS a brief — the domain rule, kept here rather
 * than in the provider adapter because "did this actually condense the standard" is a
 * property of the two texts, not of how the model was called.
 *
 * A rejection is not a failure to retry: it is the answer for this body (see the
 * NOT-CONDENSABLE state above). The caller records it against the body's fingerprint and
 * folds the full text.
 */
export function isUsableBrief(brief: string, body: string): boolean {
  const condensed = brief.trim()
  const original = body.trim()
  if (!condensed) return false
  if (condensed.length > FRAGMENT_BRIEF_MAX_CHARS) return false
  return condensed.length <= original.length * FRAGMENT_BRIEF_MAX_BODY_RATIO
}

/**
 * Whether a stored row records a condensation that was ATTEMPTED and came back unusable,
 * rather than a brief to fold. Encoded as an empty `brief` beside a real fingerprint.
 *
 * The empty string is a sentinel with exactly ONE writer (`FragmentBriefService`, after a
 * generation the domain rejected), which is what keeps it honest — a status column would add
 * schema surface to both runtimes to express a binary the row can already carry, on a table
 * whose whole contract is that it holds derived data safe to drop and re-derive.
 */
export function isNotCondensableMarker(stored: StoredFragmentBrief): boolean {
  return stored.brief.trim().length === 0
}

/** A previously generated brief as the resolver reads it back. */
export interface StoredFragmentBrief {
  brief: string
  /** {@link fragmentBodyFingerprint} of the body this brief was condensed from. */
  bodyFingerprint: string
}

/** What {@link resolveFragmentBrief} decided, and why — the shape the caller acts on. */
export type FragmentBriefResolution =
  /** An authored brief (built-in or tenant-linked) wins outright. */
  | { kind: 'authored'; brief: string }
  /** A stored generated brief still matches the body it condensed. */
  | { kind: 'generated'; brief: string }
  /** The body is short enough that the full text is folded for every kind. */
  | { kind: 'body-below-threshold' }
  /**
   * THIS body was already condensed and the result was unusable. Fold the full text and do
   * NOT call a model again — the answer will not change until the standard itself does, at
   * which point the fingerprint stops matching and this becomes a `generate`.
   */
  | { kind: 'not-condensable' }
  /** No brief yet, or the stored one condensed a body this fragment no longer has. */
  | { kind: 'generate'; bodyFingerprint: string }

/**
 * Decide which condensed variant (if any) a resolved fragment should fold, given its
 * CURRENT body — for a living document-backed fragment that is the body just re-resolved
 * from the source, never the last-persisted snapshot, which is what makes "regenerate
 * when the source document changes" fall out of the fingerprint comparison rather than
 * needing a separate change feed.
 */
export function resolveFragmentBrief(input: {
  body: string
  /** The winning tier's authored brief, when it has one. */
  authoredBrief?: string | null
  /** The persisted generated brief for this fragment, when one exists. */
  stored?: StoredFragmentBrief | null
}): FragmentBriefResolution {
  const authored = input.authoredBrief?.trim()
  if (authored) return { kind: 'authored', brief: authored }
  if (!bodyWarrantsBrief(input.body)) return { kind: 'body-below-threshold' }
  const bodyFingerprint = fragmentBodyFingerprint(input.body)
  const stored = input.stored
  if (stored && stored.bodyFingerprint === bodyFingerprint) {
    // The row is ABOUT this exact body, so it is the answer either way: a brief to fold, or
    // the record that condensing this text produced nothing worth folding.
    if (isNotCondensableMarker(stored)) return { kind: 'not-condensable' }
    return { kind: 'generated', brief: stored.brief.trim() }
  }
  return { kind: 'generate', bodyFingerprint }
}
