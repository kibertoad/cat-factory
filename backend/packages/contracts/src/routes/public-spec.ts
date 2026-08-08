import { defineApiContract } from '@toad-contracts/valibot'
import { publicServiceSpecSchema } from '../public-spec.js'
import { errorResponses, singleStringParam, withMinScope } from './_shared.js'

// ---------------------------------------------------------------------------
// The public SPEC read: absolute `/api/v1` path, authenticated in-controller by a public-API key.
// The wire shape and the reasoning behind it live in `../public-spec.ts`; the honesty contract the
// controller implements (four outcomes, never folded) is in `PublicSpecController`.
//
// Addressed under `/api/v1/services/:serviceId/*`, beside `…/tasks`, because a spec is a fact about
// a SERVICE. The `serviceId` is the board service-frame id every other endpoint on this surface
// already uses, and it resolves through the same board read, so a key can only ever name a service
// of its own workspace.
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
