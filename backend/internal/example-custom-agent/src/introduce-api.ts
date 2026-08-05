import type { AgentKindRegistry } from '@cat-factory/agents'
import type {
  CustomTaskType,
  PipelineRegistry,
  PromptFragment,
  TaskTypeRegistry,
} from '@cat-factory/kernel'
import { registerPromptFragments } from '@cat-factory/prompt-fragments'

// ---------------------------------------------------------------------------
// A WORKED EXAMPLE of a REUSABLE OPERATION: "Introduce API".
//
// An operation is a canned unit of work an organisation runs again and again with per-case input
// ("expose CRUD for Order", "expose the refund operation"), leaning on the SAME standing context
// every time (the org's API guidelines, its auth requirements, the shared services it must build
// on). The vehicle is the existing custom TASK TYPE, carrying the whole bundle:
//
//   fields              -> the small per-case form, whose values reach every agent's prompt
//   defaultFragmentIds  -> the standing context, seeded onto every task of the type at creation
//   defaultPipelineId   -> the canned pipeline that delivers the outcome
//
// Nothing here is cat-factory product: the platform ships the MECHANISMS and this package plays
// the part of a proprietary org package registering its own operation through them. See
// `backend/docs/reusable-operations.md` for the model and the boundary against initiative
// presets (which are the vehicle when the work must be PLANNED and decomposed instead).
// ---------------------------------------------------------------------------

/** The operation itself: the task type a user picks on the create-task form. */
export const INTRODUCE_API_TASK_TYPE = 'org:introduce-api'
/** The canned pipeline that delivers it. */
export const INTRODUCE_API_PIPELINE_ID = 'pl_org_introduce_api'
/** The two variants that steer its design + implementation steps. */
export const ORG_ARCHITECT_API_VARIANT_ID = 'org:architect-api'
export const ORG_CODER_API_VARIANT_ID = 'org:coder-api'

/** The operation's standing context: the fragments EVERY invocation is seeded with. */
export const INTRODUCE_API_FRAGMENT_IDS = [
  'org.api-guidelines',
  'org.api-auth-requirements',
  'org.shared-services-map',
] as const

/**
 * The org's standing API standards, registered into the universal code pool. Each carries a
 * `brief` so the two-tier standards fold is exercised: an implementer kind re-sends its system
 * prompt on every turn of a long loop and folds the condensed form, while the architect and the
 * reviewers get the full body.
 */
const INTRODUCE_API_FRAGMENTS: PromptFragment[] = [
  {
    id: 'org.api-guidelines',
    version: '1.0.0',
    title: 'Org API guidelines',
    category: 'Org',
    summary: 'How this organisation shapes its HTTP APIs.',
    body:
      'Resources are plural nouns; operations are HTTP verbs, never verbs in the path. Every ' +
      'collection endpoint is paginated with a keyset cursor and returns `{ items, nextCursor }`; ' +
      'never an unbounded array. Errors use the shared envelope `{ error: { code, message, ' +
      'details } }`, where `code` is the status class and `details.reason` is the machine-readable ' +
      'cause. Every change to a published surface is additive: a new field, a new endpoint, a new ' +
      'enum member. Anything else needs a version bump and a migration window.',
    brief:
      'Plural-noun resources, verbs as HTTP methods. Keyset-paginated collections returning ' +
      '`{ items, nextCursor }`. Errors as `{ error: { code, message, details } }` with the cause ' +
      'on `details.reason`. Published surfaces change additively only.',
  },
  {
    id: 'org.api-auth-requirements',
    version: '1.0.0',
    title: 'Org API auth requirements',
    category: 'Org',
    summary: 'What every endpoint must prove before it does any work.',
    body:
      'Every endpoint authenticates before it reads anything: no route is public without an ' +
      'explicit, reviewed exemption. Service-to-service calls carry a machine token pinned to an ' +
      'audience; end-user calls carry a scoped session. Authorization is checked against the ' +
      'resource being touched, not against the route, and a denial for a resource the caller may ' +
      'not know about answers 404 rather than 403. Never log a token, an auth header or a ' +
      'decrypted credential, at any level.',
    brief:
      'Authenticate before any read; no unreviewed public routes. Machine tokens are ' +
      'audience-pinned, user calls scope-checked against the RESOURCE. Hide unknowable resources ' +
      'behind 404, never 403. Never log credentials.',
  },
  {
    id: 'org.shared-services-map',
    version: '1.0.0',
    title: 'Org shared services',
    category: 'Org',
    summary: 'The platform capabilities to build on rather than re-implement.',
    body:
      'Identity, rate limiting, audit logging and outbound notification are shared platform ' +
      'services with published contracts. Build on them: a new API must not re-implement session ' +
      'handling, roll its own quota counter, write its own audit table, or call a vendor directly ' +
      'where the notification service already fronts it. When a shared service is missing a ' +
      'capability the work needs, say so in the report rather than routing around it.',
    brief:
      'Reuse the shared identity, rate-limiting, audit and notification services; never ' +
      're-implement session handling, quotas, audit rows or direct vendor sends. Report a gap ' +
      'rather than routing around it.',
  },
]

