import { generateText } from 'ai'
import {
  ASSISTANT_AGENT_KIND,
  ASSISTANT_SYSTEM_PROMPT,
  catFactoryObservability,
  renderAssistantPrompt,
} from '@cat-factory/agents'
import type {
  AssistantActionId,
  AssistantAnswer,
  AssistantCapability,
  AssistantTurn,
  AssistantTurnInput,
  BlockEditAuthority,
  DescriptorField,
  DescriptorFieldValues,
} from '@cat-factory/contracts'
import { validateDescriptorFields } from '@cat-factory/contracts'
import type { Logger, ModelProvider, ModelProviderResolver, ModelRef } from '@cat-factory/kernel'
import {
  describeError,
  extractJson,
  getErrorMessage,
  RateLimitedError,
  resolveInlineScope,
  resolveScopedModelProvider,
  UnavailableError,
} from '@cat-factory/kernel'
import { type InlineBlockModelDeps, resolveInlineBlockModelRef } from '../../inlineBlockModel.js'
import {
  assistantActionBriefs,
  keepDeclaredArguments,
  readAssistantSelection,
} from './assistant.logic.js'
import type { AssistantActionDefinition, AssistantActionOutcome } from './types.js'

// ---------------------------------------------------------------------------
// The IN-APP ASSISTANT: one prompt, one inline model call that ROUTES it, one action performed by
// the platform.
//
// Structurally the `BugHuntAssessorService` twin (an un-run-scoped inline call built from the
// model dependencies every facade already wires, so the feature needs no per-facade wiring of its
// own), and it inherits that service's two standing obligations for such a call: it answers to the
// workspace BUDGET that no run start gates it behind, and it degrades a container-only
// subscription ref to something an inline `generateText` can serve.
//
// What is different, and is the whole point of the surface, is that the reply is not an answer to
// show anyone. It is a ROUTING DECISION the platform then acts on, so everything between the model
// and the side effect is deterministic: the reply is parsed, the chosen id is looked up in a
// catalog the model was shown, the arguments are validated by the shared descriptor validator, and
// the action resolves every name against the board itself. A model that hallucinates an action id,
// invents an argument key, or names a service that does not exist changes nothing: those are a
// decline, a dropped key and a question with candidates, in that order.
// ---------------------------------------------------------------------------

/**
 * The reply budget for one routing decision.
 *
 * Small, because the deliverable is a two-field JSON object naming an id and copying a URL. It is
 * not tight enough to truncate a legitimate answer, and a model that needs more than this is not
 * answering the question it was asked.
 */
const MAX_OUTPUT_TOKENS = 800

/**
 * Routing must be reproducible: the same sentence against the same board has one right action, and
 * a person who re-types a request that was declined needs the second attempt to differ because
 * THEY changed something. Same value and same reasoning as the judge and bug-hunt assessments.
 */
const TEMPERATURE = 0

export interface AssistantServiceDeps extends InlineBlockModelDeps {
  /** The actions this deployment can perform, in catalog order. */
  actions: readonly AssistantActionDefinition[]
  /** Resolve a ModelProvider for a workspace's credential scope (preferred). */
  modelProviderResolver?: ModelProviderResolver
  /** Static provider (e.g. a fake in tests) used when no resolver is set. */
  modelProvider?: ModelProvider
  /**
   * The workspace budget safeguard, the same one `RunAdmission` applies before a run.
   *
   * A turn is a billable model call that no run start gates, exactly like the bug hunt's ranking
   * and the monorepo survey, so it answers to the same guard. Absent ⇒ unguarded, which is only
   * correct for a deployment that wired no spend service at all.
   */
  isOverBudget?: (workspaceId: string) => Promise<boolean>
  /** Facade logger; a turn that could not be routed and left no trace is an unowned bug. */
  logger?: Logger
}

/** One turn's request. */
export interface AssistantTurnRequest {
  workspaceId: string
  /** What the person typed, or the answer to a question a previous turn asked. */
  input: AssistantTurnInput
  /** Whose tier every board write the chosen action makes is judged under (ADR 0037). */
  editor: BlockEditAuthority
  /** The acting user, recorded as the author of what the action creates. */
  userId: string | null
}

export class AssistantService {
  constructor(private readonly deps: AssistantServiceDeps) {}

  /** Whether a turn can run at all (some provider is wired), and what it could do. */
  get enabled(): boolean {
    return !!this.deps.modelProviderResolver || !!this.deps.modelProvider
  }

  /** What this deployment's assistant offers, read before the prompt box is shown. */
  capability(): AssistantCapability {
    return {
      available: this.enabled,
      actions: this.deps.actions.map((action) => action.actionId),
    }
  }

