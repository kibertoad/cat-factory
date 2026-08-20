import * as v from 'valibot'
import { descriptorFieldEntries } from './form-fields.js'
import { namespacedIdSchema } from './primitives.js'

// ---------------------------------------------------------------------------
// The wire projection of an INLINE USE CASE: a named, non-container unit of model work a
// DEPLOYMENT registers in code and `/api/v1/use-cases` publishes, so an external editor
// (a game content tool, a writing surface, any wrapper over this API) can discover what
// this deployment will generate for it, on which models, from which parameters.
//
// It is the non-container sibling of a reusable OPERATION (`task-types.ts`): an operation
// bundles a form with a pipeline that runs agents on a checkout, while a use case bundles a
// form with ONE inline model call and no repository, no run and no board row. The two share
// the descriptor-form vocabulary (`form-fields.ts`) on purpose, so a deployment authoring both
// writes one kind of form and the platform runs one validator over them.
//
// Everything here is DATA about a registration. The registration's own prompt composition is
// code (kernel's `InlineUseCaseDefinition`), and is deliberately not published: what a caller
// needs to call the surface is the parameter list, the model choice and the generation bounds.
// ---------------------------------------------------------------------------

/**
 * Which of the shared descriptor-form input types a use-case parameter may declare.
 *
 * Two members of the shared vocabulary are excluded by construction rather than by convention:
 *
 *  - `password`, for the reason a task-type field excludes it: a collected value is folded into
 *    the model prompt and captured in call telemetry, so it is the wrong home for a secret. A
 *    use case whose model needs a credential declares it by NAME against the capability-credential
 *    store, where the value never reaches a prompt.
 *  - `path`, because it means a repo-relative directory and is validated as one. Non-container
 *    work has no checkout, so the field would collect a path against a repository that does not
 *    exist for this call: a control whose only possible answers are wrong.
 */
export const useCaseParameterTypeSchema = v.picklist([
  'text',
  'textarea',
  'number',
  'select',
  'checkbox',
  'checkbox-group',
])
export type UseCaseParameterType = v.InferOutput<typeof useCaseParameterTypeSchema>

/**
 * One accepted parameter of a use case: the SHARED descriptor-form vocabulary narrowed to the
 * types above, so `validateDescriptorFields` / `sanitizeDescriptorFields` /
 * `renderDescriptorFieldValue` apply verbatim and a wrapper that renders a task type's form can
 * render this one with the same component.
 */
export const useCaseParameterSchema = v.object({
  ...descriptorFieldEntries,
  /** The control type; absent is treated as `text`. */
  type: v.optional(useCaseParameterTypeSchema),
})
export type UseCaseParameter = v.InferOutput<typeof useCaseParameterSchema>

/**
 * The bounds on a use case's own captions, as VALUES rather than only as schema internals.
 *
 * Published because two guards must agree on them: the schemas below (what the surface promises,
 * and what the four generated SDKs document as guaranteed) and boot validation (which refuses a
 * registration that would violate them). A response is not re-validated on the way out, so a
 * registration with an empty `label` would otherwise serve a shape this file's own OpenAPI says is
 * impossible, and nothing would fail.
 */
export const USE_CASE_TEXT_LIMITS = {
  label: 120,
  description: 500,
  category: 60,
  modelId: 120,
} as const

/**
 * Why a model this use case names cannot be served by THIS deployment right now.
 *
 * Two causes, and they lead to different places, which is why they are not one flag:
 *
 *  - `provider_unavailable`: nothing resolves the model here, because the catalog id has no route
 *    this workspace can take, or no resolver is registered for the ref's provider (no key
 *    configured). An operator fixes it by configuring the provider.
 *  - `container_only`: the model resolves, but only through a subscription HARNESS that runs
 *    inside a per-run container, which a use case has none of. Nothing an operator configures on
 *    this deployment changes that; the caller picks another model.
 */
