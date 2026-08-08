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
expectMutuallyAssignable<
  sdk.NotificationWebhook,
  v.InferOutput<typeof contracts.notificationWebhookSchema>
>()
expectMutuallyAssignable<
  sdk.PublicNotificationWebhook,
  v.InferOutput<typeof contracts.publicNotificationWebhookSchema>
>()
expectMutuallyAssignable<
  sdk.PublicNotificationWebhookList,
  v.InferOutput<typeof contracts.publicNotificationWebhookListSchema>
>()
expectMutuallyAssignable<
  sdk.PutNotificationWebhook,
  v.InferOutput<typeof contracts.putNotificationWebhookSchema>
>()
expectMutuallyAssignable<sdk.PublicUsageRow, v.InferOutput<typeof contracts.publicUsageRowSchema>>()
expectMutuallyAssignable<
  sdk.PublicUsageBudget,
  v.InferOutput<typeof contracts.publicUsageBudgetSchema>
>()
expectMutuallyAssignable<sdk.PublicUsage, v.InferOutput<typeof contracts.publicUsageSchema>>()
expectMutuallyAssignable<sdk.PublicSpendRow, v.InferOutput<typeof contracts.publicSpendRowSchema>>()
expectMutuallyAssignable<
  sdk.PublicSpendTotals,
  v.InferOutput<typeof contracts.publicSpendTotalsSchema>
>()
expectMutuallyAssignable<sdk.PublicSpend, v.InferOutput<typeof contracts.publicSpendSchema>>()
expectMutuallyAssignable<sdk.PublicIdentity, v.InferOutput<typeof contracts.publicIdentitySchema>>()
expectMutuallyAssignable<
  sdk.PublicUnanswerableWait,
  v.InferOutput<typeof contracts.publicUnanswerableWaitSchema>
>()
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
expectMutuallyAssignable<
  sdk.PublicApprovalGateDecision,
  v.InferOutput<typeof contracts.publicApprovalGateDecisionSchema>
>()
expectMutuallyAssignable<
  sdk.PublicApproveStep,
  v.InferOutput<typeof contracts.publicApproveStepSchema>
>()
expectMutuallyAssignable<
  sdk.PublicRequestStepChanges,
  v.InferOutput<typeof contracts.publicRequestStepChangesSchema>
>()
expectMutuallyAssignable<
  sdk.PublicRejectStep,
  v.InferOutput<typeof contracts.publicRejectStepSchema>
>()
expectMutuallyAssignable<
  sdk.PublicAgentDecision,
  v.InferOutput<typeof contracts.publicAgentDecisionSchema>
>()
expectMutuallyAssignable<
  sdk.PublicResolveAgentDecision,
  v.InferOutput<typeof contracts.publicResolveAgentDecisionSchema>
>()
expectMutuallyAssignable<
  sdk.PublicClarityDecision,
  v.InferOutput<typeof contracts.publicClarityDecisionSchema>
>()
expectMutuallyAssignable<
  sdk.PublicBrainstormDecision,
  v.InferOutput<typeof contracts.publicBrainstormDecisionSchema>
>()
expectMutuallyAssignable<
  sdk.PublicPrReviewDecision,
  v.InferOutput<typeof contracts.publicPrReviewDecisionSchema>
>()
expectMutuallyAssignable<
  sdk.PublicResolvePrReview,
  v.InferOutput<typeof contracts.publicResolvePrReviewSchema>
>()
expectMutuallyAssignable<
  sdk.PublicChallengePrReviewFinding,
  v.InferOutput<typeof contracts.publicChallengePrReviewFindingSchema>
>()
expectMutuallyAssignable<
  sdk.PublicHumanTestEnvironment,
  v.InferOutput<typeof contracts.publicHumanTestEnvironmentSchema>
>()
expectMutuallyAssignable<
  sdk.PublicHumanTestDecision,
  v.InferOutput<typeof contracts.publicHumanTestDecisionSchema>
>()
expectMutuallyAssignable<
  sdk.PublicVisualConfirmDecision,
  v.InferOutput<typeof contracts.publicVisualConfirmDecisionSchema>
>()
// Follow-up triage and the interview gates. The two nested item shapes are pinned beside their
// decisions rather than only through them: both are hoisted DTOs a caller names directly when it
// writes the triage loop, and a widened `kind`/`status` on an item would otherwise be invisible
// here while being exactly what a caller branches on.
expectMutuallyAssignable<
  sdk.PublicFollowUpItem,
  v.InferOutput<typeof contracts.publicFollowUpItemSchema>