  /**
   * Run one turn: route a sentence and perform what it named, or perform the ANSWER to the
   * question the last turn asked.
   *
   * The two halves share everything after the action is known (argument validation, the run, the
   * outcome) and nothing before it. An ANSWER reaches no model, which is not an optimisation: a
   * clarification whose answer went back through the router could route somewhere else, and a
   * question the platform asked deserves an answer the platform honours literally.
   */
  async run(request: AssistantTurnRequest): Promise<AssistantTurn> {
    const { actions } = this.deps
    if (actions.length === 0) {
      throw new UnavailableError(
        'The assistant has no actions configured on this deployment',
        'assistant_no_actions',
      )
    }
    return request.input.kind === 'answer'
      ? this.answer(request, request.input.answer)
      : this.route(request, request.input.prompt)
  }

  /**
   * Perform what a previous turn's question was heading for, with the answered field filled in.
   *
   * No model, so no budget probe either: nothing here is billable. The arguments are the ones the
   * platform itself put on that outcome, and they are re-validated anyway, so what a client may
   * ask for is exactly what the prompt path could already have produced.
   */
  private async answer(
    request: AssistantTurnRequest,
    answer: AssistantAnswer,
  ): Promise<AssistantTurn> {
    const action = this.deps.actions.find((candidate) => candidate.actionId === answer.actionId)
    if (!action) {
      // The deployment's catalog changed under a question it had already asked (an integration
      // unwired between the two turns). Reported as the same decline a hallucinated id gets,
      // because it means the same thing to the person: this deployment no longer does that.
      return { outcome: { status: 'declined', reason: 'no_matching_action' }, model: null }
    }
    return { outcome: await this.perform(request, action, answer.arguments), model: null }
  }

  /**
   * Read a sentence, name one action, perform it.
   *
   * The refusal ORDER is cheapest-first, on the same reading as the inline use-case surface: a
   * request that was never going to run should spend nothing. A missing provider is answered from
   * memory; the budget probe reads the spend ledger; only then does a vendor see a token.
   */
  private async route(request: AssistantTurnRequest, prompt: string): Promise<AssistantTurn> {
    const { modelProvider, ref } = await this.resolveModel(request)
    if (await this.deps.isOverBudget?.(request.workspaceId)) {
      // Its OWN refusal rather than a generic failure, and fail-CLOSED so no vendor call is made:
      // an exhausted budget is not a broken assistant, and the fix (raise the budget, or wait for
      // the window to roll) is not the fix for a misconfigured provider.
      throw new RateLimitedError(
        'This workspace has spent its configured model budget',
        'budget_exhausted',
      )
    }

    const model = { provider: ref.provider, model: ref.model }
    const selection = readAssistantSelection(
      extractJson(await this.generate(request.workspaceId, prompt, modelProvider, ref)),
    )
    if (selection.kind === 'unreadable') {
      // An empty visible reply means the model answered only into its private reasoning channel
      // (seen on some reasoning models); a non-JSON one means it ignored the contract. Either way
      // there is no routing decision, and acting on a guess is the one thing this surface must not
      // do, so it says the reply could not be read rather than declining, which would tell the
      // person their request was understood and rejected.
      this.deps.logger?.warn('An assistant turn produced no readable routing decision', {
        workspaceId: request.workspaceId,
        model: `${ref.provider}:${ref.model}`,
      })
      throw new UnavailableError(
        `The assistant model (${ref.provider}:${ref.model}) returned no usable answer`,
        'assistant_reply_unreadable',
      )
    }
    if (selection.kind === 'none') {
      return { outcome: { status: 'declined', reason: 'no_matching_action' }, model }
    }
    const action = this.deps.actions.find((candidate) => candidate.actionId === selection.actionId)
    if (!action) {
      // An id outside the catalog it was shown. Reported as "nothing here does that" rather than
      // as a model failure, because that is what it means to the person: whatever the model
      // thought it was naming, this deployment does not offer it.
      this.deps.logger?.debug('An assistant turn named an unknown action', {
        workspaceId: request.workspaceId,
        action: selection.actionId,
      })
      return { outcome: { status: 'declined', reason: 'no_matching_action' }, model }
    }
    return { outcome: await this.perform(request, action, selection.arguments), model }
  }

  /**
   * Everything between a NAMED action and the turn's outcome: validate, run, report.
   *
   * The one path both halves of `run` share, and deliberately so. A routed turn and an answered
   * one differ only in where the arguments came from, and letting the answer skip a rule the
   * router applies is how a second, weaker door gets built beside the first.
   */
  private async perform(
    request: AssistantTurnRequest,
    action: AssistantActionDefinition,
    supplied: Record<string, string>,
  ): Promise<AssistantTurn['outcome']> {
    const args = keepDeclaredArguments(action.parameters, supplied)
    const invalid = firstInvalidArgument(action.parameters, args)
    if (invalid) {
      return clarification(action.actionId, args, {
        status: 'needs_input',
        reason: 'invalid_argument',
        field: invalid,
        candidates: [],
      })
    }
    const outcome = await action.run({
      workspaceId: request.workspaceId,
      arguments: args,
      editor: request.editor,
      userId: request.userId,
    })
    return outcome.status === 'performed'
      ? { status: 'performed', result: outcome.result }
      : clarification(action.actionId, args, outcome)
  }