/**
 * The task type: the operation as a user meets it. Its `fields` are the per-case brief, and they
 * are what the platform folds into every agent's prompt, which is what makes this an operation
 * rather than merely a badge on a card.
 */
export const INTRODUCE_API_TASK_TYPE_DEFINITION: CustomTaskType = {
  taskType: INTRODUCE_API_TASK_TYPE,
  presentation: {
    label: 'Introduce API',
    icon: 'i-lucide-plug',
    color: '#0ea5e9',
    description: 'Expose existing system functionality over the org’s standard HTTP API.',
    // The picker grouping axis: an org with twenty operations needs them captioned rather than
    // flattened into the built-in type row.
    category: 'API delivery',
  },
  fields: [
    {
      key: 'entity',
      label: 'Entity or capability to expose',
      type: 'text',
      required: true,
      placeholder: 'Order',
      help: 'The existing domain concept the new API surfaces. One per invocation.',
      maxLength: 120,
    },
    {
      // A multi-select rather than a comma-separated string: the answer is a closed set, so the
      // form should not ask a human to spell it, and the prompt fold joins the captions itself.
      key: 'operations',
      label: 'Operations',
      type: 'checkbox-group',
      required: true,
      help: 'Which operations to expose.',
      options: [
        { value: 'create', label: 'Create' },
        { value: 'read', label: 'Read one' },
        { value: 'list', label: 'List' },
        { value: 'update', label: 'Update' },
        { value: 'delete', label: 'Delete' },
      ],
      defaultValues: ['create', 'read', 'list'],
    },
    {
      key: 'resourceStyle',
      label: 'Resource style',
      type: 'select',
      default: 'collection',
      options: [
        { value: 'collection', label: 'Collection + item (/orders, /orders/{id})' },
        { value: 'singleton', label: 'Singleton (/orders/current)' },
        { value: 'action', label: 'Action endpoint (/orders/{id}/refund)' },
      ],
    },
    {
      // Only an ACTION endpoint has a verb to name, so the field appears when one is picked and is
      // dropped again if it is not: a stale answer from a since-changed style never reaches an agent.
      key: 'actionName',
      label: 'Action name',
      type: 'text',
      placeholder: 'refund',
      help: 'The verb the action endpoint exposes, as it should appear in the path.',
      maxLength: 60,
      showWhen: { key: 'resourceStyle', equals: 'action' },
    },
    {
      key: 'authRequirement',
      label: 'Auth requirement',
      type: 'select',
      required: true,
      options: [
        { value: 'end-user', label: 'End-user session, scope-checked' },
        { value: 'service', label: 'Service-to-service machine token' },
        { value: 'both', label: 'Both, distinguished by audience' },
      ],
    },
    {
      key: 'notes',
      label: 'Anything else the design must honour',
      type: 'textarea',
      help: 'Constraints, deadlines, the consumer that asked for it.',
      maxLength: 2000,
    },
  ],
  defaultFragmentIds: [...INTRODUCE_API_FRAGMENT_IDS],
  defaultPipelineId: INTRODUCE_API_PIPELINE_ID,
}

