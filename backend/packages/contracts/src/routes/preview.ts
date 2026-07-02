import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import { previewStateSchema } from '../preview.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Browsable frontend preview route contracts (slice 5c). Mounted under
// `/workspaces/:workspaceId`, so the paths here are relative to that prefix.
// See PreviewController. Gated server-side on `frontendPreview.supported`
// (503 when the runtime can't host a long-lived preview, e.g. the Worker).
// ---------------------------------------------------------------------------

const frameIdParams = singleStringParam('frameId')

export const getPreviewContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: frameIdParams,
  pathResolver: ({ frameId }) => `/frames/${frameId}/preview`,
  responsesByStatusCode: { 200: previewStateSchema, ...errorResponses },
})

export const startPreviewContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: frameIdParams,
  pathResolver: ({ frameId }) => `/frames/${frameId}/preview`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 201: previewStateSchema, ...errorResponses },
})

export const stopPreviewContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: frameIdParams,
  pathResolver: ({ frameId }) => `/frames/${frameId}/preview`,
  responsesByStatusCode: { 200: previewStateSchema, ...errorResponses },
})
