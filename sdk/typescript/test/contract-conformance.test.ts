// Do the GENERATED types still say what the CONTRACTS say?
//
// The SDK's types are generated from `docs/openapi.json`, which is generated from the Valibot
// route contracts. That is two lossy-looking hops — Valibot → JSON Schema → TypeScript — and
// nothing else in the repo checks that the type a caller ends up holding still matches the schema
// the server validates against. A mapping bug in the emitter (an `anyOf` flattened wrongly, a
// required field emitted optional, a nullable one emitted non-nullable) produces code that
// compiles perfectly and is quietly wrong about the wire.
//
// This file closes that loop WITHOUT coupling the shipped SDK to the contracts:
// `@cat-factory/contracts` is a devDependency, so it is compiled against here and is absent from
// the published package (`files: ["dist"]`). The runtime SDK keeps its zero dependencies, and its
// unknown-field tolerance — a contract-VALIDATING client would strip fields a newer deployment
// added, which is the property we deliberately do not want (see sdk/README.md).
//
// Most of the work here is at COMPILE time: `expectMutuallyAssignable` fails `tsc`, not vitest.
// The one runtime test is the coverage guard, so a DTO added to the spec cannot quietly skip the
// check.

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type * as v from 'valibot'
import * as contracts from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import type * as sdk from '../src/models.generated.ts'

/**
 * Assert that two types describe the same wire shape.
 *
 * MUTUAL assignability, because each direction catches a different bug:
 *  - contract → generated: the SDK can hold everything the server may send. Failing this means a
 *    caller cannot represent a legal response (a field typed too narrowly, or missing).
 *  - generated → contract: the SDK never claims something the contract does not permit. Failing
 *    this means the SDK invites a caller to send a request the server will reject.
 *
 * Deliberately not a strict `Equals<A, B>`: TypeScript's identity check treats `A | B` and its
 * collapsed form as different, and the emitter legitimately widens an open vocabulary (the
 * `taskType` `'feature' | … | (string & {})` pattern) to keep editor completions without
 * narrowing the type to them.
 */
function expectMutuallyAssignable<A extends B, B extends C, C = A>(): void {
  // Type-level only: the constraint above is the assertion. Nothing to do at runtime.
}

// -- The component DTOs, paired with the contract schema each is generated from ----------------
//
// Kept in the same order as `COMPONENT_SCHEMAS` in `scripts/generate-openapi.mjs`, which is the
// table that decides what gets hoisted into `components.schemas` in the first place.

expectMutuallyAssignable<sdk.ErrorResponse, v.InferOutput<typeof contracts.errorResponseSchema>>()
expectMutuallyAssignable<sdk.PublicJob, v.InferOutput<typeof contracts.publicJobSchema>>()
expectMutuallyAssignable<
  sdk.PublicJobAccepted,
  v.InferOutput<typeof contracts.publicJobAcceptedSchema>
>()
expectMutuallyAssignable<
  sdk.CreatePublicJob,
  v.InferOutput<typeof contracts.createPublicJobSchema>
>()
expectMutuallyAssignable<sdk.PublicService, v.InferOutput<typeof contracts.publicServiceSchema>>()
expectMutuallyAssignable<
  sdk.PublicServiceList,
  v.InferOutput<typeof contracts.publicServiceListSchema>
>()
expectMutuallyAssignable<sdk.PublicTask, v.InferOutput<typeof contracts.publicTaskSchema>>()
expectMutuallyAssignable<sdk.PublicTaskList, v.InferOutput<typeof contracts.publicTaskListSchema>>()
expectMutuallyAssignable<
  sdk.CreatePublicTask,
  v.InferOutput<typeof contracts.createPublicTaskSchema>
>()
expectMutuallyAssignable<
  sdk.PublicTaskTicket,
  v.InferOutput<typeof contracts.publicTaskTicketSchema>
>()
expectMutuallyAssignable<
  sdk.PublicTaskSourceDocument,
  v.InferOutput<typeof contracts.publicTaskSourceDocumentSchema>
>()
expectMutuallyAssignable<
  sdk.PublicTaskUploadedDocument,
  v.InferOutput<typeof contracts.publicTaskUploadedDocumentSchema>
>()
expectMutuallyAssignable<
  sdk.PublicTaskDocument,
  v.InferOutput<typeof contracts.publicTaskDocumentSchema>
>()
expectMutuallyAssignable<
  sdk.StartPublicTask,
  v.InferOutput<typeof contracts.startPublicTaskSchema>
>()
expectMutuallyAssignable<
  sdk.UpdatePublicTask,
  v.InferOutput<typeof contracts.updatePublicTaskSchema>