  /** The one model call: the catalog and the request in, the raw reply out. */
  private async generate(
    workspaceId: string,
    prompt: string,
    modelProvider: ModelProvider,
    ref: ModelRef,
  ): Promise<string> {
    try {
      const result = await generateText({
        model: modelProvider.resolve(ref),
        system: ASSISTANT_SYSTEM_PROMPT,
        prompt: renderAssistantPrompt(assistantActionBriefs(this.deps.actions), prompt),
        temperature: TEMPERATURE,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        providerOptions: catFactoryObservability({
          agentKind: ASSISTANT_AGENT_KIND,
          workspaceId,
        }),
      })
      return result.text
    } catch (error) {
      const message = `The assistant model (${ref.provider}:${ref.model}) failed: ${getErrorMessage(error)}`
      this.deps.logger?.warn(message, { workspaceId, ...describeError(error) })
      throw new UnavailableError(message, 'assistant_generation_failed')
    }
  }

  /**
   * The provider and ref a turn runs on, or the 503 naming the deployment-level gap.
   *
   * An EMPTY selection, on the bug hunt's reading: a turn routes a sentence, not a task, so
   * nothing pins a model or picks a preset and the workspace DEFAULT preset supplies both the
   * model and the route order.
   */
  private async resolveModel(
    request: AssistantTurnRequest,
  ): Promise<{ modelProvider: ModelProvider; ref: ModelRef }> {
    const { workspaceId } = request
    // A USER subject: a turn has no run, but it always has an asker, and both halves of that
    // matter. The asker's own API keys and local model endpoints join the credential pool, and an
    // individual-usage subscription is leasable through their user activation scope, which is the
    // only reason a Claude-preset workspace can run this surface on the model it picked. A
    // workspace-only scope would resolve, answer, and quietly bill a different model.
    const scope = await resolveInlineScope(
      request.userId
        ? { kind: 'user', workspaceId, userId: request.userId }
        : // No signed-in user is reachable on an unauthenticated deployment. Stated rather than
          // defaulted, so the narrower pool is a readable consequence of that and not of a
          // forgotten field.
          { kind: 'workspace', workspaceId },
    )
    const modelProvider = await resolveScopedModelProvider(scope, this.deps)
    const ref = await resolveInlineBlockModelRef(this.deps, workspaceId, ASSISTANT_AGENT_KIND, {})
    if (!modelProvider || !ref) {
      throw new UnavailableError(
        'No model is configured for the assistant',
        'assistant_model_unavailable',
      )
    }
    return { modelProvider, ref }
  }
}

/**
 * A clarification as it goes on the wire: the action it was heading for, plus the arguments the
 * turn resolved, so the next turn can answer it instead of re-reading a rewritten sentence.
 *
 * One place rather than two literals, because the ARGUMENTS are the half that is easy to forget
 * and impossible to notice missing: the outcome still renders, the chips still appear, and every
 * one of them answers into an empty argument bag.
 */
function clarification(
  actionId: AssistantActionId,
  args: DescriptorFieldValues,
  outcome: Extract<AssistantActionOutcome, { status: 'needs_input' }>,
): AssistantTurn['outcome'] {
  return {
    status: 'needs_input',
    actionId,
    reason: outcome.reason,
    field: outcome.field,
    candidates: outcome.candidates,
    arguments: stringArguments(args),
  }
}

/**
 * The validated arguments as the wire shape, dropping any value that is not a string.
 *
 * `DescriptorFieldValues` admits booleans and numbers for the field types that declare them; the
 * assistant's own parameters are all strings today, and a value with no string form is left OUT
 * rather than stringified, because a `"false"` coming back as an answer would be a value nobody
 * chose.
 */
function stringArguments(args: DescriptorFieldValues): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

/**
 * The first argument whose VALUE the shared descriptor rules refuse, or undefined.
 *
 * Field by field, over the keys the reply actually supplied, so the check reports WHICH argument
 * is unusable, where the whole-bag validator answers with prose the SPA cannot localize and cannot
 * point at a field with. Required-but-absent is deliberately not judged here: an argument the
 * model omitted is the action's own question to ask, since only the action knows whether it can
 * derive the value from something else it was given.
 */
function firstInvalidArgument(
  fields: readonly DescriptorField[],
  values: DescriptorFieldValues,
): string | undefined {
  for (const field of fields) {
    const value = values[field.key]
    if (value === undefined) continue
    if (validateDescriptorFields([field], { [field.key]: value }).length > 0) return field.key
  }
  return undefined
}