export const USE_CASE_MODEL_UNAVAILABLE_REASONS = [
  'provider_unavailable',
  'container_only',
] as const
export type UseCaseModelUnavailableReason = (typeof USE_CASE_MODEL_UNAVAILABLE_REASONS)[number]

/**
 * One model a use case may run on, as published.
 *
 * `available` is answered per REQUEST rather than baked into the registration, because the answer
 * is a property of the deployment's configured credentials and this workspace's routes, not of the
 * use case. A discovery read that listed a model the invocation would then refuse would send a
 * caller to a choice that cannot work, so an unavailable model is listed WITH its reason rather
 * than hidden: a wrapper can tell "this deployment never offers Magnum" from "nobody has
 * configured the key yet", and those have different owners.
 */
export const useCaseModelSchema = v.object({
  /** The id a caller names in an invocation, and the id discovery publishes. */
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(USE_CASE_TEXT_LIMITS.modelId)),
  /** Human label for a picker (deployment-supplied English, rendered verbatim). */
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(USE_CASE_TEXT_LIMITS.label)),
  /** One line on what this model is good for here (deployment-supplied English). */
  description: v.optional(v.pipe(v.string(), v.maxLength(USE_CASE_TEXT_LIMITS.description))),
  /** Whether this is the model an invocation naming none runs on. Exactly one option is. */
  default: v.boolean(),
  /** Whether an invocation naming this model could run right now. */
  available: v.boolean(),
  /** Present only when `available` is false: which of the two causes it is. */
  unavailableReason: v.optional(v.picklist(USE_CASE_MODEL_UNAVAILABLE_REASONS)),
})
export type UseCaseModel = v.InferOutput<typeof useCaseModelSchema>

/** A generation knob a caller may set, with the bounds the registration declares. */
export const useCaseNumericLimitSchema = v.object({
  /** Applied when the invocation omits the knob. */
  default: v.number(),
  /** The smallest value the invocation may name. */
  min: v.number(),
  /** The largest value the invocation may name. */
  max: v.number(),
})
export type UseCaseNumericLimit = v.InferOutput<typeof useCaseNumericLimitSchema>

/**
 * What an invocation may steer besides the parameters, and within which bounds.
 *
 * Published because a caller that cannot see the bounds discovers them by being refused. Both
 * knobs are ALWAYS present: a registration that declares neither still has effective values (the
 * platform's own defaults), and publishing them as absent would read as "you may send anything".
 */
export const useCaseGenerationLimitsSchema = v.object({
  /** Sampling temperature. Creative work lives on this knob, so a use case usually widens it. */
  temperature: useCaseNumericLimitSchema,
  /** The reply budget, in tokens. */
  maxOutputTokens: useCaseNumericLimitSchema,
})
export type UseCaseGenerationLimits = v.InferOutput<typeof useCaseGenerationLimitsSchema>

/** One registered use case, as `/api/v1/use-cases` publishes it. */
export const publicUseCaseSchema = v.object({
  /** The namespaced id (`<ns>:<name>`, e.g. `stefka:scene-prose`). */
  useCaseId: namespacedIdSchema,
  /** Human label for a picker. */
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(USE_CASE_TEXT_LIMITS.label)),
  /** One line on what this use case produces. */
  description: v.pipe(v.string(), v.minLength(1), v.maxLength(USE_CASE_TEXT_LIMITS.description)),
  /** Optional grouping caption, so a wrapper offering twenty use cases can group them. */
  category: v.optional(
    v.pipe(v.string(), v.minLength(1), v.maxLength(USE_CASE_TEXT_LIMITS.category)),
  ),
  /** The models this use case may run on, narrowed by the registration. Never empty. */
  models: v.array(useCaseModelSchema),
  /** The accepted parameters (empty ⇒ the use case takes none). */
  parameters: v.array(useCaseParameterSchema),
  /** What an invocation may steer, and within which bounds. */
  generation: useCaseGenerationLimitsSchema,
})
export type PublicUseCase = v.InferOutput<typeof publicUseCaseSchema>

