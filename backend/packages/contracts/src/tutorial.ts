import * as v from 'valibot'

// ---------------------------------------------------------------------------
// The in-app tutorial's SERVER-side state and its funnel events.
//
// The tutorial itself lives entirely in the SPA (`frontend/app/app/utils/tutorial.ts` and the
// `tutorialTours` slot); the backend knows nothing about which tours exist and deliberately keeps
// it that way. It stores two things a browser cannot:
//
//  - PROGRESS, per signed-in user, so "which walkthroughs have I finished" and "have I already
//    been offered this one" follow the PERSON rather than the browser profile. Client-persisted
//    only, a second machine re-asks the launch question and re-makes every contextual offer.
//  - EVENTS, which are not stored at all: they increment the operational counters that answer
//    whether the tutorial is being found and finished. Nothing about a single user's path is
//    retained (see `tutorialEventSchema`).
// ---------------------------------------------------------------------------

/**
 * A tour id, as a bounded-shape slug.
 *
 * The shape is a CONSTRAINT rather than a description, and it is load-bearing twice over. It is
 * what stops a client writing unbounded junk into a row it owns, and — because a tour id is a
 * metric DIMENSION on the event route — it is the first half of keeping that dimension bounded
 * (the second half is the distinct-value cap in `TutorialTelemetryService`, since a shape alone
 * still admits infinitely many values). It matches the SPA's own anchor-id rule, so a tour a
 * consumer deployment contributes passes as long as it follows the documented convention.
 */
export const tutorialTourIdSchema = v.pipe(
  v.string(),
  v.regex(/^[a-z0-9-]{1,64}$/, 'A tour id must be lowercase kebab-case, at most 64 characters.'),
)

/**
 * How many ids one of the sets below may hold. A ceiling on a row the client is trusted to
 * compose, sized far above any real catalog (the built-ins ship 13) so it can only ever be hit
 * by a bug or by abuse, and refused rather than silently truncated.
 */
export const MAX_TUTORIAL_TOUR_IDS = 200

const tourIdSet = v.pipe(v.array(tutorialTourIdSchema), v.maxLength(MAX_TUTORIAL_TOUR_IDS))

/** The user's answer to the launch prompt. Null = never answered, which is a real state. */
export const tutorialDecisionSchema = v.picklist(['accepted', 'declined'])
export type TutorialDecision = v.InferOutput<typeof tutorialDecisionSchema>

/** One user's tutorial progress, across every browser they sign in from. */
export const tutorialProgressSchema = v.object({
  /**
   * The saved launch-prompt answer, or null when they have never answered. Only an explicit
   * answer stops the prompt returning, so the three states are distinct and none may be
   * collapsed into a boolean.
   */
  decision: v.nullable(tutorialDecisionSchema),
  /** Tours finished (reached the last step's Done). */
  completedTourIds: tourIdSet,
  /** Tours the contextual offer has already been spent on, so it is never made twice. */
  nudgedTourIds: tourIdSet,
})
export type TutorialProgress = v.InferOutput<typeof tutorialProgressSchema>

/** What a user with no row yet has. */
export const DEFAULT_TUTORIAL_PROGRESS: TutorialProgress = {
  decision: null,
  completedTourIds: [],
  nudgedTourIds: [],
}

/**
 * A progress write. Every field is optional, and the two id sets are MERGED rather than
 * replaced — see `TutorialProgressService.merge` for why that is the whole concurrency story
 * here. Clearing is `DELETE`, not an empty array.
 */
export const updateTutorialProgressSchema = v.object({
  decision: v.optional(v.nullable(tutorialDecisionSchema)),
  completedTourIds: v.optional(tourIdSet),
  nudgedTourIds: v.optional(tourIdSet),
})
export type UpdateTutorialProgressInput = v.InferOutput<typeof updateTutorialProgressSchema>

/**
 * The three points of the funnel, and deliberately only three.
 *
 * `started` and `completed` are what answer the question the tutorial initiative could not
 * answer about itself: the catalogue made every walkthrough reachable, but whether one is
 * REACHED was unmeasured, so every further slice was a guess. `abandoned` is the third because
 * a tour people start and drop halfway is a different problem from one nobody opens, and the
 * two are indistinguishable from a start count alone.
 *
 * Nothing here identifies the user or the workspace, and nothing is stored: an event increments
 * a counter dimensioned by tour id and is gone. That is the whole reason this can be a plain
 * fire-and-forget POST rather than a consent-gated telemetry surface.
 */
export const tutorialEventSchema = v.picklist(['started', 'completed', 'abandoned'])
export type TutorialEvent = v.InferOutput<typeof tutorialEventSchema>

export const recordTutorialEventSchema = v.object({
  event: tutorialEventSchema,
  tourId: tutorialTourIdSchema,
})
export type RecordTutorialEventInput = v.InferOutput<typeof recordTutorialEventSchema>
