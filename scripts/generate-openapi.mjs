// Generate an OpenAPI 3.1 document for the external public API (`/api/v1/*`) from the
// Valibot route contracts in `@cat-factory/contracts`, and write it to `docs/openapi.json`.
//
// No OpenAPI emitter ships in `@toad-contracts/*`, so this is a small purpose-built
// generator, twinned with `scripts/check-openapi.mjs` (the CI drift guard) exactly like
// `sync-runner-image-tags.mjs` ⇄ `check-runner-image-tag.mjs`. It covers ONLY the
// `/api/v1` surface (the external, key-authenticated API) — not the ~360 internal
// session-authed contracts. The generator filters by the resolved `/api/v1` path, so any
// future public endpoint added to that surface is picked up automatically.
//
// Prereqs: the contracts package must be BUILT first (it imports the compiled `dist`), so
// run `pnpm build` before `pnpm gen:openapi`.

import { writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { toJsonSchema, toJsonSchemaDefs } from '@valibot/to-json-schema'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONTRACTS_DIST = resolve(repoRoot, 'backend/packages/contracts/dist/index.js')
export const OPENAPI_PATH = resolve(repoRoot, 'docs/openapi.json')

/**
 * The SERVED copy of the same document: `GET /api/v1/openapi.json` hands these bytes back.
 *
 * A generated TS module rather than a runtime read of `docs/openapi.json`, because neither
 * facade can reach that path — the Worker is a bundle with no filesystem, and the published
 * `@cat-factory/server` ships `dist` alone. It holds the spec as ONE string constant rather than
 * an object literal for two reasons: the endpoint answers with bytes, so there is nothing to
 * re-serialise (and therefore no way for the served document to differ from the committed one),
 * and a 360 KB object literal would cost every `tsc` run its structural check for no gain.
 *
 * Both outputs come from one `buildOpenApiDoc()` call and `check:openapi` diffs both, so they
 * cannot drift from the contracts or from each other. The `.generated.ts` suffix is load-bearing:
 * it is what `.oxfmtrc.json` and `.oxlintrc.json` already exempt, and a formatter reflowing this
 * file would put it permanently at odds with its own drift guard.
 */
export const SERVED_OPENAPI_PATH = resolve(
  repoRoot,
  'backend/packages/server/src/modules/publicApi/openapiDocument.generated.ts',
)

const API_PREFIX = '/api/v1'

// The document's `info.version` describes the PUBLIC API surface (`/api/v1`), NOT the npm
// package release. It is deliberately DECOUPLED from any `package.json` version: those bump on
// every changesets release with no bearing on the API contract, and baking one in would make the
// committed `docs/openapi.json` go stale on every release — the drift guard (`check:openapi`)
// would then fail spuriously on the next PR that merges a release, even when no contract changed.
//
// The public API is STABLE (see CLAUDE.md "The public API is stable"): additive changes bump the
// minor here; a breaking change is not allowed on `/api/v1` at all: it means a new `/api/v2`
// prefix served beside v1 through a deprecation window, and a new spec version with it.
// NOTE when rebasing/merging: this line COLLIDES silently. A branch that bumps the minor and a
// main that bumps it to the same number produce byte-identical text, so git auto-merges them with
// no conflict and the branch ships a DIFFERENT surface under a version main already used. Re-check
// this against `origin/main` after every merge rather than trusting a clean one.
// 1.12.0: `PrReportValidation.configUnreadable`, an additive optional field on the run report,
// so a consumer built against 1.11.0 keeps parsing.
// 1.13.0, not 1.12.0: additive only, on the run-debugging surface (a new `ok` filter on the
// tool-call list and a `toolCalls` rollup on the run overview), but main reached 1.12.0 with
// `configUnreadable` while this branch was in flight. The collision note above, arriving exactly
// as it describes: both sides wrote the same number, so the VERSION line auto-merged clean and
// only the comment beside it conflicted. Re-checked against `origin/main` rather than trusting
// that clean merge.
// 1.14.0: additive only, an optional `modelPin` on the report's judge verdicts (which model the
// rubric was authored for, and whether the run got it). Third number that change held: it was
// written against 1.12.0, moved to 1.13.0 when the validation field took that, and again once the
// debug surface took 1.13.0. Every one of those was found by re-reading this line after a merge,
// which is the only thing that catches it.
// 1.15.0, not 1.12.0: `GET /api/v1/me` and `unanswerable[]` on the decision list, both additive,
// written against a main that was still on 1.11.0. Four numbers have gone past this branch while
// it was in flight (`configUnreadable`, the run-debugging surface, the judge model pin, and the
// release that published them), so it takes the next free one. Nothing about that is unusual any
// more, which is the point of the note at the top of this block: on a repo landing this many
// additive changes, a clean auto-merge of the VERSION line is the normal way to ship a number
// someone else already published. Re-read it against `origin/main` every time.
// 1.16.0, not 1.15.0: the run report gains an optional `scope`, naming WHICH of a multi-repo run's
// pull requests a given copy is written onto. Additive: a consumer written against 1.15 reads every
// field it knows, and an absent `scope` means what it always meant (the own-service PR). FIFTH
// number this one addition has held (1.12 → 1.13 → 1.14 → 1.15 → 1.16), and 1.15 was taken by the
// `/me` endpoint landing on main while this branch was in flight, caught by re-reading this line
// after the merge rather than by trusting a clean auto-merge of the VERSION itself.
// 1.17.0, not 1.15.0: the tool-call list's `?ok=true|false` filter is REPLACED by
// `?outcome=ok|error`, the same param name and vocabulary the llm-call list already uses. This is
// a MINOR for a change that is technically breaking, taken deliberately: `?ok=` existed for one
// release, has no known consumer, and the two drill-downs answering the same question under two
// spellings is the wart the change exists to remove. A picklist also lets the set gain a member (a
// timeout, a refusal) where `true|false` could only be retyped. If an adopter turns up before this
// lands, the honest shape is `?ok=` served beside `?outcome=` for a release, not a rename.
//
// This branch reserved 1.17.0 while 1.16.0 was still unlanded, on the reasoning that the multi-repo
// verification-report branch held it and two branches sitting on the same number auto-merge the
// VERSION line byte-identically, conflicting only in this comment: the silent failure the note at
// the top of this block describes. That branch has since merged, so 1.16.0 is main's published
// number and 1.17.0 is simply the next free one. Re-read against `origin/main` anyway.
// 1.18.0, not 1.17.0: `GET /api/v1/task-types` plus `fields` on task creation, both additive (a new
// endpoint and a new optional key). THIRD number this one addition has held: written against
// 1.16.0, moved to 1.17.0 when the multi-repo report `scope` took 1.16.0 on main, and moved again
// when the `?outcome=` rename above published 1.17.0 on main while this branch was in flight. Both
// moves were found the same way, and it is the only way that works: by re-reading this line after
// the merge, never by trusting that the VERSION itself auto-merged clean (it did, twice, to a
// number main had already used).
// 1.19.0, not 1.18.0: attaching a document by REFERENCE gains two `error.details.reason` values on
// its 422, `document_ref_unrecognized` and `document_ref_claimed_by_other_source` (the public create
// resolves every ref through the same service the app's attach pre-flight calls). Additive: a
// consumer that branches on nothing still sees the same status and message, and one that does gains
// two codes to branch on. The reason VOCABULARY is part of the stable surface, which is why a new
// member is a version step at all, and why `public-api.md` names both codes rather than describing
// the refusal only in prose. 1.18.0 is main's published number as of this branch's last merge.
// 1.20.0, not 1.19.0: a descriptor field on `GET /api/v1/task-types` may carry an optional `section`,
// the grouping caption a long operation form is rendered under. Additive, and inert for a headless
// caller: it groups nothing the create call validates, so a client that ignores it fills exactly the
// same bag as before, and one that renders a form gains the author's own grouping. 1.19.0 is main's
// published number as of this branch's last merge; re-read this line after any merge rather than
// trusting that the VERSION auto-merged clean.
// 1.21.0, not 1.20.0: each step of `GET /api/v1/debug/runs/:runId` may carry `toolServers`, what
// the step's dispatch wired and what it dropped with the reason. Additive, and it is the
// REPLACEMENT half of a deprecation: the same facts sat in the agent-context snapshot's untyped
// `extras` bag, which keeps serving them until the window in `public-api.md` closes, so no
// consumer has to move on this version. 1.20.0 is main's published number as of this branch's last
// merge; re-read this line after any merge rather than trusting that the VERSION auto-merged clean.
// 1.24.0: `PATCH /api/v1/tasks/:taskId` accepts `fields`, the task's per-type bag, merged over
// what the task already carries. Additive (a new optional request field; a caller that never sends
// one is unaffected), and it is what makes the pre-dispatch input gate's findings FIXABLE
// headlessly: four of its seven codes name a field of that bag, and until now the surface named a
// remedy it did not offer.
//
// 1.22.0 belongs to `GET /api/v1/runs/:runId/outcome` and the verification report's new optional
// `requirements.unmatchedVerdicts`. Two diffs claiming one number is a lie a consumer pinning
// the version would act on, so re-read this line after any merge rather than trusting that the
// VERSION auto-merged clean.
// 1.24.0, not 1.23.0: `PATCH /api/v1/tasks/:taskId` accepts `fields`, the task's per-type bag,
// merged over what the task already carries. Additive (a new optional request field; a caller that
// never sends one is unaffected), and it is what makes the pre-dispatch input gate's findings
// FIXABLE headlessly: four of its seven codes name a field of that bag, and until now the surface
// named a remedy it did not offer. This branch first claimed 1.23.0, which main then published for
// `x-min-scope` while the branch was in flight: the collision surfaced as a conflict on this
// comment block only because each version step writes its own paragraph here, never as one on the
// VERSION line, which auto-merges clean to a number main has already used.
// 1.25.0, not 1.24.0: `gitlab` joins the `TaskSourceKind` enum, GitLab Issues being a fourth
// built-in task source. Additive on a CLOSED vocabulary, which is the shape the SDKs are built to
// tolerate: they map an unknown enum member through rather than refusing it, so a client compiled
// against 1.24.0 keeps parsing every response it already understood and simply never asks for the
// new source. No existing member changes meaning and no persisted `source` value moves.
// 1.26.0, not 1.22.0: a step's `toolServers` on `GET /api/v1/debug/runs/:runId` gains an optional
// `observed`, the agent CLI's own account of the servers it managed to load beside the `wired` /
// `unavailable` account of what the platform decided. Additive: a consumer written against 1.21.0
// reads both existing lists unchanged, and an ABSENT `observed` is not an empty one: it means no
// observation was made (a harness whose CLI publishes no such report, an older runner image, an
// unmapped runner pool), which is a distinction a consumer has to keep or it will report working
// servers as dead.
//
// FIFTH number this one addition has held: written against 1.21.0 (the number the `toolServers`
// record itself took), then displaced in turn by the run outcome endpoint, `x-min-scope`, the
// task-`fields` patch and the GitLab source above, each published by main while this branch was in
// flight. Not one of the five announced itself on the VERSION line, which auto-merged clean every
// time to the number main had just used; every one surfaced as a conflict in THIS comment block,
// only because each version step writes its own paragraph here. That is the whole reason the
// paragraphs exist, and it is why the note at the top of the block says to re-read this line after
// every merge rather than trust a clean one.
//
// 1.27.0: the verification report gains a `context` section and the run outcome summary a
// `sources` one, both saying which linked pages a run's agents read and at which revision.
// Additive on both surfaces (a new section object beside the existing ones, on two endpoints and
// inside the PR body's fenced block), and inert for a consumer that ignores it: every section it
// already reads is byte-for-byte unchanged. `PR_VERIFICATION_REPORT_VERSION` steps to 9 and
// `RUN_OUTCOME_VERSION` to 2 with it.
//
// 1.28.0, not 1.26.0: the outbound webhook becomes a COLLECTION,
// `GET /api/v1/notification-webhooks` plus `GET|PUT|DELETE /api/v1/notification-webhooks/:webhookId`,
// beside the singular routes, which keep working and now address the `default` entry. Additive on
// every axis: four new operations, and two new fields (`id`, `name`) on a response projection a
// consumer already tolerates unknown members of. FOURTH number this one has held: it claimed
// 1.25.0, then 1.26.0, then 1.27.0, each published by main while the branch was in flight, and not
// one of them announced itself on the VERSION line, which auto-merged clean to a number main had
// already used every time. Re-read this line here, not there, after every merge.
//
// 1.29.0, not 1.28.0: a run's `diagnostics.lastDispatch` gains a `failure` object, and is now
// stamped for INLINE steps as well as container ones. Additive on the wire: the new object is
// present only on a dispatch that never reached a running job, `executionBackend` gains one
// further value (`inline`) in a field already documented as free-form, and every existing field
// is byte-for-byte unchanged. What DOES change for a consumer is the population: a pure-inline run
// used to answer `diagnostics: null` on the debug overview and now answers a block, so a client
// treating "no diagnostics" as "no agent work happened" reads differently. That is the point of
// the change, and it is stated here rather than left for a reader to discover.
//
// SEVENTH number for this one, displaced by the same five as the `observed` paragraph above plus
// its own `toolServers` CLI record and the webhook collection. Two long-lived branches losing this
// race independently is the case for reading the note at the top of the block rather than treating
// it as history.
//
// 1.30.0, not 1.29.0: `POST /api/v1/keys` accepts an opaque `externalIdentity`, the identity a
// provisioner is minting a key FOR, echoed on the key resource, on `GET /api/v1/me`, and on the
// run projections as the identity the run was started for. Additive on every axis: one optional
// request field, one nullable response field, and `null` is what every run and key that predates
// it correctly reports. This branch first claimed 1.29.0, which main then published for the
// dispatch-`failure` diagnostics above while the branch was in flight: the SECOND number this one
// has held, and it surfaced here rather than on the VERSION line, which auto-merged clean to the
// number main had just used. Re-read this line after any merge rather than trusting that.
//
// 1.31.0, not 1.30.0: board PROVISIONING and the relationships that outlive a create. Seven new
// operations (`GET /api/v1/repos`, `POST /api/v1/services`, the two dependency writes, and the
// three task-document routes), two new optional request fields (`autoStartDependents` on the task
// patch), and three new response fields (`dependsOn` and `autoStartDependents` on the task
// projection, `scope` on a run artifact, `output` and `data` on a run step). Additive on every
// axis: nothing is renamed, retyped or re-scoped, and a consumer built against 1.30.0 keeps
// parsing every response it already understood.
//
// One population change is worth stating rather than leaving for a reader to discover, because it
// is the point of one of the slices: `GET /api/v1/runs/:runId/artifacts` now returns the reference
// designs attached to the run's TASK alongside the artifacts the run captured, each row saying
// which it is. A consumer counting rows off that list to mean "screenshots this run captured" must
// filter on `scope: 'run'`; one comparing a screenshot against the design it was judged against
// finally has both, which is why the list was half the truth before.
// 1.32.0: the two cost/telemetry reads that were reachable only from a browser session. Two new
// operations (`GET /api/v1/usage/spend`, `GET /api/v1/debug/runs/{runId}/llm-export`), no change
// to anything already served. Additive on every axis, so a consumer built against 1.31.0 keeps
// parsing every response it already understood.
//
// Worth stating for a reader comparing the new spend read against `GET /api/v1/usage`: the two
// answer different questions off the same ledger and will not tie out. `/usage` is the current
// calendar month against the budget; `/usage/spend` is a rolling window snapped to a bucket edge,
// and on `30d`/`90d` it is served from the durable rollup, whose attribution was frozen while the
// money was spent. `source` and `since` on the response are what say which is talking.
const API_VERSION = '1.32.0'

/**
 * The media types the artifact-blob route can answer with: the image allow-list it clamps a
 * stored content type to, plus the octet-stream it falls back to for a row it does not recognise
 * (which it also serves as an attachment, so nothing executes).
 *
 * Stated here because the blob endpoint is documented by hand rather than from a route contract,
 * and kept honest by `blobMediaTypes.spec.ts`, which asserts this set IS the server's own
 * allow-list. A spec that names one type while the server sends another is a lie a third-party
 * client generated from this document would act on.
 */
const BLOB_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/octet-stream',
]