>()
expectMutuallyAssignable<sdk.PublicRun, v.InferOutput<typeof contracts.publicRunSchema>>()
expectMutuallyAssignable<sdk.PublicPipeline, v.InferOutput<typeof contracts.publicPipelineSchema>>()
expectMutuallyAssignable<
  sdk.PublicPipelineList,
  v.InferOutput<typeof contracts.publicPipelineListSchema>
>()
expectMutuallyAssignable<sdk.Notification, v.InferOutput<typeof contracts.notificationSchema>>()
expectMutuallyAssignable<
  sdk.PublicNotificationList,
  v.InferOutput<typeof contracts.publicNotificationListSchema>
>()
expectMutuallyAssignable<sdk.PublicUsageRow, v.InferOutput<typeof contracts.publicUsageRowSchema>>()
expectMutuallyAssignable<
  sdk.PublicUsageBudget,
  v.InferOutput<typeof contracts.publicUsageBudgetSchema>
>()
expectMutuallyAssignable<sdk.PublicUsage, v.InferOutput<typeof contracts.publicUsageSchema>>()
expectMutuallyAssignable<
  sdk.PublicReviewFinding,
  v.InferOutput<typeof contracts.publicReviewFindingSchema>
>()
expectMutuallyAssignable<
  sdk.PublicRequirementsDecision,
  v.InferOutput<typeof contracts.publicRequirementsDecisionSchema>
>()
expectMutuallyAssignable<
  sdk.PublicForkDecision,
  v.InferOutput<typeof contracts.publicForkDecisionSchema>
>()
expectMutuallyAssignable<sdk.PublicDecision, v.InferOutput<typeof contracts.publicDecisionSchema>>()
expectMutuallyAssignable<
  sdk.PublicDecisionList,
  v.InferOutput<typeof contracts.publicDecisionListSchema>
>()
expectMutuallyAssignable<
  sdk.PublicReplyFinding,
  v.InferOutput<typeof contracts.publicReplyFindingSchema>
>()
expectMutuallyAssignable<
  sdk.PublicSetFindingStatus,
  v.InferOutput<typeof contracts.publicSetFindingStatusSchema>
>()
expectMutuallyAssignable<
  sdk.PublicIncorporate,
  v.InferOutput<typeof contracts.publicIncorporateSchema>
>()
expectMutuallyAssignable<
  sdk.PublicResolveExceeded,
  v.InferOutput<typeof contracts.publicResolveExceededSchema>
>()
expectMutuallyAssignable<
  sdk.PublicChooseFork,
  v.InferOutput<typeof contracts.publicChooseForkSchema>
>()
expectMutuallyAssignable<
  sdk.PublicInputGateDecision,
  v.InferOutput<typeof contracts.publicInputGateDecisionSchema>
>()
expectMutuallyAssignable<
  sdk.PublicResolveInputGate,
  v.InferOutput<typeof contracts.publicResolveInputGateSchema>
>()

/** Every DTO asserted above. Compared against the spec so the list cannot fall behind. */
const ASSERTED_COMPONENTS = [
  'ErrorResponse',
  'PublicJob',
  'PublicJobAccepted',
  'CreatePublicJob',
  'PublicService',
  'PublicServiceList',
  'PublicTask',
  'PublicTaskList',
  'PublicTaskTicket',
  'PublicTaskSourceDocument',
  'PublicTaskUploadedDocument',
  'PublicTaskDocument',
  'CreatePublicTask',
  'StartPublicTask',
  'UpdatePublicTask',
  'PublicRun',
  'PublicPipeline',
  'PublicPipelineList',
  'Notification',
  'PublicNotificationList',
  'PublicUsageRow',
  'PublicUsageBudget',
  'PublicUsage',
  'PublicReviewFinding',
  'PublicRequirementsDecision',
  'PublicForkDecision',
  'PublicDecision',
  'PublicDecisionList',
  'PublicReplyFinding',
  'PublicSetFindingStatus',
  'PublicIncorporate',
  'PublicResolveExceeded',
  'PublicChooseFork',
  'PublicInputGateDecision',
  'PublicResolveInputGate',
] as const

describe('generated models conform to the Valibot contracts', () => {
  it('asserts every DTO the spec hoists into components.schemas', async () => {
    // The type-level assertions above are only as good as their coverage: a DTO added to
    // `COMPONENT_SCHEMAS` but not asserted here would silently go unchecked, which is exactly the
    // failure this file exists to prevent. Reading the spec makes the omission a failing test.
    const specPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/openapi.json')
    const spec = JSON.parse(await readFile(specPath, 'utf8')) as {
      components: { schemas: Record<string, unknown> }
    }
    const hoisted = Object.keys(spec.components.schemas).sort()
    const missing = hoisted.filter((name) => !ASSERTED_COMPONENTS.includes(name as never))

    expect(
      missing,
      `these DTOs are in components.schemas but have no conformance assertion in ${'contract-conformance.test.ts'}`,
    ).toEqual([])
  })
})
