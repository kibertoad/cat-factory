import { ContractNoBody, defineApiContract, withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { blockSchema } from '../entities.js'
import {
  answerInitiativeQuestionSchema,
  createInitiativeSchema,
  initiativeSchema,
  probeInitiativePresetSchema,
  promoteInitiativeFollowUpSchema,
  updateInitiativeItemSchema,
  updateInitiativePolicySchema,
} from '../initiative.js'
import { initiativePresetInputsSchema } from '../initiative.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Initiative route contracts. Mounted under `/workspaces/:workspaceId`, so the
// paths here are relative to that prefix. See InitiativeController in
// @cat-factory/server.
// ---------------------------------------------------------------------------

const initiativeIdParams = singleStringParam('initiativeId')
const blockIdParams = singleStringParam('blockId')
const presetIdParams = singleStringParam('presetId')
const followUpParams = withObjectKeys(
  v.object({ initiativeId: v.string(), followUpId: v.string() }),
)
const itemParams = withObjectKeys(v.object({ initiativeId: v.string(), itemId: v.string() }))

/**
 * Create an initiative: materialises the initiative-level board block AND its
 * empty entity in one call, returning both so the client patches its board and
 * initiative caches without a refetch.
 */
export const createInitiativeContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/initiatives',
  requestBodySchema: createInitiativeSchema,
  responsesByStatusCode: {
    201: v.object({ initiative: initiativeSchema, block: blockSchema }),
    ...errorResponses,
  },
})

export const listInitiativesContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/initiatives',
  responsesByStatusCode: { 200: v.array(initiativeSchema), ...errorResponses },
})

/**
 * Run a preset's repo-detection PREFILL probe against a frame's repo. Best-effort: returns the
 * detected form values, or `{}` (descriptor defaults) when GitHub is unwired / the frame has no
 * linked repo / the preset has no `detect` hook. Never blocks create — a failure just yields `{}`.
 */
export const probeInitiativePresetContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: presetIdParams,
  pathResolver: ({ presetId }) => `/initiative-presets/${presetId}/probe`,
  requestBodySchema: probeInitiativePresetSchema,
  responsesByStatusCode: { 200: initiativePresetInputsSchema, ...errorResponses },
})

export const getInitiativeContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: initiativeIdParams,
  pathResolver: ({ initiativeId }) => `/initiatives/${initiativeId}`,
  responsesByStatusCode: { 200: initiativeSchema, ...errorResponses },
})

/** Fetch the initiative anchored to a board block (the tracker window's load path). */
export const getInitiativeByBlockContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/initiative`,
  responsesByStatusCode: { 200: v.nullable(initiativeSchema), ...errorResponses },
})

// ---- Interactive planning (slice 2) ----------------------------------------
// The interviewer parks the planning run on a decision-wait; these drive it from the
// planning Q&A window. All return the updated initiative so the SPA patches its cache
// (the live `initiative` event carries the same entity, so no separate refetch is needed).

/** Record the human's answer to one pending planning-interview question (no run resume). */
export const answerInitiativeQuestionContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/initiative-planning/answer`,
  requestBodySchema: answerInitiativeQuestionSchema,
  responsesByStatusCode: { 200: initiativeSchema, ...errorResponses },
})

/** Submit the answered questions and resume the interview (the interviewer re-runs). */
export const continueInitiativePlanningContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/initiative-planning/continue`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: initiativeSchema, ...errorResponses },
})

/** Skip any remaining questions: synthesize the brief from what's answered and advance. */
export const proceedInitiativePlanningContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/initiative-planning/proceed`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: initiativeSchema, ...errorResponses },
})

// ---- Execution loop controls (slice 3) -------------------------------------
// Human controls over an executing initiative's loop. Each returns the updated initiative so
// the SPA patches its cache (the live `initiative` event carries the same entity). `null` is
// returned only when the block has no initiative (unchanged/no-op transitions still echo the
// current entity).

/** Pause an executing initiative — the loop stops spawning; in-flight tasks finish naturally. */
export const pauseInitiativeContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/initiative/pause`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: v.nullable(initiativeSchema), ...errorResponses },
})

/** Resume a paused initiative back to executing (the next sweep picks it up). */
export const resumeInitiativeContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/initiative/resume`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: v.nullable(initiativeSchema), ...errorResponses },
})

/** Cancel an initiative — the loop stops spawning further work (in-flight tasks are left to finish). */
export const cancelInitiativeContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/initiative/cancel`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: v.nullable(initiativeSchema), ...errorResponses },
})

// ---- Follow-up triage + item/policy editing (slice 4) ----------------------
// Mid-flight human curation of an executing initiative, keyed by initiative id (the tracker
// window / inspector operate on the loaded entity, not the block). Each returns the updated
// initiative so the SPA patches its cache (the live `initiative` event carries the same entity).

/** Promote an `open` harvested follow-up into a new `pending` tracker item under a phase. */
export const promoteInitiativeFollowUpContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: followUpParams,
  pathResolver: ({ initiativeId, followUpId }) =>
    `/initiatives/${initiativeId}/follow-ups/${followUpId}/promote`,
  requestBodySchema: promoteInitiativeFollowUpSchema,
  responsesByStatusCode: { 200: initiativeSchema, ...errorResponses },
})

/** Dismiss a harvested follow-up without acting on it. */
export const dismissInitiativeFollowUpContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: followUpParams,
  pathResolver: ({ initiativeId, followUpId }) =>
    `/initiatives/${initiativeId}/follow-ups/${followUpId}/dismiss`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: initiativeSchema, ...errorResponses },
})

/** Edit one tracker item and/or drive its status (retry a blocked item / skip it). */
export const updateInitiativeItemContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: itemParams,
  pathResolver: ({ initiativeId, itemId }) => `/initiatives/${initiativeId}/items/${itemId}`,
  requestBodySchema: updateInitiativeItemSchema,
  responsesByStatusCode: { 200: initiativeSchema, ...errorResponses },
})

/** Replace an executing initiative's execution policy (concurrency + pipeline rules). */
export const updateInitiativePolicyContract = defineApiContract({
  method: 'put',
  requestPathParamsSchema: initiativeIdParams,
  pathResolver: ({ initiativeId }) => `/initiatives/${initiativeId}/policy`,
  requestBodySchema: updateInitiativePolicySchema,
  responsesByStatusCode: { 200: initiativeSchema, ...errorResponses },
})