/** OpenAPI's spelling of "opaque bytes". */
const BINARY_SCHEMA = { type: 'string', format: 'binary' }

/**
 * Named DTOs hoisted into `components.schemas` (so client codegen gets named types and
 * shared schemas aren't inlined N times): OpenAPI component name → the exported Valibot
 * schema's name in `@cat-factory/contracts`.
 */
const COMPONENT_SCHEMAS = {
  ErrorResponse: 'errorResponseSchema',
  PublicJob: 'publicJobSchema',
  PublicJobAccepted: 'publicJobAcceptedSchema',
  CreatePublicJob: 'createPublicJobSchema',
  PublicService: 'publicServiceSchema',
  PublicServiceList: 'publicServiceListSchema',
  PublicTask: 'publicTaskSchema',
  PublicTaskList: 'publicTaskListSchema',
  CreatePublicTask: 'createPublicTaskSchema',
  PublicTaskTicket: 'publicTaskTicketSchema',
  // Both variants are hoisted beside the union, exactly as the parked-decision variants are:
  // an un-hoisted member is emitted as an anonymous `Variant0`/`Variant1` in every generated
  // client, which is not a name an integrator should have to read.
  PublicTaskSourceDocument: 'publicTaskSourceDocumentSchema',
  PublicTaskUploadedDocument: 'publicTaskUploadedDocumentSchema',
  PublicTaskDocument: 'publicTaskDocumentSchema',
  StartPublicTask: 'startPublicTaskSchema',
  UpdatePublicTask: 'updatePublicTaskSchema',
  PublicRun: 'publicRunSchema',
  PublicPipeline: 'publicPipelineSchema',
  PublicPipelineList: 'publicPipelineListSchema',
  Notification: 'notificationSchema',
  PublicNotificationList: 'publicNotificationListSchema',
  // The outbound webhook's own configuration, shared with the session-authed surface: the read
  // wrapper, the projection inside it (also the write's response) and the write body.
  NotificationWebhook: 'notificationWebhookSchema',
  PublicNotificationWebhook: 'publicNotificationWebhookSchema',
  PublicNotificationWebhookList: 'publicNotificationWebhookListSchema',
  PutNotificationWebhook: 'putNotificationWebhookSchema',
  PublicUsageRow: 'publicUsageRowSchema',
  PublicUsageBudget: 'publicUsageBudgetSchema',
  PublicUsage: 'publicUsageSchema',
  // The spend breakdown, hoisted beside its budget sibling and for the same reason. Left inline
  // it ships as `GetPublicSpendResponse` / `…ResponseRow` / `…ResponseTotals` in four languages:
  // names derived from an operationId rather than from the resource, which is what an integrator
  // ends up writing its code against. The picklists these carry are NOT hoisted (a bare enum
  // renders as an empty `interface`); they are pinned by value-set in `scripts/sdk/ir.mjs`.
  PublicSpendRow: 'publicSpendRowSchema',
  PublicSpendTotals: 'publicSpendTotalsSchema',
  PublicSpend: 'publicSpendSchema',
  PublicIdentity: 'publicIdentitySchema',
  // Parked decisions. `PublicDecisionList` is the response of EVERY decision route, and it
  // transitively carries the full finding + fork-option + PR-finding shapes — hoisting it (and the
  // members of its variant) keeps the spec from inlining tens of KB per operation.
  PublicReviewFinding: 'publicReviewFindingSchema',
  PublicRequirementsDecision: 'publicRequirementsDecisionSchema',
  PublicForkDecision: 'publicForkDecisionSchema',
  PublicInputGateDecision: 'publicInputGateDecisionSchema',
  PublicApprovalGateDecision: 'publicApprovalGateDecisionSchema',
  PublicAgentDecision: 'publicAgentDecisionSchema',
  PublicClarityDecision: 'publicClarityDecisionSchema',
  PublicBrainstormDecision: 'publicBrainstormDecisionSchema',
  PublicPrReviewDecision: 'publicPrReviewDecisionSchema',
  PublicHumanTestEnvironment: 'publicHumanTestEnvironmentSchema',
  PublicHumanTestDecision: 'publicHumanTestDecisionSchema',
  PublicVisualConfirmDecision: 'publicVisualConfirmDecisionSchema',
  PublicFollowUpItem: 'publicFollowUpItemSchema',
  PublicFollowUpsDecision: 'publicFollowUpsDecisionSchema',
  PublicInterviewQuestion: 'publicInterviewQuestionSchema',
  PublicInterviewDecision: 'publicInterviewDecisionSchema',
  PublicUnanswerableWait: 'publicUnanswerableWaitSchema',
  PublicDecision: 'publicDecisionSchema',
  PublicDecisionList: 'publicDecisionListSchema',
  PublicReplyFinding: 'publicReplyFindingSchema',
  PublicSetFindingStatus: 'publicSetFindingStatusSchema',
  PublicIncorporate: 'publicIncorporateSchema',
  PublicResolveExceeded: 'publicResolveExceededSchema',
  PublicChooseFork: 'publicChooseForkSchema',
  PublicResolveInputGate: 'publicResolveInputGateSchema',
  PublicApproveStep: 'publicApproveStepSchema',
  PublicRequestStepChanges: 'publicRequestStepChangesSchema',
  PublicRejectStep: 'publicRejectStepSchema',
  PublicResolveAgentDecision: 'publicResolveAgentDecisionSchema',
  PublicResolvePrReview: 'publicResolvePrReviewSchema',
  PublicChallengePrReviewFinding: 'publicChallengePrReviewFindingSchema',
  PublicRequestGateFix: 'publicRequestGateFixSchema',
  PublicAnswerFollowUp: 'publicAnswerFollowUpSchema',
  PublicAnswerInterview: 'publicAnswerInterviewSchema',
  // Run EVIDENCE. The verification report is served VERBATIM (the same shape the engine writes
  // into the pull-request body), so its sections are hoisted individually rather than left to be
  // named positionally: these types are what a consumer of this API writes its code against, and
  // `PrVerificationReportRunStepsItem` is not a name anyone should have to read. Every one of
  // them is an exported schema in `@cat-factory/contracts`, so the names are chosen once here and
  // the shapes cannot drift from what the engine composes.
  // The key resource, hoisted for the same reason every other DTO here is: un-hoisted, the
  // provisioning surface ships as `ListPublicKeysResponseKey` and `CreatePublicKeyRequestScope`
  // in four languages: positional names that also RENUMBER if an operation is added ahead of
  // them.
  PublicApiKey: 'publicApiKeySchema',
  PublicApiKeyList: 'publicApiKeyListResultSchema',
  CreatedPublicApiKey: 'createdPublicApiKeySchema',
  CreateHeadlessPublicApiKey: 'createHeadlessPublicApiKeySchema',
  PublicRunArtifact: 'publicRunArtifactSchema',
  PublicRunArtifactList: 'publicRunArtifactListSchema',
  PrVerificationReport: 'prVerificationReportSchema',
  PrReportRun: 'prReportRunSchema',
  PrReportStep: 'prReportStepSchema',
  PrReportIssue: 'prReportIssueSchema',
  PrReportCi: 'prReportCiSchema',
  PrReportCheck: 'prReportCheckSchema',
  PrReportValidation: 'prReportValidationSchema',
  PrReportValidationCommand: 'prReportValidationCommandSchema',
  PrReportReproduction: 'prReportReproductionSchema',
  PrReportTests: 'prReportTestsSchema',
  PrReportTestOutcome: 'prReportTestOutcomeSchema',
  PrReportTestConcern: 'prReportTestConcernSchema',
  PrReportContext: 'prReportContextSchema',
  PrReportContextDocument: 'prReportContextDocumentSchema',
  /**
   * The freshness verdict, hoisted for the reason this whole map exists: it is a VARIANT, so left
   * inline it ships as `…ContextDocumentFreshnessVariant0/1/2` in four languages, and reordering
   * the union's members would silently RENUMBER a type a consumer had written code against.
   */
  DocumentFreshness: 'documentFreshnessSchema',
  // Its sibling `documentOriginSchema` is deliberately NOT hoisted beside it: a bare picklist has
  // no object body, and the SDK emitter renders a hoisted one as an empty `interface`. It stays
  // an inline enum named after the first path that reaches it, which is what every other
  // vocabulary on this surface does (`PublicTaskSourceDocumentSource`, `PrReportCiStatus`).
  // `sdk/typescript/test/contract-conformance.test.ts` is what refuses the empty interface.
  PrReportRequirements: 'prReportRequirementsSchema',
  PrReportEnvironments: 'prReportEnvironmentsSchema',
  PrReportMerge: 'prReportMergeSchema',
  PrReportJudges: 'prReportJudgesSchema',
  PrReportJudge: 'prReportJudgeSchema',
  PrReportObservability: 'prReportObservabilitySchema',
}

