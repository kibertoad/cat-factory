import { generateText } from 'ai'
import {
  type ModelProvider,
  type ModelProviderResolver,
  type ModelRef,
  type ResolveBlockRunContext,
  STAGE_ACCEPTANCE_KIND,
  type StageAcceptanceAssessor,
  type StageAcceptanceSubject,
  ValidationError,
  extractJson,
  getErrorMessage,
  resolveInlineScope,
  resolveScopedModelProvider,
} from '@cat-factory/kernel'
import {
  STAGE_ACCEPTANCE_SYSTEM_PROMPT,
  catFactoryObservability,
  renderStageAcceptancePrompt,
} from '@cat-factory/agents'
import { type InlineBlockModelDeps, resolveInlineBlockModel } from '../../inlineBlockModel.js'

/** What the inline assessment needs to resolve its model and reach the provider. */
export interface StageAcceptanceServiceDeps {
  modelProviderResolver?: ModelProviderResolver
  modelProvider?: ModelProvider
  /** Routing-default model ref when the task pins none. */
  modelRef?: ModelRef
  resolveBlockModel?: InlineBlockModelDeps['resolveBlockModel']
  runsInline?: (ref: ModelRef) => boolean
  resolvePresetRouting?: InlineBlockModelDeps['resolvePresetRouting']
  /** The task's run and initiator, folded into the credential scope. */
  resolveRunContext?: ResolveBlockRunContext
}

/**
 * The inline producer behind a stage's exit-criteria assessment. It runs under the stage task's
 * own credential scope and under its own kind, so a workspace can give it a model of its own and
 * its spend lands on a line of its own.
 */
export class StageAcceptanceService implements StageAcceptanceAssessor {
  constructor(private readonly deps: StageAcceptanceServiceDeps) {}

  get enabled(): boolean {
    return (!!this.deps.modelProviderResolver || !!this.deps.modelProvider) && !!this.deps.modelRef
  }

  async assess(subject: StageAcceptanceSubject): Promise<{ reply: unknown; model: string }> {
    const { workspaceId, block } = subject
    const scope = await resolveInlineScope(
      { kind: 'block', workspaceId, block },
      this.deps.resolveRunContext,
    )
    const modelProvider = await resolveScopedModelProvider(scope, this.deps)
    const { ref } = await resolveInlineBlockModel(
      this.deps,
      workspaceId,
      STAGE_ACCEPTANCE_KIND,
      block,
    )
    if (!modelProvider || !ref) {
      throw new ValidationError('No model is configured for the acceptance assessment')
    }
    let text: string
    try {
      const result = await generateText({
        model: modelProvider.resolve(ref),
        system: STAGE_ACCEPTANCE_SYSTEM_PROMPT,
        prompt: renderStageAcceptancePrompt(subject),
        temperature: 0,
        maxOutputTokens: 4000,
        providerOptions: catFactoryObservability({ agentKind: STAGE_ACCEPTANCE_KIND, workspaceId }),
      })
      text = result.text
    } catch (e) {
      throw new ValidationError(
        `The acceptance assessment (${ref.provider}:${ref.model}) failed: ${getErrorMessage(e)}`,
      )
    }
    const reply = extractJson(text)
    if (reply === null || typeof reply !== 'object') {
      throw new ValidationError(
        `The acceptance assessment (${ref.provider}:${ref.model}) returned no JSON object`,
      )
    }
    return { reply, model: `${ref.provider}:${ref.model}` }
  }
}