>()
expectMutuallyAssignable<
  sdk.PublicFollowUpsDecision,
  v.InferOutput<typeof contracts.publicFollowUpsDecisionSchema>
>()
expectMutuallyAssignable<
  sdk.PublicInterviewQuestion,
  v.InferOutput<typeof contracts.publicInterviewQuestionSchema>
>()
expectMutuallyAssignable<
  sdk.PublicInterviewDecision,
  v.InferOutput<typeof contracts.publicInterviewDecisionSchema>
>()
expectMutuallyAssignable<
  sdk.PublicRequestGateFix,
  v.InferOutput<typeof contracts.publicRequestGateFixSchema>
>()
expectMutuallyAssignable<
  sdk.PublicAnswerFollowUp,
  v.InferOutput<typeof contracts.publicAnswerFollowUpSchema>
>()
expectMutuallyAssignable<
  sdk.PublicAnswerInterview,
  v.InferOutput<typeof contracts.publicAnswerInterviewSchema>
>()

// Public-API KEYS: the provisioning surface's own resource. `PublicApiKey` is shared with the
// session-authed key panel, so this pairing also pins that the two surfaces describe one key.
expectMutuallyAssignable<sdk.PublicApiKey, v.InferOutput<typeof contracts.publicApiKeySchema>>()
expectMutuallyAssignable<
  sdk.PublicApiKeyList,
  v.InferOutput<typeof contracts.publicApiKeyListResultSchema>
>()
expectMutuallyAssignable<
  sdk.CreatedPublicApiKey,
  v.InferOutput<typeof contracts.createdPublicApiKeySchema>
>()
expectMutuallyAssignable<
  sdk.CreateHeadlessPublicApiKey,
  v.InferOutput<typeof contracts.createHeadlessPublicApiKeySchema>
>()

// Run EVIDENCE. The verification report is the one DTO here the SDK did not gain a new shape for:
// it is the ENGINE's own report type, served verbatim, so this pairing is what proves the wire
// shape a consumer parses is the one the engine composes rather than a re-typed copy of it.
expectMutuallyAssignable<
  sdk.PublicRunArtifact,
  v.InferOutput<typeof contracts.publicRunArtifactSchema>
>()
expectMutuallyAssignable<
  sdk.PublicRunArtifactList,
  v.InferOutput<typeof contracts.publicRunArtifactListSchema>
>()
expectMutuallyAssignable<
  sdk.PrVerificationReport,
  v.InferOutput<typeof contracts.prVerificationReportSchema>
>()
expectMutuallyAssignable<sdk.PrReportRun, v.InferOutput<typeof contracts.prReportRunSchema>>()
expectMutuallyAssignable<
  sdk.PrReportContext,
  v.InferOutput<typeof contracts.prReportContextSchema>
>()
expectMutuallyAssignable<
  sdk.PrReportContextDocument,
  v.InferOutput<typeof contracts.prReportContextDocumentSchema>
>()
// Hoisted because it is a VARIANT reached from two sections (the report's `context` and the
// outcome's `sources`), so left inline it would ship twice under two positional names that
// RENUMBER if the union's members are reordered.
expectMutuallyAssignable<
  sdk.DocumentFreshness,
  v.InferOutput<typeof contracts.documentFreshnessSchema>
>()
expectMutuallyAssignable<sdk.PrReportStep, v.InferOutput<typeof contracts.prReportStepSchema>>()
expectMutuallyAssignable<sdk.PrReportIssue, v.InferOutput<typeof contracts.prReportIssueSchema>>()
expectMutuallyAssignable<sdk.PrReportCi, v.InferOutput<typeof contracts.prReportCiSchema>>()
expectMutuallyAssignable<sdk.PrReportCheck, v.InferOutput<typeof contracts.prReportCheckSchema>>()
expectMutuallyAssignable<
  sdk.PrReportValidation,
  v.InferOutput<typeof contracts.prReportValidationSchema>
>()
expectMutuallyAssignable<
  sdk.PrReportValidationCommand,
  v.InferOutput<typeof contracts.prReportValidationCommandSchema>
>()
expectMutuallyAssignable<
  sdk.PrReportReproduction,
  v.InferOutput<typeof contracts.prReportReproductionSchema>