/** Per-operation docs, keyed by operationId (the exported contract const name minus `Contract`). */
const OPERATION_DOCS = {
  createPublicJob: {
    tag: 'Jobs',
    summary: 'Start a headless job',
    description:
      'Start a public, inline pipeline headlessly against a supplied brief. Returns a job id to poll or stream. Nothing is pushed to GitHub.',
  },
  getPublicJob: {
    tag: 'Jobs',
    summary: 'Get a job',
    description:
      'Poll a headless job started through this surface: its status and, once finished, its result.',
  },
  listPublicServices: {
    tag: 'Services',
    summary: "List the workspace's services",
    description:
      'List the board service frames in the key’s workspace, so a caller can discover the serviceId to create/list tasks under.',
  },
  createPublicService: {
    tag: 'Services',
    summary: 'Create a service',
    description:
      'Create a board service, optionally backed by a repository from `GET /api/v1/repos`. The repository link is what makes the service runnable: execution resolves a task’s repository by walking up to its enclosing service frame, so a service with none holds tasks and can start none of them. A whole-repo repository that already backs a service in this account is MOUNTED rather than duplicated; a monorepo service must name its subdirectory. The board lays the service out itself: this surface publishes no coordinates. Requires an `admin` key.',
  },
  listPublicRepos: {
    tag: 'Repos',
    summary: 'List the repositories a service can be created against',
    description:
      'List the repositories the key’s workspace has connected, each with the service that already backs it (null when nothing does, and always null for a monorepo, which can back several). The discovery half of service creation: the create takes a repoId, and this is where one comes from.',
  },
  createPublicTask: {
    tag: 'Tasks',
    summary: 'Create a task under a service',
    description:
      'Create a task inside a service frame the key’s workspace owns. The task starts in the `planned` state; start it with the start endpoint. Optionally file it FROM a tracker ticket, and/or attach the requirements documents it is to be built against (named in a connected document source, or uploaded inline): the only way to get spec-sized input onto a repository-touching run.',
  },
  listPublicServiceTasks: {
    tag: 'Tasks',
    summary: "List a service's tasks",
    description:
      'List every task under a service (the whole subtree — tasks directly under the frame and under its modules).',
  },
  getPublicTask: {
    tag: 'Tasks',
    summary: "Get a task's status",
    description:
      'Read a task’s current lifecycle status, run progress, run id, and PR URL (once one exists).',
  },
  startPublicTask: {
    tag: 'Tasks',
    summary: 'Start (run) a task',
    description:
      'Start a task’s pipeline. Uses the request’s pipelineId, else the task’s pinned pipeline. A pipeline that can park on a human decision requires a `decide`-scope key. A task on an individual-usage model cannot be started through the API (no headless personal-credential unlock).',
  },
  updatePublicTask: {
    tag: 'Tasks',
    summary: "Edit a task's inputs",
    description:
      'Edit a task’s human-authored inputs before it runs: its title, its description, and `fields`, the per-case values for its own task type (checked against the descriptors `GET /api/v1/task-types` serves). All are optional. `fields` is MERGED over what the task already carries — a key you send is written, a key you omit keeps its stored value — because this API does not serve the bag back. This is what makes an input the pre-dispatch gate refused repairable: supply the value it named, then recheck the parked run.',
  },
  stopPublicTask: {
    tag: 'Tasks',
    summary: "Stop a task's run",
    description:
      'Stop a task’s in-flight run. Records a `cancelled` terminal state, leaving the run retryable.',
  },
  retryPublicTask: {
    tag: 'Tasks',
    summary: "Retry a task's failed run",
    description:
      'Retry a task’s failed run. A task on an individual-usage model cannot be retried through the API (no headless personal-credential unlock).',
  },
  getPublicRun: {
    tag: 'Tasks',
    summary: "Get a task's run (rich projection)",
    description:
      'Read a task’s run in detail: per-step status/progress/subtasks, the failure kind and message, and the PR (url + branch).',
  },
  addPublicTaskDependency: {
    tag: 'Tasks',
    summary: 'Declare that a task waits for another',
    description:
      'Record that this task cannot start until `dependsOnTaskId` is done. Both ends must be tasks in this workspace, and an edge that would close a cycle is refused. Idempotent: an edge that already exists is returned as-is rather than toggled off, so a provisioning integration re-running its own setup converges. Pair it with `autoStartDependents` on the BLOCKER (the task patch) to have the chain run itself.',
  },
  removePublicTaskDependency: {
    tag: 'Tasks',
    summary: 'Drop a dependency edge',
    description:
      'Remove the ordering between this task and `dependsOnTaskId`. Idempotent: an edge that is not there is a no-op.',
  },
  listPublicTaskDocuments: {
    tag: 'Tasks',
    summary: "List a task's attached documents",
    description:
      'The requirements documents attached to the task, in the order the agents read them. Each is identified by the `(source, externalId)` pair the attach and detach calls take.',
  },
  attachPublicTaskDocument: {
    tag: 'Tasks',
    summary: 'Attach a document to a task',
    description:
      'Attach a requirements document to a task that already exists, in either of the two forms creation takes: NAME a page in a connected document source, or CARRY the text inline. A task’s spec routinely arrives after the task does, and before this the only way to attach one was to delete the task and file it again, losing the id every stored reference points at, its ticket claim and the documents it already carried. A document a different live task already holds is refused rather than moved.',
  },
  detachPublicTaskDocument: {
    tag: 'Tasks',
    summary: 'Detach a document from a task',
    description:
      'Detach a document, naming it by the `(source, externalId)` pair the list serves. The document itself survives in the workspace, so re-attaching it later costs no re-import. Idempotent: detaching one the task does not hold is a no-op.',
  },
  deletePublicTask: {
    tag: 'Tasks',
    summary: 'Delete a task',
    description:
      'Delete a task and its run history. Destructive, so it sits at the top of the scope ladder: requires an `admin`-scoped key.',
  },
  listPublicJobs: {
    tag: 'Jobs',
    summary: "List the workspace's jobs",
    description:
      'List the headless runs THIS surface created, newest first and keyset-paginated. Scoped to internal-anchored runs exactly like the single-job read, so an external key can never enumerate the workspace’s ordinary board runs.',
  },
  resolvePublicRunInputGate: {
    tag: 'Decisions',
    summary: "Resolve a run parked on the task's input check",
    description:
      'Settle a run the pre-dispatch input gate parked before its first agent step because the task states nothing an agent could act on. `recheck` re-evaluates the task as it now stands (edit it over `PATCH /api/v1/tasks/{taskId}` first: the fix is verified, not taken on trust) and releases the run only if the blocking findings are gone; a still-blocked verdict comes back as an ordinary 200 with refreshed findings. `proceed` waives the findings, which stay on the run as an `overridden` record. Requires a `decide`-scope key.',
  },
  resolvePublicRunJudge: {
    tag: 'Decisions',
    summary: 'Resolve a parked judge verdict',
    description:
      'Settle a run parked on a judge verdict: proceed anyway, bounce the producing step for rework, or stop the run. Requires a `decide`-scope key.',
  },
  listPublicTaskTypes: {
    tag: 'Task types',
    summary: 'List the task types this workspace may create',
    description:
      'List the task types a task can be created as in the key’s workspace (the built-in ones plus any the deployment registered), each with the fields it accepts. Fill those fields through `fields` on task creation; the descriptors here are what that call validates against, so a caller reads the form rather than guessing it. A type a workspace admin has hidden is absent.',
  },
  listPublicPipelines: {
    tag: 'Pipelines',
    summary: "List the workspace's pipelines",
    description:
      'List the pipelines in the key’s workspace — id/name/steps plus whether each is public and safe to run headlessly — so a caller can pick a pipelineId to start a task with.',
  },
  listPublicNotifications: {
    tag: 'Notifications',
    summary: "List the workspace's open notifications",
    description:
      'List the open, human-actionable notifications in the key’s workspace (merge reviews, pipeline-complete confirmations, CI/test failures, and informational cards).',
  },
  actPublicNotification: {
    tag: 'Notifications',
    summary: 'Act on a notification',
    description:
      'Run a notification’s typed side-effect and resolve it: merge the PR (merge_review / pipeline_complete) or retry the run (ci_failed / test_failed). Performs a real GitHub merge, so it requires an admin-scoped key. Only these automated-action types are actionable through the API — a notification that parks a run on an interactive human decision cannot be acted on headlessly (dismiss it instead). A card that would retry a run on an individual-usage model likewise cannot be acted on through the API.',
  },
  dismissPublicNotification: {
    tag: 'Notifications',
    summary: 'Dismiss a notification',
    description: 'Dismiss a notification without acting on it.',
  },
  getPublicNotificationWebhook: {
    tag: 'Webhook',
    summary: "Read the workspace's outbound webhook",
    description:
      'The endpoint this workspace delivers notifications, run-lifecycle events and platform-health alerts to, or `{ "webhook": null }` when none is registered. The signing secret is never returned; `hasSecret` reports only whether one is set.',
  },
  putPublicNotificationWebhook: {
    tag: 'Webhook',
    summary: 'Register or update the outbound webhook',
    description:
      'Register the HTTPS endpoint deliveries are POSTed to, or update the one already registered. Every omitted field keeps its stored value, so subscribing to run events is a one-field call that re-sends neither the URL nor the secret. `url` is required only on the first call, when there is nothing registered to keep; omitting it otherwise leaves the endpoint alone. Supplying `secret` rotates the signing secret; omitting it keeps the current one. The endpoint must be `https:` and publicly routable unless the deployment widened its allow-list.',
  },
  deletePublicNotificationWebhook: {
    tag: 'Webhook',
    summary: 'Remove the outbound webhook',
    description: 'Deregister the endpoint; deliveries stop. Idempotent.',
  },
  listPublicNotificationWebhooks: {
    tag: 'Webhook',
    summary: "List the workspace's outbound webhooks",
    description:
      'Every endpoint this workspace delivers to, ordered by id. The endpoint the unnamed routes address appears here under the id `default`. Not paginated: the number of endpoints a workspace may register is capped, so the whole set fits in one response. No signing secret is returned for any of them.',
  },
  getPublicNamedNotificationWebhook: {
    tag: 'Webhook',
    summary: 'Read one named outbound webhook',
    description:
      'The endpoint registered under this id, or `{ "webhook": null }` when there is none — the same shape the unnamed read answers, so an integration\'s startup self-check does not branch on a status code. The signing secret is never returned.',
  },
  putPublicNamedNotificationWebhook: {
    tag: 'Webhook',
    summary: 'Register or update one named outbound webhook',
    description:
      'Register an endpoint under an id YOU choose (1-63 characters of lowercase letters, digits, `-` or `_`), or update the one already there. Idempotent by id, so an integration can enroll its own receiver on every cold start without tracking whether it has enrolled before, and without displacing anything else the workspace registered. Every field follows the same keep-on-omit rule as the unnamed route, `url` being required only when there is nothing under this id to keep, and a supplied `secret` rotating this endpoint\'s own signing secret. Refused with `reason: "invalid_webhook_id"` for an id that is not a slug, and `reason: "webhook_limit_reached"` (409) when registering a NEW id would exceed the per-workspace cap; editing an existing one is admitted either way.',
  },
  deletePublicNamedNotificationWebhook: {
    tag: 'Webhook',
    summary: 'Remove one named outbound webhook',
    description:
      "Deregister this endpoint; its deliveries stop and the workspace's other endpoints are untouched. Idempotent.",
  },
  getPublicUsage: {
    tag: 'Usage',
    summary: "Read the workspace's usage for the current period",
    description:
      'Read this billing period’s METERED spend against the workspace budget (including whether it is exceeded, which pauses runs) plus the per-(billing, vendor, provider, model) token breakdown behind it. Costs on `subscription` rows are illustrative — a flat-rate plan bills nothing per token — so branch on `billing` before summing. Workspace-scoped: the account- and user-tier budgets are not reachable through this surface.',
  },
  getPublicSpend: {
    tag: 'Usage',
    summary: "Break the workspace's spend down by repository, ticket, run or step kind",
    description:
      'Group the board\u2019s spend over a window (`24h`, `7d`, `30d`, `90d`) by ONE dimension: `repo`, `ticket` and `run` are the cost-attribution axes an organisation budgets against, and `model` / `agentKind` / `service` / `taskType` slice the same money the other ways. `meteredCost` is real money and `subscriptionCost` is the illustrative equivalent-API cost of flat-rate quota usage, so never sum them. The EMPTY `key` is the unattributed bucket, a real slice rather than a dropped row, never dropped from the breakdown. `rows` is the heaviest `limit` slices (default 100, max 500) and `truncated` says when there was a tail, while `totals` aggregates the WHOLE window either way, so a capped answer still reports what the board spent. `source` says which store answered: the short windows scan the live ledger, which resolves a repository or a ticket through today\u2019s links, while the long ones read the durable daily rollup, which froze that attribution while the money was spent and is never pruned. Read `rolledUpThrough` before reporting a quiet quarter, since a rollup that has never run and a board that spent nothing look identical. Workspace-scoped: the account-wide view is not reachable through this surface.',
  },
  getPublicIdentity: {
    tag: 'Identity',
    summary: 'Describe the calling key',
    description:
      'Report what the key on this request is and what it may do: its id, its account, the ONE workspace every call under it acts within, its scope, and the label it was minted with. `read` scope, the floor of the ladder, because an integration\u2019s startup self-check has to work whatever rung it holds. The scope ladder is INCLUSIVE (`read` \u2282 `write` \u2282 `decide` \u2282 `admin`), so compare against the rung an action needs rather than for equality.',
  },
  cancelPublicJob: {
    tag: 'Jobs',
    summary: 'Cancel a job',
    description:
      'Stop a headless job run, freeing its concurrency slot. Idempotent — an already-finished job is returned as-is. Use this to abandon a run parked on a decision you do not intend to answer.',
  },
  listPublicRunDecisions: {
    tag: 'Decisions',
    summary: "List a run's parked decisions",
    description:
      'Read what a run is currently asking a human. Each entry names its `kind`, and every kind this surface can answer is listed: `requirements-review`, `clarity-review`, `brainstorm`, `interview`, `input-gate`, `approval-gate`, `judge`, `fork`, `agent-decision`, `pr-review`, `human-test`, `visual-confirmation`, `follow-ups`. Each carries the stable ids (item, approval, decision, finding) that its answering route addresses. `parked` reports only whether the run has STOPPED (`status` is `blocked`); it is not a precondition for `decisions` being non-empty, since a `follow-ups` entry is answerable while the run is still working, so poll this regardless of `parked`. An empty `decisions` beside a non-empty `unanswerable` means a wait no route here can settle (a person reviewing the pull request, a deployment-registered gate), each named with its reason and step.',
  },
  replyPublicRunFinding: {
    tag: 'Decisions',
    summary: 'Answer a review finding',
    description:
      "Record an answer to one reviewer finding. Returns the run's updated decision list. Requires a `decide`-scope key.",
  },
  setPublicRunFindingStatus: {
    tag: 'Decisions',
    summary: 'Dismiss or reopen a finding',
    description:
      'Dismiss a finding as not applicable, or reopen one dismissed by mistake. Requires a `decide`-scope key.',
  },
  incorporatePublicRunRequirements: {
    tag: 'Decisions',
    summary: 'Incorporate the answers',
    description:
      'Fold the recorded answers into one standardized requirements document. Asynchronous — the run re-reviews in the background, so the response shows the review `incorporating`. Requires a `decide`-scope key.',
  },
  reReviewPublicRunRequirements: {
    tag: 'Decisions',
    summary: 'Re-review the incorporated document',
    description:
      'Run one more reviewer pass over the incorporated document. On convergence the parked run advances. Requires a `decide`-scope key.',
  },
  proceedPublicRunRequirements: {
    tag: 'Decisions',
    summary: 'Proceed with the current requirements',
    description:
      'Settle the requirements phase and advance the parked run (used when nothing is outstanding). Requires a `decide`-scope key.',
  },
  resolvePublicRunRequirementsExceeded: {
    tag: 'Decisions',
    summary: 'Resolve a review at its iteration cap',
    description:
      'Pick how a review that exhausted its reviewer-pass budget proceeds: one more round, proceed with the last incorporated document, or stop and reset the task. Requires a `decide`-scope key.',
  },
  choosePublicRunFork: {
    tag: 'Decisions',
    summary: 'Choose an implementation approach',
    description:
      'Pick one of the proposed implementation forks (by id) or submit your own approach. The Coder then runs with the choice folded in as a binding directive. Requires a `decide`-scope key.',
  },
  approvePublicRunStep: {
    tag: 'Decisions',
    summary: 'Approve a parked step',
    description:
      "Approve the proposal a gated step is holding up, optionally replacing it with an edited one (the edit is what flows to every downstream step), and advance the run. The `approvalId` comes from the run's decision list; passing it back is what makes a racing app user and a racing integration resolve the same gate. Requires a `decide`-scope key.",
  },
  requestPublicRunStepChanges: {
    tag: 'Decisions',
    summary: 'Request changes on a parked step',
    description:
      'Send the gated step back to re-run with your guidance folded in. Unlike the in-app twin this takes freeform feedback only: anchored per-block comments address source line ranges of a rendered proposal, which a headless caller never rendered. Requires a `decide`-scope key.',
  },
  rejectPublicRunStep: {
    tag: 'Decisions',
    summary: 'Reject a parked step',
    description:
      'Reject the gated proposal: the run stops entirely, recording a terminal `rejected` failure the board can retry. Requires a `decide`-scope key.',
  },
  resolvePublicRunStepExceeded: {
    tag: 'Decisions',
    summary: 'Resolve a companion gate at its rework cap',
    description:
      'Pick how a quality companion that spent its automatic rework budget proceeds: one more round, proceed with the output as it stands, or stop and reset the task. A gate in this state reports `exceeded: true` and refuses the plain approve. Requires a `decide`-scope key.',
  },
  resolvePublicRunAgentDecision: {
    tag: 'Decisions',
    summary: 'Answer an agent-raised decision',
    description:
      'Answer a question an agent raised mid-work. Resolving RE-RUNS the asking step with the choice folded in, rather than advancing past it. The choice is taken verbatim, so it may be one of the offered options or a steer of your own. Requires a `decide`-scope key.',
  },
  replyPublicRunClarityFinding: {
    tag: 'Decisions',
    summary: 'Answer a clarity (bug-triage) finding',
    description:
      "Record an answer to one clarity-review finding — the bug-report twin of the requirements loop. Returns the run's updated decision list. Requires a `decide`-scope key.",
  },
  setPublicRunClarityFindingStatus: {
    tag: 'Decisions',
    summary: 'Dismiss or reopen a clarity finding',
    description:
      'Dismiss a clarity finding as not applicable, or reopen one dismissed by mistake. Only `open` findings block incorporation. Requires a `decide`-scope key.',
  },
  incorporatePublicRunClarity: {
    tag: 'Decisions',
    summary: 'Incorporate clarity answers',
    description:
      'Fold the recorded answers into one standardized bug report. ASYNCHRONOUS: the response shows the review `incorporating` while the durable driver folds and re-reviews in the background. Requires a `decide`-scope key.',
  },
  reReviewPublicRunClarity: {
    tag: 'Decisions',
    summary: 'Re-triage the clarified report',
    description:
      'Run one more triage pass over the incorporated bug report. On convergence the parked run advances. Requires a `decide`-scope key.',
  },
  proceedPublicRunClarity: {
    tag: 'Decisions',
    summary: 'Proceed past the clarity review',
    description:
      'Settle the clarity phase with the last clarified report and advance the parked run. Requires a `decide`-scope key.',
  },
  resolvePublicRunClarityExceeded: {
    tag: 'Decisions',
    summary: 'Resolve a clarity review at its iteration cap',
    description:
      'Pick how a clarity review that exhausted its pass budget proceeds: one more round, proceed with the last clarified report, or stop and reset the task. Requires a `decide`-scope key.',
  },
  replyPublicRunBrainstormOption: {
    tag: 'Decisions',
    summary: 'Respond to a brainstorm option',
    description:
      'Pick or steer one of the options the brainstorm agent proposed, for the named stage (`requirements` or `architecture`). A task may hold one live session per stage at once. Requires a `decide`-scope key.',
  },
  setPublicRunBrainstormOptionStatus: {
    tag: 'Decisions',
    summary: 'Dismiss or reopen a brainstorm option',
    description:
      'Dismiss a proposed option, or reopen one dismissed by mistake. Only `open` options block incorporation. Requires a `decide`-scope key.',
  },
  incorporatePublicRunBrainstorm: {
    tag: 'Decisions',
    summary: 'Incorporate brainstorm picks',
    description:
      'Fold the picks into one converged direction. ASYNCHRONOUS: the response shows the session `incorporating` while the durable driver folds and re-runs in the background. Requires a `decide`-scope key.',
  },
  reReviewPublicRunBrainstorm: {
    tag: 'Decisions',
    summary: 'Re-run a brainstorm pass',
    description:
      'Run one more brainstorm pass against the converged direction. Requires a `decide`-scope key.',
  },
  proceedPublicRunBrainstorm: {
    tag: 'Decisions',
    summary: 'Proceed past a brainstorm',
    description:
      'Settle the brainstorm with the last converged direction and advance the parked run. Requires a `decide`-scope key.',
  },
  resolvePublicRunBrainstormExceeded: {
    tag: 'Decisions',
    summary: 'Resolve a brainstorm at its iteration cap',
    description:
      'Pick how a brainstorm that exhausted its pass budget proceeds: one more round, proceed with the last converged direction, or stop and reset the task. Requires a `decide`-scope key.',
  },
  resolvePublicRunPrReview: {
    tag: 'Decisions',
    summary: 'Resolve a parked PR deep review',
    description:
      'Record the curated finding selection and say what to do with it: `finish` completes the read-only review, `fix` hands the selected findings to a fixer that commits onto the reviewed PR branch, `post` publishes them as inline PR review comments. `fix` and `post` need at least one selected finding and act on the real pull request. Requires a `decide`-scope key.',
  },
  dismissPublicRunPrReviewFinding: {
    tag: 'Decisions',
    summary: 'Dismiss a PR review finding',
    description:
      'Drop one finding from the parked review entirely. Curation rather than a resolution: the run stays parked. Requires a `decide`-scope key.',
  },
  challengePublicRunPrReviewFinding: {
    tag: 'Decisions',
    summary: 'Challenge a PR review finding',
    description:
      'Dispatch a read-only investigator to re-examine one finding against the full source, optionally with a specific concern. It upholds, strengthens or retracts the finding, and the review re-parks carrying the verdict. Requires a `decide`-scope key.',
  },
  confirmPublicRunHumanTest: {
    tag: 'Decisions',
    summary: 'Confirm a human-test gate',
    description:
      'Confirm the change works in the ephemeral environment: it is torn down and the run advances. The decision carries the environment URL to exercise; confirming without exercising it approves untested work. Requires a `decide`-scope key.',
  },
  requestPublicRunHumanTestFix: {
    tag: 'Decisions',
    summary: 'Request a fix from a human-test gate',
    description:
      'Submit findings against the tested environment and dispatch a fixer, which commits onto the PR branch before the environment is rebuilt. The findings ARE the fixer prompt, so they cannot be blank. Requires a `decide`-scope key.',
  },
  approvePublicRunVisualConfirm: {
    tag: 'Decisions',
    summary: 'Approve a visual-confirmation gate',
    description:
      'Approve the captured screenshots against the reference designs and advance the run. The images themselves are not readable over this API — the decision carries only artifact ids — so approving on the projection alone approves screenshots you have not seen. Requires a `decide`-scope key.',
  },
  requestPublicRunVisualConfirmFix: {
    tag: 'Decisions',
    summary: 'Request a fix from a visual-confirmation gate',
    description:
      'Submit findings against the captured screenshots and dispatch a fixer. The findings ARE the fixer prompt, so they cannot be blank. Requires a `decide`-scope key.',
  },
  filePublicRunFollowUp: {
    tag: 'Decisions',
    summary: 'File a follow-up item as an issue',
    description:
      "File one `follow_up` item on the workspace's issue tracker, recording the ticket ref on the item. Refused for a `question` item, and for a workspace with no tracker connected. Creating the issue is not idempotent, so a retry after a partial failure files a second one. Requires a `decide`-scope key.",
  },
  sendBackPublicRunFollowUp: {
    tag: 'Decisions',
    summary: 'Send a follow-up item back to the Coder',
    description:
      'Fold one `follow_up` item into another Coder pass (the item records as `queued`). Once every item is decided the run loops the Coder for the ones sent back, within the `maxLoops` budget the decision reports. Requires a `decide`-scope key.',
  },
  answerPublicRunFollowUp: {
    tag: 'Decisions',
    summary: 'Answer a follow-up question',
    description:
      'Answer one `question` item the Coder raised mid-run; the answer steers its next pass. Refused for a `follow_up` item, which is filed, sent back or dismissed instead. Requires a `decide`-scope key.',
  },
  dismissPublicRunFollowUp: {
    tag: 'Decisions',
    summary: 'Dismiss a follow-up item',
    description:
      'Wave one item off without acting on it. Valid for either item kind, and (like every other verb here) releases the park once it is the last undecided item. Requires a `decide`-scope key.',
  },
  answerPublicRunInterview: {
    tag: 'Decisions',
    summary: 'Answer an interview question',
    description:
      'Record an answer to one question the parked interviewer asked. Does NOT resume the run: answer the batch, then `continue` or `proceed`. Requires a `decide`-scope key.',
  },
  continuePublicRunInterview: {
    tag: 'Decisions',
    summary: 'Continue a parked interview',
    description:
      'Submit the recorded answers and resume: the interviewer runs again and may ask follow-up questions. ASYNCHRONOUS: the pass runs in the durable driver, so the next round arrives on a later read of the decision list. Requires a `decide`-scope key.',
  },
  proceedPublicRunInterview: {
    tag: 'Decisions',
    summary: 'Proceed past a parked interview',
    description:
      'Stop the questions: the interviewer converges on the answers so far and the run advances. Also asynchronous, since converging is itself an interviewer pass. Requires a `decide`-scope key.',
  },

  // The remote-debugging reads (`/api/v1/debug/*`, `read` scope). A two-level drill-down: the
  // run-scoped lists live under `/debug/runs/:runId/*`, while a point read that carries BODIES is
  // addressed by the row's own id, so a caller holding a call id from a list need not also
  // remember the run it came from. Every response's size is computable before the request — lists
  // never carry bodies, and a body is reached at any offset through its own read.
  listDebugRuns: {
    tag: 'Debug',
    summary: "List the workspace's runs",
    description:
      'The triage entry point: the workspace’s runs, newest first and keyset-paginated, with an optional status and `since` filter.',
  },
  getDebugRun: {
    tag: 'Debug',
    summary: "Get a run's diagnostic map",
    description:
      'One run’s diagnostic overview: its steps, which telemetry sinks this deployment retains (and how much each holds), the LLM cost/latency rollups, and the derived signals worth looking at first.',
  },
  listDebugLlmCalls: {
    tag: 'Debug',
    summary: "List a run's LLM calls",
    description:
      'The model calls a run made, keyset-paginated and filterable by agent kind, phase, outcome or a substring of the bodies. Bodies are returned only when `bodyChars` asks for them.',
  },
  getDebugLlmCall: {
    tag: 'Debug',
    summary: 'Get one LLM call',
    description:
      'One recorded model call with its budgeted prompt delta, response and reasoning. `bodyOffset`/`bodyChars` window the bodies, so an arbitrarily long transcript is readable in bounded pages.',
  },
  getDebugLlmExport: {
    tag: 'Debug',
    summary: "Export a run's model activity as one bundle",
    description:
      'The whole of a run\u2019s model activity as one self-describing document, for handing straight to a model asked why the run truncated, spent or stalled: the SQL rollups (run totals, per agent kind, per phase, with the carry cost that says which slice burdened everything after it) plus a bounded window of the individual calls behind them. The rollups cover EVERY recorded call and do not move with `limit`, so a windowed bundle still reports what the run actually cost; `truncated` says the calls are a window and `order` says which end was kept. Bodies are omitted unless `bodyChars` asks, and the resumable call list is the way to walk a long run whole.',
  },
  listDebugAgentContext: {
    tag: 'Debug',
    summary: "List a run's agent-context dispatches",
    description:
      'Every dispatch whose provided context was captured, with SIZES only (no bodies) so the list stays bounded. Read one in full through the snapshot endpoint.',
  },
  getDebugAgentContext: {
    tag: 'Debug',
    summary: 'Get one agent-context snapshot',
    description:
      'The complete context one dispatch was PROVIDED: system and user prompts, the folded standards fragments, and the injected `.cat-context/*` files an agent reads through tools (which therefore appear in no proxy telemetry). Windowed by `bodyOffset`/`bodyChars`.',
  },
  listDebugSearchQueries: {
    tag: 'Debug',
    summary: "List a run's web searches",
    description:
      'The web searches the run’s agents actually performed, keyset-paginated. Retained only when the deployment records agent context.',
  },
  listDebugToolCalls: {
    tag: 'Debug',
    summary: "List a run's tool calls",
    description:
      'The tool calls the run’s agents made, in the order they made them — which command, against what, and what came back. The half of “how did this diff come about” that neither the diff nor a prompt body answers. Arguments and results are retained only when the deployment records agent context AND the workspace has not opted out; `bodies` says which, so an empty `args` is never mistaken for a call that took none.',
  },
  getPublicRunReport: {
    tag: 'Evidence',
    summary: "Get a run's verification report",
    description:
      'The engine’s bundle of CAPTURED FACTS about a run: the CI gate’s verdict and failing checks, the platform’s own run of the service’s lint/test/build commands (with the failing output), the red-then-green reproduction proof for a bugfix, the tester’s structured report, requirement coverage, the throwaway-environment lifecycle, judge verdicts and the merge decision. Byte-for-byte the JSON block the pull-request body carries, composed on read, so it also answers for a run that never opened a pull request. Each section states `reported` or `absent` with a note, so a step that did not run never looks like a step that found nothing.',
  },
  getPublicRunOutcome: {
    tag: 'Evidence',
    summary: "Get a run's outcome summary",
    description:
      'What the run changed and what backs that up, in product language, for a reader who will not open the diff: the run’s disposition, the pull requests it opened, requirement coverage joined to the service’s `spec/`, the tester’s verdict and concerns, the views it captured, and the machine checks that ran. The same reduction the app’s outcome card renders, over the same evidence the verification report is built from, so the two cannot state different totals for one run. Nothing here is asserted by a model: every count is derived from recorded verdicts. Prefer the verification report when you need a reviewer’s full bundle; prefer this when you need to say what shipped. Sections state `reported` or `absent` with a machine-readable gap code, and `truncations` names any list the response had to bound.',
  },
  listPublicRunArtifacts: {
    tag: 'Evidence',
    summary: "List a run's captured artifacts",
    description:
      'The binary artifacts the run captured (UI screenshots) plus the reference images they were reviewed against: id, kind, view, content type, exact byte size and content hash. Unpaged: the capture path caps how many one run may store, so the response size is bounded before the request. Fetch the bytes with the blob endpoint.',
  },
  listPublicKeys: {
    tag: 'Keys',
    summary: "List the workspace's API keys",
    description:
      'The live (non-revoked) keys for the calling key’s workspace, metadata only; a secret is never readable back. `createdByKeyId` names the key that provisioned a key headlessly; `createdByUserId` names the person who minted one in the app.',
  },
  createPublicKey: {
    tag: 'Keys',
    summary: 'Provision an API key',
    description:
      'Mint a key for the calling key’s own workspace and return its raw secret EXACTLY ONCE, so store it now: it is not recoverable. Omitting `scope` mints a `write` key. `admin` cannot be minted here: a key provisioned over the API can never itself provision, which keeps the chain one link long. Requires an `admin`-scope key.',
  },
  revokePublicKey: {
    tag: 'Keys',
    summary: 'Revoke an API key',
    description:
      'Revoke a key AND every key it minted, so a leaked provisioning key cannot outlive its own revocation through the credentials it left behind. Idempotent, and it may name the calling key. Requires an `admin`-scope key.',
  },
  listDebugLogs: {
    tag: 'Debug',
    summary: "List a run's infrastructure log",
    description:
      'The run’s provisioning event log — how its environment, runner pool and containers came up, or why they did not.',
  },
}

