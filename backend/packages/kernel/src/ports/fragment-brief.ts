import type { FragmentOwnerKind } from '../domain/types.js'

// ---------------------------------------------------------------------------
// Ports for AUTO-GENERATED best-practice briefs (see `domain/fragment-brief.ts` for the
// precedence rules and the threshold).
//
// A generated brief is DERIVED data with its own lifecycle — regenerated whenever the
// body it condenses changes, never authored, safe to drop — so it lives in its own table
// rather than as columns on `prompt_fragments`. Three things fall out of that separation:
// a built-in / deployment-registered fragment (which has no managed row at all) can carry
// one; the tier merge's shadow / tombstone / reseed semantics are untouched; and pruning
// is a delete rather than a nulling update.
//
// Scope is the (ownerKind, ownerId) of the tier that WON the merge for that id, so the
// row is bound to a tenant exactly like the fragment it condenses — which is what lets
// the persistence RPC bind it with the existing `owner` scope rule. A `builtin`-tier
// entry has no owner of its own, so it is scoped to the resolving workspace's ACCOUNT:
// the condensation of a deployment-wide standard is then paid for once per account
// rather than once per board, and it still cannot cross a tenant boundary.
// ---------------------------------------------------------------------------

/** A persisted, model-generated condensed variant of one fragment's body. */
export interface FragmentBriefRecord {
  ownerKind: FragmentOwnerKind
  ownerId: string
  /** The fragment id this condenses — the same stable id `prompt_fragments` keys on. */
  fragmentId: string
  /**
   * `fragmentBodyFingerprint` of the body that was condensed. The staleness signal: a
   * mismatch against the body resolved at run time means the standard moved underneath
   * this brief, so it is regenerated rather than folded.
   */
  bodyFingerprint: string
  brief: string
  /** `provider:model` that produced it, for observability and for a later re-run audit. */
  model: string
  generatedAt: number
}

export interface FragmentBriefRepository {
  /** Every generated brief owned by `(ownerKind, ownerId)`; indexed by the caller. */
  listByOwner(ownerKind: FragmentOwnerKind, ownerId: string): Promise<FragmentBriefRecord[]>
  /** Insert or replace the brief for one fragment (the fingerprint moves with it). */
  upsert(record: FragmentBriefRecord): Promise<void>
  /** Drop a fragment's brief — called when the fragment itself is removed. */
  delete(ownerKind: FragmentOwnerKind, ownerId: string, fragmentId: string): Promise<void>
}

/** The body (+ context) a generator condenses into a brief. */
export interface FragmentBriefGeneratorInput {
  title: string
  body: string
  summary?: string
}

/**
 * What one condensation attempt produced. The two members are the DURABLE outcomes — the
 * ones that are the answer for this body until the body itself changes, so the caller
 * persists both against its fingerprint. A transient failure is NOT a member here: it
 * THROWS, precisely so it is retried on the next dispatch instead of being remembered.
 *
 * Keeping "the model answered, and its answer is not usable as a brief" out of the throw
 * channel is what lets the two be told apart at all. Collapsed into one, the caller must
 * choose between re-paying for a standard that will never condense (every dispatch, forever)
 * and permanently disabling condensation for a fragment whose provider merely blipped.
 */
export type FragmentBriefGeneration =
  /** A usable condensation. Stored and folded in place of the body. */
  | { outcome: 'brief'; brief: string; model: string }
  /**
   * The model answered, but the answer cannot serve as a brief — empty, cut short by the
   * output budget, or not materially shorter than the standard it was asked to condense.
   * Recorded against the body so the full text is folded WITHOUT another model call.
   */
  | { outcome: 'not-condensable'; model: string; reason: string }

/**
 * Condenses one standard's body into a brief. Implemented by the inline LLM helper in
 * `@cat-factory/agents`; optional everywhere, so a deployment with no model wired simply
 * folds full bodies for implementer kinds — the pre-feature behaviour.
 */
export interface FragmentBriefGenerator {
  /** Whether a provider AND a model ref are wired; false ⇒ never called. */
  readonly enabled: boolean
  /**
   * Condense `input` for `workspaceId`'s credential scope.
   *
   * Returns a {@link FragmentBriefGeneration} for either durable outcome. THROWS only for a
   * transient or configuration failure (no model resolved, the provider call errored) — the
   * caller swallows that as "no brief this run" and folds the full body, so a condensation
   * outage never changes what a standard REQUIRES and never poisons the store.
   */
  generate(
    workspaceId: string,
    input: FragmentBriefGeneratorInput,
  ): Promise<FragmentBriefGeneration>
}
