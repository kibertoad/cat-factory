import { defineApiContract } from '@toad-contracts/valibot'
import {
  assistantCapabilitySchema,
  assistantTurnInputSchema,
  assistantTurnSchema,
} from '../assistant.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// In-app assistant route contracts. Mounted under `/workspaces/:workspaceId`, so the paths here
// are relative to that prefix. See AssistantController in @cat-factory/server.
// ---------------------------------------------------------------------------

/** What the assistant can do here, and whether a model is wired to answer at all. */
export const getAssistantCapabilityContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/assistant',
  responsesByStatusCode: { 200: assistantCapabilitySchema, ...errorResponses },
})

/**
 * Run one turn: read the prompt, pick an action, perform it.
 *
 * `POST` because a turn is expected to CHANGE the board, and 200 rather than 201 because two of
 * its three outcomes create nothing: a status code cannot carry the distinction the outcome
 * variant makes, and 201 on a turn that only asked a question would be a lie the SPA has to
 * ignore anyway.
 */
export const runAssistantTurnContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/assistant/turns',
  requestBodySchema: assistantTurnInputSchema,
  responsesByStatusCode: { 200: assistantTurnSchema, ...errorResponses },
})