/** Descriptions for the operation tags (groups). */
const TAG_DESCRIPTIONS = {
  Jobs: 'Headless runs of a public, inline pipeline (start, poll, stream).',
  Services: 'The workspace’s board services.',
  Tasks: 'Board tasks under a service (create, list, read, edit, start, stop, retry, stream).',
  Pipelines: 'The workspace’s pipelines (discover a pipelineId to start a task with).',
  Notifications:
    'The workspace’s human-actionable notifications (list, act on, or dismiss the run tails).',
  Webhook:
    'The workspace’s one outbound endpoint: register it to receive notifications, run-lifecycle events and platform-health alerts by push instead of polling. Requires an `admin`-scope key; the signing secret is write-only.',
  Decisions:
    'A run’s human decisions, from requirement-review and clarity findings through approval gates, judge verdicts, interviews and follow-ups, so a headless caller can drive the clarification loop instead of the run hanging. Answering requires a `decide`-scope key.',
  Evidence:
    'What a run PROVED: the engine’s own verification report (the same bundle it writes onto the pull request) and the binary artifacts the run captured, bytes included. The surface for a consumer that has to judge a run (accept the change, score the fleet) rather than debug one. Read-only (`read` scope).',
  Keys: 'The workspace’s public-API keys, provisioned headlessly. Requires an `admin`-scope key; a key minted here can never reach `admin` itself, and revoking a key revokes everything it minted.',
  Identity:
    'What the calling key is and what it may do — the self-check an integration runs at startup, so “can I do this?” does not have to be answered by attempting it and reading the 403. `read` scope.',
  Debug:
    'A run’s recorded telemetry, for diagnosing one that went wrong: the model calls it made, the context each agent was provided, the searches it ran, the tools it invoked and how its infrastructure came up. Read-only (`read` scope), and every response’s size is bounded before the request is made.',
}