/**
 * Register the whole operation on the app-owned registries the composition root injects: its
 * standing-context fragments, the two variants steering its design + build steps, the canned
 * pipeline, and the task type that binds them together.
 *
 * Order matters for boot validation, not for behaviour: the pipeline is registered before the
 * task type that names it, and the variants before the pipeline that selects them, so
 * `validateRegistrations` resolves every reference.
 */
export function registerIntroduceApiOperation(
  agentKindRegistry: AgentKindRegistry,
  pipelineRegistry: PipelineRegistry,
  taskTypeRegistry: TaskTypeRegistry,
): void {
  registerPromptFragments(INTRODUCE_API_FRAGMENTS)
  // Per-KIND steering rides variants selected by the pipeline's own `stepOptions`, not a second
  // text channel on the task type: the operation OWNS its pipeline, so the per-step seam is
  // already available, and a `promptAddition` composes with (rather than displacing) both the
  // shipped prompt and a workspace's own override of it.
  agentKindRegistry.registerVariant({
    id: ORG_ARCHITECT_API_VARIANT_ID,
    baseKind: 'architect',
    promptAddition:
      'Design this API against the organisation’s standing guidelines rather than inventing a ' +
      'shape: name the resources and the exact paths, the pagination and error envelopes, and ' +
      'which shared platform services the implementation must build on. Where the task ' +
      'parameters and a guideline conflict, say so plainly instead of silently picking one.',
    presentation: {
      label: 'Org API design',
      description: 'The Architect, held to the org’s API guidelines and shared services.',
    },
  })
  agentKindRegistry.registerVariant({
    id: ORG_CODER_API_VARIANT_ID,
    baseKind: 'coder',
    promptAddition:
      'Implement the API exactly as the design names it: paths, status codes, error `code` and ' +
      '`details.reason` values, and the auth check on every route. Wire the shared platform ' +
      'services rather than re-implementing what they already do. Cover each exposed operation ' +
      'with a test that asserts its auth refusal as well as its happy path.',
    presentation: {
      label: 'Org API implementation',
      description: 'The Coder, held to the design’s named surface and the org’s auth rules.',
    },
  })
  pipelineRegistry.register({
    id: INTRODUCE_API_PIPELINE_ID,
    name: 'Introduce API',
    // The two halves of an operation's pipeline LIFECYCLE, and they buy different things.
    // `builtin: true` makes it a read-only catalog template: a workspace clones it to deviate
    // rather than editing the definition out from under the operation that pins it. The explicit
    // `version` is the ROLLOUT channel: a board seeded before the org shipped this operation is
    // offered the pipeline by the new-pipeline advisory and materialises it with one reseed, and
    // bumping the number here marks every stored copy outdated so the same reseed adopts the new
    // definition. A versionless (non-builtin) registration is the other legitimate shape (an
    // editable starting point each workspace owns), but it is ONE-SHOT: reseed refuses a stored
    // non-builtin, so the org could never roll a fix out to the boards already holding it.
    builtin: true,
    version: 1,
    agentKinds: ['architect', 'coder', 'tester-api', 'conflicts', 'ci', 'merger'],
    stepOptions: [
      { agentVariantId: ORG_ARCHITECT_API_VARIANT_ID },
      { agentVariantId: ORG_CODER_API_VARIANT_ID },
      null,
      null,
      null,
      null,
    ],
  })
  taskTypeRegistry.register(INTRODUCE_API_TASK_TYPE_DEFINITION)
}
