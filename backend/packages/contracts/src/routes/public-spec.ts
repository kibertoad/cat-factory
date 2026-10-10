import { defineApiContract } from '@toad-contracts/valibot'
import { publicRunSpecSchema, publicServiceSpecSchema } from '../public-spec.js'
import { errorResponses, singleStringParam, withMinScope } from './_shared.js'

// ---------------------------------------------------------------------------
// The public SPEC reads: absolute `/api/v1` paths, authenticated in-controller by a public-API key.
// The wire shapes and the reasoning behind them live in `../public-spec.ts`; the honesty contract
// the controller implements (the outcomes, never folded) is in `PublicSpecController`.
//
// Each is addressed under the resource the question is ABOUT, which is why there are two of them
// rather than one with a `ref` parameter. The service read is a fact about a SERVICE and sits
// beside `…/tasks`; the `serviceId` is the board service-frame id every other endpoint on this
// surface already uses, and it resolves through the same board read, so a key can only ever name a
// service of its own workspace. The run read is a fact about a RUN and sits beside `…/report` and
// `…/outcome`, so criterion to evidence is three GETs on one key.
// ---------------------------------------------------------------------------

/**
 * The service's in-repo specification: the structured requirement tree, the rendered Gherkin, and
 * the ref + commit both were read at.
 *
 * `read` scope, like every other discovery and evidence read here. It is a read of what the
 * service is committed to honouring, and an integration reviewing a run's outcome must be able to
 * see the criteria it was scored against without holding a key that could also merge a pull
 * request.
 *
 * Read-only by design, not by omission: see the note at the top of `../public-spec.ts`.
 */
export const getPublicServiceSpecContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: singleStringParam('serviceId'),
    pathResolver: ({ serviceId }) => `/api/v1/services/${serviceId}/spec`,
    responsesByStatusCode: { 200: publicServiceSpecSchema, ...errorResponses },
  }),
)

/**
 * The specification ONE RUN was judged against, read from the branch that run pushed its work to.
 *
 * The sibling of {@link getPublicServiceSpecContract}, and the reason it is a sibling rather than a
 * query parameter is the reason the internal pair already splits: they answer different questions,
 * and a caller that asked the first while meaning the second got a document missing exactly the
 * requirements the run had added. Every verdict naming one of those landed as unjoinable.
 *
 * `read` scope, and addressed under `/api/v1/runs/:runId/*` beside `…/report` and `…/outcome`, so
 * the requirement ids on those two and the criteria they were scored against are three GETs on one
 * key rather than a repository clone.
 */
export const getPublicRunSpecContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: singleStringParam('runId'),
    pathResolver: ({ runId }) => `/api/v1/runs/${runId}/spec`,
    responsesByStatusCode: { 200: publicRunSpecSchema, ...errorResponses },
  }),
)