/** Human descriptions for the response status codes we emit (OpenAPI requires a description). */
const STATUS_DESCRIPTIONS = {
  200: 'Success',
  201: 'Created',
  202: 'Accepted — the run has started',
  204: 'No content',
  '4XX': 'Client error (validation, unauthorized, not found, conflict, rate limit)',
  '5XX': 'Server error',
}

/**
 * Rewrite `@valibot/to-json-schema`'s `#/$defs/<X>` refs to OpenAPI `#/components/schemas/<X>`, and
 * drop `$schema` and `$defs`.
 *
 * Dropping `$defs` is what keeps the emitted spec proportional to the surface. `toJsonSchema` copies
 * every definition it was handed into the `$defs` of EACH schema that references one, so a schema
 * inlined into ten operations carried ten copies of the whole component set — every new public DTO
 * cost ~10x its size in the committed file, which is churn a reviewer has to read past. Once the
 * refs above point into `#/components/schemas`, nothing resolves through `$defs` any more and it is
 * dead weight. `assertRefsResolve` below is the proof rather than the assumption: a `$ref` this drop
 * would strand fails generation instead of shipping a dangling pointer.
 */
function normalizeJsonSchema(node) {
  if (Array.isArray(node)) return node.map(normalizeJsonSchema)
  if (node && typeof node === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(node)) {
      if (k === '$schema' || k === '$defs') continue
      if (k === '$ref' && typeof v === 'string') {
        out[k] = v.replace('#/$defs/', '#/components/schemas/')
      } else {
        out[k] = normalizeJsonSchema(v)
      }
    }
    return out
  }
  return node
}

