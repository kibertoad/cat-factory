import type {
  DescriptorFieldValues,
  PublicUseCase,
  UseCaseInvocation,
  UseCaseModel,
  UseCaseParameter,
} from '@cat-factory/contracts'
import {
  sanitizeDescriptorFields,
  validateDescriptorFields,
  withDescriptorFieldDefaults,
} from '@cat-factory/contracts'
import type {
  InlineUseCaseDefinition,
  InlineUseCaseGenerator,
  InlineUseCaseModelOption,
  InlineUseCaseRegistry,
  Logger,
} from '@cat-factory/kernel'
import {
  composeUseCasePrompt,
  NotFoundError,
  RateLimitedError,
  resolveUseCaseModelOption,
  UnavailableError,
  useCaseGenerationLimits,
  ValidationError,
} from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// The engine side of the public INLINE USE-CASE surface: everything between an authenticated
// request and the one model call, and every refusal in between.
//
// The generation itself is the injected {@link InlineUseCaseGenerator}, which is the only part
// that needs a real provider. Everything here is deterministic, which is what lets the surface's
// rules (the narrowing, the parameter validation, the bounds, the budget guard) be asserted on
// every runtime with a fake behind that seam.
//
// The one rule worth stating twice: this service NEVER substitutes a model. A caller that names a
// model the use case does not carry, or one this deployment cannot serve, is REFUSED. Resolving to
// something else would answer a narrowed request with an un-narrowed generation, which is the whole
// thing a declared model list exists to prevent, and the caller would have no way to see it
// happened.
// ---------------------------------------------------------------------------

/** What the service needs beyond the registry. */
export interface InlineUseCaseServiceDeps {
  /** The app-owned registry a deployment registered its use cases on. */
  registry: InlineUseCaseRegistry
  /** The producer that resolves a model option and runs the call. Absent ⇒ nothing is invocable. */
  generator?: InlineUseCaseGenerator
  /**
   * The workspace budget safeguard, the same one `RunAdmission` applies before a run.
   *
   * An invocation is a billable model call that no run start gates, exactly like the bug hunt's
   * ranking, so it answers to the same guard. Absent ⇒ unguarded, which is only correct for a
   * deployment that wired no spend service at all.
   */
  isOverBudget?: (workspaceId: string) => Promise<boolean>
  /** Facade logger. */
  logger?: Logger
}

/** The parameters a use case declares, as a list (absent ⇒ none). */
function parametersOf(useCase: InlineUseCaseDefinition): readonly UseCaseParameter[] {
  return useCase.parameters ?? []
}

export class InlineUseCaseService {
  constructor(private readonly deps: InlineUseCaseServiceDeps) {}

  /** Every registered use case, projected for this workspace (model availability included). */
  async list(workspaceId: string): Promise<PublicUseCase[]> {
    const useCases = this.deps.registry.all()
    // Availability is resolved per OPTION, and the options across the catalog are a bounded list a
    // deployment authored, so this is a fan-out over declared data rather than over rows: no
    // repository is touched, and the generator's own provider resolution is per workspace scope,
    // which it caches for the call.
    return Promise.all(useCases.map((useCase) => this.project(workspaceId, useCase)))
  }

  /** One registered use case by id, projected for this workspace. */
  async get(workspaceId: string, useCaseId: string): Promise<PublicUseCase> {
    return this.project(workspaceId, this.require(useCaseId))
  }

