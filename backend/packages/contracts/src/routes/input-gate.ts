import { defineApiContract } from '@toad-contracts/valibot'
import { resolveInputGateSchema, runInputGateSchema } from '../input-gate.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// PRE-DISPATCH INPUT GATE route contracts. Mounted under `/workspaces/:workspaceId`, so the
// paths here are relative to that prefix.
//
// There is deliberately no READ route: the gate's verdict rides the run itself
// (`ExecutionInstance.inputGate`), which every surface already has in hand from the board
// snapshot and the live stream. A second way to fetch it would be a second thing that can
// disagree with the run the SPA is rendering.
//
// `resolve` answers a parked gate: `recheck` re-evaluates the task as it now stands (which is
// what actually clears the park), `proceed` waives the findings. See InputGateController in
// @cat-factory/orchestration and `docs/initiatives/pre-dispatch-input-gate.md`.
// ---------------------------------------------------------------------------

export const resolveInputGateContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: singleStringParam('executionId'),
  pathResolver: ({ executionId }) => `/executions/${executionId}/input-gate/resolve`,
  requestBodySchema: resolveInputGateSchema,
  responsesByStatusCode: { 200: runInputGateSchema, ...errorResponses },
})