/**
 * Fail generation if any `$ref` in the document names a schema `components.schemas` does not carry.
 * This is what makes dropping `$defs` safe rather than hopeful: every ref must have been rewritten
 * into the components namespace and every target must actually be emitted, so a DTO that needs
 * hoisting shows up here (add it to {@link COMPONENT_SCHEMAS}) instead of as a spec a client
 * generator chokes on.
 */
function assertRefsResolve(doc) {
  const known = new Set(Object.keys(doc.components?.schemas ?? {}))
  const dangling = new Set()
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') {
        const name = v.startsWith('#/components/schemas/') ? v.slice(21) : null
        if (name === null || !known.has(name)) dangling.add(v)
      } else walk(v)
    }
  }
  walk(doc.paths)
  walk(doc.components?.schemas)
  if (dangling.size > 0) {
    throw new Error(
      `OpenAPI document has unresolvable $refs: ${[...dangling].sort().join(', ')}. ` +
        'Hoist the schema into COMPONENT_SCHEMAS in scripts/generate-openapi.mjs.',
    )
  }
}

/** True when `v` is a route contract object (method + pathResolver + responses). */
function isApiContract(v) {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof v.method === 'string' &&
    typeof v.pathResolver === 'function' &&
    !!v.responsesByStatusCode
  )
}