  /**
   * Run one use case and answer with the generated text.
   *
   * The refusal ORDER is the point, and it is cheapest-first for the same reason the bug hunt's is:
   * every step past the last one costs more than the step before it, so a request that was never
   * going to run spends nothing. The registration lookup and the parameter check read nothing at
   * all; the model resolution reads the workspace's credential pool; the budget probe reads the
   * spend ledger; only then does a vendor see a token.
   */
  async invoke(input: {
    workspaceId: string
    useCaseId: string
    model?: string
    parameters?: DescriptorFieldValues
    temperature?: number
    maxOutputTokens?: number
  }): Promise<UseCaseInvocation> {
    const useCase = this.require(input.useCaseId)
    const generator = this.requireGenerator()
    const parameters = this.validateParameters(useCase, input.parameters ?? {})
    const option = this.requireModelOption(useCase, input.model)
    const limits = useCaseGenerationLimits(useCase)
    const temperature = clamped(input.temperature, limits.temperature, 'temperature')
    const maxOutputTokens = clamped(
      input.maxOutputTokens,
      limits.maxOutputTokens,
      'maxOutputTokens',
    )

    const availability = await generator.availability(input.workspaceId, option)
    if (!availability.available) {
      throw new UnavailableError(
        `The model '${option.label}' cannot be served by this deployment`,
        'use_case_model_unavailable',
        { model: option.id, cause: availability.reason },
      )
    }
    if (await this.deps.isOverBudget?.(input.workspaceId)) {
      // Its OWN refusal rather than a generic failure: an exhausted budget is not a broken model,
      // and the fix (raise the budget, or wait for the window to roll) is not the fix for a
      // misconfigured provider. Fail-CLOSED, so no vendor call is made.
      throw new RateLimitedError(
        'This workspace has spent its configured model budget',
        'budget_exhausted',
      )
    }

    const prompt = composeUseCasePrompt(useCase, {
      useCaseId: useCase.useCaseId,
      workspaceId: input.workspaceId,
      parameters,
      fields: parametersOf(useCase),
    })
    const generation = await generator.generate({
      workspaceId: input.workspaceId,
      useCaseId: useCase.useCaseId,
      option,
      system: prompt.system,
      prompt: prompt.prompt,
      temperature,
      maxOutputTokens,
    })
    if (generation.text.trim() === '') {
      // An empty visible reply means the model answered only into its private reasoning channel
      // (seen on some reasoning models) or refused without saying so. Either way there is nothing
      // to return, and a 200 carrying an empty string would read to a content editor as a model
      // that had nothing to say about the scene.
      this.deps.logger?.warn('An inline use case produced no text', {
        workspaceId: input.workspaceId,
        useCaseId: useCase.useCaseId,
        model: option.id,
        finishReason: generation.finishReason,
      })
      throw new UnavailableError(
        `The model '${option.label}' returned no usable text`,
        'use_case_empty_reply',
        { model: option.id, finishReason: generation.finishReason },
      )
    }
    return {
      useCaseId: useCase.useCaseId,
      model: {
        id: option.id,
        label: option.label,
        provider: generation.ref.provider,
        model: generation.ref.model,
      },
      text: generation.text,
      finishReason: generation.finishReason,
      truncated: generation.finishReason === 'length',
      usage: generation.usage,
    }
  }

  /** The registered use case, or a 404 naming what was asked for. */
  private require(useCaseId: string): InlineUseCaseDefinition {
    const useCase = this.deps.registry.get(useCaseId)
    if (!useCase) throw new NotFoundError('Use case', useCaseId, { reason: 'use_case_not_found' })
    return useCase
  }

  /**
   * The generator, or a 503 naming the deployment-level gap.
   *
   * Distinct from a model being unavailable, which is what the per-option availability answers: an
   * unconfigured deployment is fixed by wiring a model provider, and reporting every declared model
   * as individually unavailable would send an operator looking for four missing keys instead.
   */
  private requireGenerator(): InlineUseCaseGenerator {
    const generator = this.deps.generator
    if (!generator?.enabled) {
      throw new UnavailableError(
        'No model provider is configured, so use cases cannot be invoked',
        'use_case_models_unconfigured',
      )
    }
    return generator
  }

