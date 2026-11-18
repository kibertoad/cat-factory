import { generateText } from 'ai'
import {
  type Block,
  type JudgeModelPin,
  type ModelProvider,
  type ModelProviderResolver,
  type ModelRef,
  type ResolveBlockRunContext,
  ValidationError,
  extractJson,
  getErrorMessage,
  resolveInlineScope,
  resolveScopedModelProvider,
} from '@cat-factory/kernel'
import { catFactoryObservability } from '@cat-factory/agents'
import { type InlineBlockModelDeps, resolveInlineBlockModel } from '../../inlineBlockModel.js'

// One inline model call that answers a JSON object about a block's work, shared by the producers
// that assess a run's output (the judges, a project stage's acceptance criteria): the block's
// credential scope, the model resolved under the producer's own kind, a reproducible temperature,
// a bounded wait, and a refusal for a reply with no JSON object in it.

export interface InlineJsonAssessmentDeps {
  modelProviderResolver?: ModelProviderResolver
  modelProvider?: ModelProvider
  /** Routing-default model ref when the block pins none. */
  modelRef?: ModelRef
  resolveBlockModel?: InlineBlockModelDeps['resolveBlockModel']
  runsInline?: (ref: ModelRef) => boolean
  resolvePresetRouting?: InlineBlockModelDeps['resolvePresetRouting']
  /** The block's run and initiator, folded into the credential scope. */
  resolveRunContext?: ResolveBlockRunContext
}

/** Whether a call can run at all: a provider and a routing default are wired. */
export function inlineJsonAssessmentEnabled(deps: InlineJsonAssessmentDeps): boolean {
  return (!!deps.modelProviderResolver || !!deps.modelProvider) && !!deps.modelRef
}

export interface InlineJsonAssessmentRequest {
  workspaceId: string
  block: Block
  /** The kind the model resolves under and the spend is attributed to. */
  kind: string
  /** A catalog model id the caller pins, applied below the task's own pin. */
  modelId?: string
  /** Names the assessment in a refusal, e.g. `judge assessment`. */
  label: string
  system: string
  prompt: string
  maxOutputTokens: number
  /** How long the call may take before it is abandoned. */
  timeoutMs: number
}

/**
 * Run the call and return the JSON object it replied with, the model, and what became of a pinned
 * model. Throws a `ValidationError` naming `label` on an unresolved model, a failed or timed-out
 * generation, or a reply with no JSON object in it.
 */
export async function runInlineJsonAssessment(
  deps: InlineJsonAssessmentDeps,
  request: InlineJsonAssessmentRequest,
): Promise<{ value: object; model: string; pin?: JudgeModelPin }> {
  const { workspaceId, block } = request
  const scope = await resolveInlineScope(
    { kind: 'block', workspaceId, block },
    deps.resolveRunContext,
  )
  const modelProvider = await resolveScopedModelProvider(scope, deps)
  const { ref, pin } = await resolveInlineBlockModel(
    deps,
    workspaceId,
    request.kind,
    block,
    request.modelId,
  )
  if (!modelProvider || !ref) {
    throw new ValidationError(`No model is configured for the ${request.label}`)
  }
  const model = `${ref.provider}:${ref.model}`
  let text: string
  try {
    const result = await generateText({
      model: modelProvider.resolve(ref),
      system: request.system,
      prompt: request.prompt,
      // An assessment should be reproducible for the same evidence.
      temperature: 0,
      maxOutputTokens: request.maxOutputTokens,
      abortSignal: AbortSignal.timeout(request.timeoutMs),
      providerOptions: catFactoryObservability({ agentKind: request.kind, workspaceId }),
    })
    text = result.text
  } catch (e) {
    throw new ValidationError(`The ${request.label} (${model}) failed: ${getErrorMessage(e)}`)
  }
  const value = extractJson(text)
  if (value === null || typeof value !== 'object') {
    throw new ValidationError(`The ${request.label} (${model}) returned no JSON object`)
  }
  return { value, model, ...(pin ? { pin } : {}) }
}