/** A Standard-Schema value (Valibot schema) vs a marker like `ContractNoBody`. */
function isSchema(v) {
  return !!v && typeof v === 'object' && '~standard' in v
}

/** Resolve the contract's path to an OpenAPI path template (`/api/v1/services/{serviceId}/tasks`). */
function pathTemplate(contract) {
  const proxy = new Proxy({}, { get: (_t, key) => `{${String(key)}}` })
  return contract.pathResolver(proxy)
}

/** Path-parameter names embedded in a `{...}` templated path. */
function pathParamNames(template) {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1])
}

/** Recursively sort object keys so the emitted JSON is deterministic (stable diffs for the CI guard). */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortDeep(value[k])]),
    )
  }
  return value
}

/**
 * Add the three `/api/v1` routes that are NOT route contracts, documented by hand.
 *
 * A contract needs a JSON request/response pair to describe; these three have none (two SSE
 * streams and an image), so their entries are written out here instead of derived. That is also
 * why each carries a hand-written `x-min-scope` literal restating what its handler enforces:
 * there is no `withMinScope` to read it off, and no type that would catch the two drifting.
 *
 * Kept out of `buildOpenApiDoc` because it is a self-contained block of literals rather than
 * part of that function's derivation, and it is where every future raw route lands.
 */
