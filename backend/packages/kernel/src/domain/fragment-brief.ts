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
  if (stored && stored.bodyFingerprint === bodyFingerprint && stored.brief.trim()) {
    return { kind: 'generated', brief: stored.brief.trim() }
  }
  return { kind: 'generate', bodyFingerprint }
}