>()
expectMutuallyAssignable<sdk.PrReportTests, v.InferOutput<typeof contracts.prReportTestsSchema>>()
expectMutuallyAssignable<
  sdk.PrReportTestOutcome,
  v.InferOutput<typeof contracts.prReportTestOutcomeSchema>
>()
expectMutuallyAssignable<
  sdk.PrReportTestConcern,
  v.InferOutput<typeof contracts.prReportTestConcernSchema>
>()
expectMutuallyAssignable<
  sdk.PrReportRequirements,
  v.InferOutput<typeof contracts.prReportRequirementsSchema>
>()
expectMutuallyAssignable<
  sdk.PrReportEnvironments,
  v.InferOutput<typeof contracts.prReportEnvironmentsSchema>
>()
expectMutuallyAssignable<sdk.PrReportMerge, v.InferOutput<typeof contracts.prReportMergeSchema>>()
expectMutuallyAssignable<sdk.PrReportJudges, v.InferOutput<typeof contracts.prReportJudgesSchema>>()
expectMutuallyAssignable<sdk.PrReportJudge, v.InferOutput<typeof contracts.prReportJudgeSchema>>()
expectMutuallyAssignable<
  sdk.PrReportObservability,
  v.InferOutput<typeof contracts.prReportObservabilitySchema>
>()

// The nested projections a `pr-review` / `visual-confirmation` decision carries. The emitter
// inlines them rather than hoisting them into `components.schemas`, so the coverage guard below
// cannot see them, and inlined is exactly where a mapping bug hides, since nothing else names
// the type. Asserted explicitly against the contract they come from.
expectMutuallyAssignable<
  sdk.PublicPrReviewDecisionSlice,
  v.InferOutput<typeof contracts.publicPrReviewSliceSchema>
>()
expectMutuallyAssignable<
  sdk.PublicPrReviewDecisionFinding,
  v.InferOutput<typeof contracts.publicPrReviewFindingSchema>
>()
expectMutuallyAssignable<
  sdk.PublicPrReviewDecisionFindingChallenge,
  v.InferOutput<typeof contracts.publicPrReviewFindingChallengeSchema>
>()
expectMutuallyAssignable<
  sdk.PublicVisualConfirmDecisionPair,
  v.InferOutput<typeof contracts.publicVisualConfirmPairSchema>
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
  'NotificationWebhook',
  'PublicNotificationWebhook',
  'PublicNotificationWebhookList',
  'PutNotificationWebhook',
  'PublicUsageRow',
  'PublicUsageBudget',
  'PublicUsage',
  'PublicSpendRow',
  'PublicSpendTotals',
  'PublicSpend',
  'PublicIdentity',
  'PublicUnanswerableWait',
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
  'PublicApprovalGateDecision',
  'PublicApproveStep',
  'PublicRequestStepChanges',
  'PublicRejectStep',
  'PublicAgentDecision',
  'PublicResolveAgentDecision',
  'PublicClarityDecision',
  'PublicBrainstormDecision',
  'PublicPrReviewDecision',
  'PublicResolvePrReview',
  'PublicChallengePrReviewFinding',
  'PublicHumanTestEnvironment',
  'PublicHumanTestDecision',
  'PublicVisualConfirmDecision',
  'PublicFollowUpItem',
  'PublicFollowUpsDecision',
  'PublicInterviewQuestion',
  'PublicInterviewDecision',
  'PublicRequestGateFix',
  'PublicAnswerFollowUp',
  'PublicAnswerInterview',
  'PublicApiKey',
  'PublicApiKeyList',
  'CreatedPublicApiKey',
  'CreateHeadlessPublicApiKey',
  'PublicRunArtifact',
  'PublicRunArtifactList',
  'PrVerificationReport',
  'PrReportRun',
  'PrReportContext',
  'PrReportContextDocument',
  'DocumentFreshness',
  'PrReportStep',
  'PrReportIssue',
  'PrReportCi',
  'PrReportCheck',
  'PrReportValidation',
  'PrReportValidationCommand',
  'PrReportReproduction',
  'PrReportTests',
  'PrReportTestOutcome',
  'PrReportTestConcern',
  'PrReportRequirements',
  'PrReportEnvironments',
  'PrReportMerge',
  'PrReportJudges',
  'PrReportJudge',
  'PrReportObservability',
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
