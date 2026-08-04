import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import {
  recordTutorialEventSchema,
  tutorialProgressSchema,
  updateTutorialProgressSchema,
} from '../tutorial.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// In-app tutorial route contracts. Scoped to the SIGNED-IN USER, not a workspace, so the paths
// are absolute and mounted at the root beside `/user-settings` — tutorial progress is a fact
// about a person, and the same person's progress must not fork per board.
//
// Root-mounted also keeps these OUT of `/workspaces/:ws/*`, which matters for one specific
// reason: that prefix carries the workspace-RBAC viewer write floor (any non-GET requires
// >= member), and a read-only viewer taking a walkthrough is exactly the case this must serve.
// See TutorialController in @cat-factory/server.
// ---------------------------------------------------------------------------

export const getTutorialProgressContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/tutorial/progress',
  responsesByStatusCode: { 200: tutorialProgressSchema, ...errorResponses },
})

/** Merge into the signed-in user's progress; returns the merged row. */
export const updateTutorialProgressContract = defineApiContract({
  method: 'put',
  pathResolver: () => '/tutorial/progress',
  requestBodySchema: updateTutorialProgressSchema,
  responsesByStatusCode: { 200: tutorialProgressSchema, ...errorResponses },
})

/**
 * Clear it: the "Reset progress" action. A separate verb rather than a PUT of empty arrays,
 * because the PUT above MERGES — an empty array there means "I am adding nothing", which is
 * what a client with no local state sends, and must not wipe the row it just failed to read.
 */
export const resetTutorialProgressContract = defineApiContract({
  method: 'delete',
  pathResolver: () => '/tutorial/progress',
  responsesByStatusCode: { 200: tutorialProgressSchema, ...errorResponses },
})

/**
 * Count one funnel event. Returns 204: nothing is stored and there is nothing to read back, so
 * a body would only invite a caller to depend on one.
 */
export const recordTutorialEventContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/tutorial/events',
  requestBodySchema: recordTutorialEventSchema,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})
