import type {
  DescriptorFieldValues,
  UseCaseGenerationLimits,
  UseCaseNumericLimit,
  UseCaseParameter,
} from '@cat-factory/contracts'
import { renderDescriptorFieldValue } from '@cat-factory/contracts'
import type { ModelRef } from '../ports/model-provider.js'

// ---------------------------------------------------------------------------
// The INLINE USE-CASE abstraction: a named unit of NON-CONTAINER model work a deployment
// registers in code and `/api/v1/use-cases` publishes.
//
// The feature it exists for: a wrapper over this API (a game content editor, a writing surface)
// wants to run creative-writing generations on a NARROW set of models, with a form of its own
// design, without a board task, a repository, a pipeline or a container. Everything the platform
// already offers for that shape is run-scoped — a pipeline resolves a repo, dispatches agents and
// opens a pull request — so such a wrapper's only route was to hold its own model keys beside the
// deployment's, which puts the spend outside the workspace budget and the calls outside the
// telemetry the platform exists to keep.
//
// A use case is therefore three declarations and one function:
//
//   models      — the NARROWING. A use case for prose names the prose models, and nothing else
//                 is invocable through it, whatever the workspace's catalog holds.
//   parameters  — the accepted form, in the SHARED descriptor vocabulary (`form-fields.ts`), so
//                 the platform validates the caller's bag with the validator a reusable
//                 operation's brief already goes through.
//   generation  — the temperature / output-budget bounds an invocation may steer within.
//   compose     — the code that turns validated parameters into the prompt pair.
//
// Lives in kernel beside the gate / judge / task-type registries so a deployment package can
// register one with kernel (or its facade's re-export) as its only dependency.
//
// See `backend/docs/inline-use-cases.md`.
// ---------------------------------------------------------------------------

/**
 * How the platform resolves one model option to something an inline call can run.
 *
 * TWO sources, because the models a creative-writing deployment narrows to come from two
 * genuinely different places and collapsing them would lose one of them:
 *
 *  - `catalog` names a model in the platform's own curated catalog by id. It resolves through the
 *    workspace's route order, so a deployment that later adds a direct key (or an OpenRouter one)
 *    upgrades the route with no edit here, exactly as a pipeline step's pinned model does.
 *  - `provider` names a `{ provider, model }` ref outright, for a model the catalog does not carry:
 *    a fine-tune served by a deployment-registered resolver, a vendor whose whole product is prose.
 *    There is no route to prefer, which is why it carries the ref rather than an id.
 */
export type InlineUseCaseModelSource =
  | { kind: 'catalog'; modelId: string }
  | { kind: 'provider'; ref: ModelRef }

/** One model an invocation of this use case may name. */
export interface InlineUseCaseModelOption {
  /** Stable id a caller names (`magnum-v4`, `gemini-flash`). Unique within the use case. */
  id: string
  /** Human label for a picker (deployment-supplied English, rendered verbatim). */
  label: string
  /** One line on what this model is good for here. */
  description?: string
  /** How the platform resolves it. */
  source: InlineUseCaseModelSource
  /**
   * Marks the option an invocation naming no model runs on.
   *
   * Boot validation refuses SEVERAL, and refuses NONE where the use case declares more than one
   * model: a default that is positional would silently change which model every such caller gets
   * the first time someone reorders the list. A single-model use case needs no flag, since there is
   * nothing to choose between.
   */
  default?: boolean
}

/** A generation knob's bounds, as the registration declares them. */
export interface InlineUseCaseNumericLimit {
  /** Applied when the invocation omits the knob. */
  default: number
  /** The smallest value the invocation may name. */
  min: number
  /** The largest value the invocation may name. */
  max: number
}

/** What an invocation may steer besides the parameters. Either half may be omitted. */
export interface InlineUseCaseGenerationOptions {
  temperature?: Partial<InlineUseCaseNumericLimit>
  maxOutputTokens?: Partial<InlineUseCaseNumericLimit>
}

/** What `compose` is handed: the caller's validated, sanitized answers plus the use case's own id. */
export interface InlineUseCaseComposeInput {
  /** The use case being run. */
  useCaseId: string
  /** The workspace the invoking key belongs to. */
  workspaceId: string
  /** The sanitized parameter bag: declared keys only, defaults applied, hidden fields dropped. */
  parameters: DescriptorFieldValues
  /** The declared parameters, so a composer can read a field's label / options for its prose. */
  fields: readonly UseCaseParameter[]
}

/** The prompt pair one invocation runs. */
export interface InlineUseCasePrompt {
  /** The system prompt. */
  system: string
  /** The user prompt. */
  prompt: string
}

/** A deployment's registration of one inline use case. */
export interface InlineUseCaseDefinition {
  /** The namespaced id (`<ns>:<name>`), the path segment an invocation names. */
  useCaseId: string
  /** Human label for a picker. */
  label: string
  /** One line on what this use case produces. */
  description: string
  /** Optional grouping caption for a wrapper offering many use cases. */
  category?: string
  /** The models this use case may run on. Never empty (boot validation refuses an empty list). */
  models: readonly InlineUseCaseModelOption[]
  /** The accepted parameters (absent ⇒ the use case takes none). */
  parameters?: readonly UseCaseParameter[]
  /** The bounds an invocation may steer within (absent halves fall back to the platform's). */
  generation?: InlineUseCaseGenerationOptions
  /**
   * The standing instruction every invocation runs under. Required, because a use case is a
   * DECLARATION of what this deployment will generate, and one with no instruction is an
   * unrestricted model call wearing a name.
   */
  systemPrompt: string
  /**
   * Compose the prompt pair from the validated parameters. Absent ⇒ {@link renderUseCaseBrief}:
   * the declared instruction as the system prompt, and the answered parameters rendered as a
   * labelled brief. That default is what makes a use case declarable with no code at all; a
   * registration overrides it when the ordering or the phrasing of the brief is the product.
   */
  compose?: (input: InlineUseCaseComposeInput) => InlineUseCasePrompt
}