/** The whole catalog this key's workspace may invoke, in registration order. */
export const publicUseCaseListSchema = v.object({
  useCases: v.array(publicUseCaseSchema),
})
export type PublicUseCaseList = v.InferOutput<typeof publicUseCaseListSchema>

/** Bound on one parameter value; the shared descriptor bound, restated for the request body. */
const parameterValueSchema = v.union([
  v.pipe(v.string(), v.maxLength(20_000)),
  v.pipe(v.array(v.pipe(v.string(), v.maxLength(2_000))), v.maxLength(50)),
  v.boolean(),
  v.number(),
])

/**
 * The invocation body.
 *
 * `parameters` is deliberately a free-form bag validated against the REGISTRATION rather than
 * against a schema minted per use case: the descriptors are deployment data, so the wire schema
 * cannot know them, and the registration's own validator is the one door every caller (this
 * surface, an SDK, the MCP projection) goes through.
 *
 * The bound here is wider than a task-type field's 2,000 characters on purpose: a creative-writing
 * use case is handed the story so far, and truncating that to a form-field bound would silently
 * change what the model was asked about. A registration narrows it per field with `maxLength`.
 */
export const invokeUseCaseSchema = v.object({
  /** The model option id to run on; absent ⇒ the use case's default option. */
  model: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(120))),
  /** The filled parameters, keyed by the descriptor `key`. */
  parameters: v.optional(
    v.record(v.pipe(v.string(), v.minLength(1), v.maxLength(80)), parameterValueSchema),
  ),
  /** Sampling temperature, within the published bounds; absent ⇒ the published default. */
  temperature: v.optional(v.number()),
  /** Reply budget in tokens, within the published bounds; absent ⇒ the published default. */
  maxOutputTokens: v.optional(v.number()),
})
export type InvokeUseCase = v.InferOutput<typeof invokeUseCaseSchema>

/**
 * Why the model stopped, as a bounded class.
 *
 * `length` is the one that changes what the caller must DO: the text is a prefix of the answer,
 * not the answer, and a consumer that pastes it into a game script would ship a sentence that
 * stops mid-word. It rides `truncated` beside it so the common check is a boolean and the cause
 * is still nameable.
 */
export const USE_CASE_FINISH_REASONS = ['stop', 'length', 'content-filter', 'other'] as const
export type UseCaseFinishReason = (typeof USE_CASE_FINISH_REASONS)[number]

/**
 * What one invocation cost, as the provider reported it.
 *
 * The three numbers ALWAYS add up, which is a choice: `inputTokens` is the whole billed input
 * (both cache classes included, reconciled across the two shapes vendors report them in), so
 * publishing a provider's own `total` beside it would let a cache-heavy call answer with three
 * figures that disagree, and a wrapper metering its own users off them would under-bill silently.
 */
export const useCaseUsageSchema = v.object({
  /** Input tokens the provider billed, both cache classes included. */
  inputTokens: v.number(),
  /** Output tokens the provider billed. */
  outputTokens: v.number(),
  /** The sum of the two above. */
  totalTokens: v.number(),
})
export type UseCaseUsage = v.InferOutput<typeof useCaseUsageSchema>

/** The result of one invocation. */
export const useCaseInvocationSchema = v.object({
  /** The use case that produced it. */
  useCaseId: namespacedIdSchema,
  /** The model option it actually ran on (never a substitute the caller did not name). */
  model: v.object({
    id: v.string(),
    label: v.string(),
    /** The resolved provider id and model id, so a caller can attribute the text it stores. */
    provider: v.string(),
    model: v.string(),
  }),
  /** The generated text. */
  text: v.string(),
  /** Why the model stopped. */
  finishReason: v.picklist(USE_CASE_FINISH_REASONS),
  /** Whether the reply hit the output budget, so `text` is a prefix rather than an answer. */
  truncated: v.boolean(),
  /** What the call cost. */
  usage: useCaseUsageSchema,
})
export type UseCaseInvocation = v.InferOutput<typeof useCaseInvocationSchema>