  /**
   * The caller's bag, checked against the declared parameters and frozen.
   *
   * The SHARED descriptor validator, so this surface refuses exactly what a reusable operation's
   * create door refuses: unknown keys, wrong value types, missing required visible fields, values
   * outside a `select`'s options. Every problem is reported at once, because a caller filling a
   * form wants the whole list rather than one field per round trip.
   */
  private validateParameters(
    useCase: InlineUseCaseDefinition,
    supplied: DescriptorFieldValues,
  ): DescriptorFieldValues {
    const fields = parametersOf(useCase)
    const withDefaults = withDescriptorFieldDefaults(fields, supplied)
    const problems = validateDescriptorFields(fields, withDefaults)
    if (problems.length > 0) {
      throw new ValidationError(problems.join('; '), {
        reason: 'use_case_parameters_invalid',
        problems,
      })
    }
    return sanitizeDescriptorFields(fields, withDefaults)
  }

  /** The option the invocation runs on, or a 422 naming what this use case does carry. */
  private requireModelOption(
    useCase: InlineUseCaseDefinition,
    requested: string | undefined,
  ): InlineUseCaseModelOption {
    const option = resolveUseCaseModelOption(useCase, requested)
    if (!option) {
      throw new ValidationError(
        `The use case '${useCase.useCaseId}' does not offer a model '${requested ?? ''}'`,
        {
          reason: 'use_case_model_not_allowed',
          // The allowed ids, so a caller holding a stale catalog can correct itself from the
          // refusal rather than re-reading discovery to find out what changed.
          allowed: useCase.models.map((declared) => declared.id),
        },
      )
    }
    return option
  }

  /** One use case's wire projection, with each model's availability resolved for this workspace. */
  private async project(
    workspaceId: string,
    useCase: InlineUseCaseDefinition,
  ): Promise<PublicUseCase> {
    const models = await Promise.all(
      useCase.models.map((option) => this.projectModel(workspaceId, useCase, option)),
    )
    return {
      useCaseId: useCase.useCaseId,
      label: useCase.label,
      description: useCase.description,
      ...(useCase.category ? { category: useCase.category } : {}),
      models,
      parameters: [...parametersOf(useCase)],
      generation: useCaseGenerationLimits(useCase),
    }
  }

  /** One model option's wire projection. */
  private async projectModel(
    workspaceId: string,
    useCase: InlineUseCaseDefinition,
    option: InlineUseCaseModelOption,
  ): Promise<UseCaseModel> {
    const generator = this.deps.generator
    // With no generator there is no provider to ask, so every option is unavailable for the same
    // deployment-level cause. Reported per option rather than omitted: a wrapper rendering the
    // picker still shows what this use case OFFERS, greyed out, instead of an empty list that reads
    // like a use case with no models declared.
    const availability = generator?.enabled
      ? await generator.availability(workspaceId, option)
      : ({ available: false, reason: 'provider_unavailable' } as const)
    const isDefault = resolveUseCaseModelOption(useCase, undefined)?.id === option.id
    return {
      id: option.id,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
      default: isDefault,
      available: availability.available,
      ...(availability.available ? {} : { unavailableReason: availability.reason }),
    }
  }
}

/**
 * A knob the caller named, checked against the declared bounds, else the declared default.
 *
 * REFUSED rather than clamped. A caller asking for temperature 2.5 against a ceiling of 1.2 is
 * asking for output the deployment has decided not to produce, and silently running at 1.2 answers
 * that request with a different generation while reporting success: the caller stores the text
 * believing it came from the settings it asked for.
 */
function clamped(
  value: number | undefined,
  limit: { default: number; min: number; max: number },
  name: string,
): number {
  if (value === undefined) return limit.default
  if (!Number.isFinite(value) || value < limit.min || value > limit.max) {
    throw new ValidationError(
      `'${name}' must be between ${limit.min} and ${limit.max} for this use case`,
      { reason: 'use_case_generation_out_of_range', field: name, min: limit.min, max: limit.max },
    )
  }
  return value
}