/**
 * App-owned registry of inline use cases, mirroring the agent-kind / gate / judge / task-type
 * registries. The composition root news ONE instance, a deployment registers its use cases on it
 * BY REFERENCE, and the public controller reads it back.
 *
 * `defaultInlineUseCaseRegistry()` is EMPTY: the platform ships no use case of its own, exactly as
 * it ships no custom task type. What a deployment's editor may generate is the deployment's
 * decision, and a shipped default would be a model list nobody chose.
 */
export class InlineUseCaseRegistry {
  private readonly registry = new Map<string, InlineUseCaseDefinition>()

  /** Register a use case. A registration whose id matches an earlier one replaces it. */
  register(useCase: InlineUseCaseDefinition): void {
    this.registry.set(useCase.useCaseId, useCase)
  }

  /** Register several use cases at once. */
  registerAll(useCases: Iterable<InlineUseCaseDefinition>): void {
    for (const useCase of useCases) this.register(useCase)
  }

  /** The registered use case for `useCaseId`, or undefined. */
  get(useCaseId: string): InlineUseCaseDefinition | undefined {
    return this.registry.get(useCaseId)
  }

  /** All registered use cases (registration order). */
  all(): InlineUseCaseDefinition[] {
    return [...this.registry.values()]
  }
}

/** A fresh, EMPTY use-case registry. Each facade news one and a deployment registers on it. */
export function defaultInlineUseCaseRegistry(): InlineUseCaseRegistry {
  return new InlineUseCaseRegistry()
}

/**
 * The platform's own generation bounds, applied where a registration declares none.
 *
 * The temperature ceiling is 2 because that is what the providers themselves accept, and a
 * creative-writing use case that could not reach the top of its model's own range would be a
 * narrowing the platform imposed for no reason it could state. The output default is deliberately
 * generous (a scene is longer than a verdict) and the ceiling is the point past which a single
 * synchronous call stops being a request/response shape at all.
 */
export const DEFAULT_USE_CASE_GENERATION: UseCaseGenerationLimits = {
  temperature: { default: 1, min: 0, max: 2 },
  maxOutputTokens: { default: 2_000, min: 1, max: 32_000 },
}

/** Fold a registration's declared bounds over the platform's defaults. */
function limitFor(
  declared: Partial<InlineUseCaseNumericLimit> | undefined,
  fallback: UseCaseNumericLimit,
): UseCaseNumericLimit {
  return {
    default: declared?.default ?? fallback.default,
    min: declared?.min ?? fallback.min,
    max: declared?.max ?? fallback.max,
  }
}

/** The effective bounds a use case publishes and validates against. Total; never throws. */
export function useCaseGenerationLimits(useCase: InlineUseCaseDefinition): UseCaseGenerationLimits {
  return {
    temperature: limitFor(useCase.generation?.temperature, DEFAULT_USE_CASE_GENERATION.temperature),
    maxOutputTokens: limitFor(
      useCase.generation?.maxOutputTokens,
      DEFAULT_USE_CASE_GENERATION.maxOutputTokens,
    ),
  }
}

/**
 * The option an invocation runs on: the one it named, else the declared default.
 *
 * Returns `undefined` for a named id the use case does not carry, which the caller REFUSES rather
 * than defaulting. Falling back to the default there would answer a request for one model with
 * another, which is the single thing a narrowed model list exists to prevent.
 */
export function resolveUseCaseModelOption(
  useCase: InlineUseCaseDefinition,
  requested: string | undefined,
): InlineUseCaseModelOption | undefined {
  if (requested !== undefined) return useCase.models.find((option) => option.id === requested)
  return defaultUseCaseModelOption(useCase)
}

/**
 * The option an invocation naming no model runs on: the one flagged `default`.
 *
 * Falls back to the first declared option so a registration that predates the flag still resolves
 * — boot validation is what makes the flag mandatory, and a read path that threw here would turn a
 * registration problem into a request-time crash on an unrelated call.
 */
export function defaultUseCaseModelOption(
  useCase: InlineUseCaseDefinition,
): InlineUseCaseModelOption | undefined {
  return useCase.models.find((option) => option.default) ?? useCase.models[0]
}

/**
 * The default prompt fold: the answered parameters as a labelled brief.
 *
 * Rendered through `renderDescriptorFieldValue`, the same projection a reusable operation's
 * collected values reach an agent prompt through, so a `select` reads as its caption rather than
 * its enum value and a `checkbox-group` reads as a list. Fields the caller left unanswered are
 * OMITTED rather than rendered empty: a heading with nothing under it reads to a model as an
 * instruction to invent one.
 */
export function renderUseCaseBrief(input: InlineUseCaseComposeInput): string {
  const lines: string[] = []
  for (const field of input.fields) {
    const value = input.parameters[field.key]
    if (value === undefined) continue
    lines.push(`${field.label}: ${renderDescriptorFieldValue(field, value)}`)
  }
  return lines.join('\n')
}

/** The prompt pair one invocation runs: the registration's `compose`, else the default fold. */
export function composeUseCasePrompt(
  useCase: InlineUseCaseDefinition,
  input: InlineUseCaseComposeInput,
): InlineUseCasePrompt {
  if (useCase.compose) return useCase.compose(input)
  return { system: useCase.systemPrompt, prompt: renderUseCaseBrief(input) }
}