function addHandDocumentedRoutes(paths, tags) {
  // The raw SSE routes that are NOT contracts (streaming Hono routes), documented by hand.
  tags.add('Jobs')
  paths[`${API_PREFIX}/jobs/{id}/events`] = {
    get: {
      operationId: 'streamPublicJobEvents',
      // Hand-documented route: the handler's own `authorize(c, 'read')` literal, restated here
      // because there is no contract to read it off. Keep the two in step.
      'x-min-scope': 'read',
      tags: ['Jobs'],
      summary: 'Stream a job (SSE)',
      description:
        'Server-sent events for a headless job run: `progress` frames until a terminal `done`/`error`/`stopped`/`timeout` event. Authenticated by the API key header.',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: {
          description: 'An event stream of job updates',
          content: { 'text/event-stream': { schema: { type: 'string' } } },
        },
        '4XX': {
          description: STATUS_DESCRIPTIONS['4XX'],
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
          },
        },
      },
    },
  }
  tags.add('Tasks')
  paths[`${API_PREFIX}/tasks/{taskId}/events`] = {
    get: {
      operationId: 'streamPublicTaskRun',
      // Hand-documented route: the handler's own `authorize(c, 'read')` literal, restated here
      // because there is no contract to read it off. Keep the two in step.
      'x-min-scope': 'read',
      tags: ['Tasks'],
      summary: 'Stream a task run (SSE)',
      description:
        'Server-sent events for a board task run: `progress` frames (the rich run projection) until a terminal `done`/`error` event, or a `timeout` when the connection cap is reached. Authenticated by the API key header.',
      parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: {
          description: 'An event stream of run updates',
          content: { 'text/event-stream': { schema: { type: 'string' } } },
        },
        '4XX': {
          description: STATUS_DESCRIPTIONS['4XX'],
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
          },
        },
      },
    },
  }

  // The artifact BYTES: not a route contract, because the response is an image rather than JSON.
  // Documented by hand for the same reason the two SSE routes above are, and named in the SDK
  // surface table so all four clients expose it (each transport reads the body as bytes).
  tags.add('Evidence')
  paths[`${API_PREFIX}/artifacts/{artifactId}/blob`] = {
    get: {
      operationId: 'getPublicArtifactBlob',
      // Hand-documented route: the handler's own `authorize(c, 'read')` literal, restated here
      // because there is no contract to read it off. Keep the two in step.
      'x-min-scope': 'read',
      tags: ['Evidence'],
      summary: "Download an artifact's bytes",
      description:
        'The stored bytes of one artifact listed by the run-artifacts endpoint, served with the recorded image content type (`nosniff`, never inline active content). Authenticated like every other call: the bytes are workspace-scoped, so a report that links here on a public repository leaks nothing to a reader without a key. 404 when the id is unknown to the key’s workspace, and separately when the metadata row survives but its bytes are gone from the blob backend.',
      parameters: [{ name: 'artifactId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: {
          description: 'The artifact bytes',
          // Every type the route can actually answer with, not one standing in for the rest: the
          // handler serves the artifact's RECORDED type clamped to the image allow-list, and
          // falls back to octet-stream only for a stored row it does not recognise. Declaring a
          // single type would tell anyone generating a client from this document to expect a
          // media type the endpoint never sends. `blobMediaTypes.spec.ts` pins this set to the
          // server's own allow-list, so the two cannot drift.
          content: Object.fromEntries(
            BLOB_MEDIA_TYPES.map((media) => [media, { schema: BINARY_SCHEMA }]),
          ),
        },
        '4XX': {
          description: STATUS_DESCRIPTIONS['4XX'],
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
          },
        },
      },
    },
  }
}

export async function buildOpenApiDoc() {
  const contracts = await import(pathToFileURL(CONTRACTS_DIST).href)

  // Component schemas (named DTOs) + a reverse identity map (schema object → component name)
  // so an operation referencing a named DTO emits a `$ref` rather than re-inlining it.
  const defs = {}
  const nameBySchema = new Map()
  for (const [componentName, exportName] of Object.entries(COMPONENT_SCHEMAS)) {
    const schema = contracts[exportName]
    if (!schema)
      throw new Error(`Missing contracts export '${exportName}' for component '${componentName}'`)
    defs[componentName] = schema
    nameBySchema.set(schema, componentName)
  }
  const componentSchemas = normalizeJsonSchema(toJsonSchemaDefs(defs, { errorMode: 'ignore' }))

  const schemaRef = (schema) => {
    const name = nameBySchema.get(schema)
    if (name) return { $ref: `#/components/schemas/${name}` }
    return normalizeJsonSchema(toJsonSchema(schema, { errorMode: 'ignore', definitions: defs }))
  }

  const tags = new Set()
  const paths = {}

  for (const [exportName, contract] of Object.entries(contracts)) {
    if (!isApiContract(contract)) continue
    const template = pathTemplate(contract)
    if (!template.startsWith(API_PREFIX)) continue

    const operationId = exportName.replace(/Contract$/, '')
    const docs = OPERATION_DOCS[operationId] ?? { tag: 'Public API', summary: operationId }
    tags.add(docs.tag)

    // The scope FLOOR is part of the published surface: it rides the contract (`withMinScope`,
    // the same value the controller enforces) and is stamped per operation so the SDK projections
    // can carry it as policy metadata. Failing here is the totality guard: a public contract with
    // no floor would otherwise publish an operation whose admission rule a consumer cannot see.
    if (typeof contract.minScope !== 'string') {
      throw new Error(
        `Public contract '${exportName}' (${contract.method.toUpperCase()} ${template}) declares ` +
          'no minScope. Wrap it in withMinScope(...) in backend/packages/contracts/src/routes/.',
      )
    }

    const operation = {
      operationId,
      tags: [docs.tag],
      summary: docs.summary,
      'x-min-scope': contract.minScope,
      responses: {},
    }
    if (docs.description) operation.description = docs.description

    const params = pathParamNames(template).map((name) => ({
      name,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }))
    // Query params (pagination cursors, page limits, status/`since` filters). Without these the
    // published spec documents a bounded list endpoint as if it took no arguments, so an external
    // integration reading it cannot discover how to page at all. One `in: 'query'` entry per
    // top-level key of the contract's query schema, carrying its description + constraints.
    if (isSchema(contract.requestQuerySchema)) {
      const query = normalizeJsonSchema(
        toJsonSchema(contract.requestQuerySchema, { errorMode: 'ignore', definitions: defs }),
      )
      const required = new Set(query.required ?? [])
      for (const [name, schema] of Object.entries(query.properties ?? {})) {
        params.push({ name, in: 'query', required: required.has(name), schema })
      }
    }
    if (params.length) operation.parameters = params

    if (isSchema(contract.requestBodySchema)) {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: schemaRef(contract.requestBodySchema) } },
      }
    }

    for (const [code, schema] of Object.entries(contract.responsesByStatusCode)) {
      // `4xx`/`5xx` range keys → OpenAPI 3.1 `4XX`/`5XX`.
      const status = /^[45]xx$/.test(code) ? code.toUpperCase() : code
      const response = { description: STATUS_DESCRIPTIONS[status] ?? 'Response' }
      if (isSchema(schema)) {
        response.content = { 'application/json': { schema: schemaRef(schema) } }
      }
      operation.responses[status] = response
    }

    paths[template] ??= {}
    paths[template][contract.method] = operation
  }

  addHandDocumentedRoutes(paths, tags)

  // The scope VOCABULARY, ordered least to greatest: the ladder every operation's `x-min-scope`
  // is drawn from, taken verbatim from the contracts' `PUBLIC_API_SCOPES` (whose array order IS
  // the ranking, the same derivation the server's own `scope >= required` check uses).
  //
  // Published because a per-operation floor is unusable without it: OpenAPI's bearer scheme has
  // no scope slot, so a consumer holding a key cannot otherwise tell whether `write` outranks
  // `decide`. Stamping it here is what lets the generated projections DERIVE the ladder instead
  // of restating it, so a rung added or reordered in the contracts moves the published helpers in
  // the same `pnpm gen:sdk` rather than leaving them a stale copy that ranks a live key at -1.
  if (!Array.isArray(contracts.PUBLIC_API_SCOPES) || contracts.PUBLIC_API_SCOPES.length === 0) {
    throw new Error(
      "Contracts export no PUBLIC_API_SCOPES ladder to publish as 'x-public-api-scopes'.",
    )
  }
  const scopeLadder = [...contracts.PUBLIC_API_SCOPES]

  const doc = {
    openapi: '3.1.0',
    'x-public-api-scopes': scopeLadder,
    info: {
      title: 'cat-factory Public API',
      version: API_VERSION,
      description:
        'The external, key-authenticated API (`/api/v1`). Authenticate every request with a public-API key: `Authorization: Bearer cf_live_<keyId>.<secret>`. Every call is scoped to the key’s workspace.',
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: '/', description: 'The deployment base URL' }],
    security: [{ bearerAuth: [] }],
    tags: [...tags].sort().map((name) => ({
      name,
      ...(TAG_DESCRIPTIONS[name] ? { description: TAG_DESCRIPTIONS[name] } : {}),
    })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'A public-API key of the form `cf_live_<keyId>.<secret>`.',
        },
      },
      schemas: componentSchemas,
    },
  }
  assertRefsResolve(doc)
  return sortDeep(doc)
}

/** Deterministic serialization used by both the writer and the CI guard. */
export function serializeOpenApiDoc(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`
}

/**
 * The served copy, as a TS module. The spec rides in a JSON string literal so the endpoint can
 * answer with the bytes verbatim; `JSON.stringify` of the serialized text is what escapes it.
 */
export function serializeServedOpenApiDoc(doc) {
  return [
    '// GENERATED by `pnpm gen:openapi` — do not edit. Change the route contracts instead.',
    '//',
    '// The `/api/v1` OpenAPI document, byte-identical to the committed `docs/openapi.json`, so',
    '// `GET /api/v1/openapi.json` can hand it back on a facade with no filesystem. A single string',
    '// rather than an object: the endpoint serves bytes, so nothing re-serialises it, and a 360 KB',
    '// object literal would cost every typecheck its structural check for nothing.',
    '',
    `export const OPENAPI_JSON = ${JSON.stringify(serializeOpenApiDoc(doc))}`,
    '',
  ].join('\n')
}

async function main() {
  const doc = await buildOpenApiDoc()
  await writeFile(OPENAPI_PATH, serializeOpenApiDoc(doc), 'utf8')
  console.log(`Wrote ${OPENAPI_PATH}`)
  await writeFile(SERVED_OPENAPI_PATH, serializeServedOpenApiDoc(doc), 'utf8')
  console.log(`Wrote ${SERVED_OPENAPI_PATH}`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
