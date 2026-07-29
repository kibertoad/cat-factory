import type {
  FragmentBriefGenerator,
  FragmentBriefGeneratorInput,
  ModelProvider,
  ModelProviderResolver,
  ModelRef,
} from '@cat-factory/kernel'
import { ValidationError, resolveScopedModelProvider } from '@cat-factory/kernel'
import { generateText } from 'ai'
import { catFactoryObservability } from '../providers/instrumented.js'
import {
  FRAGMENT_BRIEF_AGENT_KIND,
  FRAGMENT_BRIEF_SYSTEM_PROMPT,
  renderFragmentBriefPrompt,
} from '../agents/prompts/fragment-brief.js'

// The inline LLM {@link FragmentBriefGenerator}: condenses one long best-practice standard
// into the terse variant implementer kinds fold every turn. Sits beside `LlmFragmentSelector`
// (the other inline model call this library owns) so every facade composes the same one.

export interface LlmFragmentBriefGeneratorDependencies {
  /** Resolve a {@link ModelProvider} for the run's workspace scope (DB key pool). */
  modelProviderResolver?: ModelProviderResolver
  /** Static provider (e.g. a fake in tests); used when no resolver is set. */
  modelProvider?: ModelProvider
  /** The model ref the condensation runs on; absent ⇒ the generator is disabled. */
  modelRef?: ModelRef
}

/**
 * How much output a condensation may produce. Sized off the wire cap on a LINKED brief
 * (4,000 chars ≈ 1,000 tokens) plus headroom for a reasoning model's private channel, so a
 * generated brief can never be longer than one a curator is allowed to author by hand.
 */
const MAX_BRIEF_OUTPUT_TOKENS = 4000

/** Hard ceiling on the stored brief, matching `updatePromptFragmentSchema`'s `brief` cap. */
export const MAX_GENERATED_BRIEF_CHARS = 4000

export class LlmFragmentBriefGenerator implements FragmentBriefGenerator {
  constructor(private readonly deps: LlmFragmentBriefGeneratorDependencies) {}

  get enabled(): boolean {
    return (!!this.deps.modelProviderResolver || !!this.deps.modelProvider) && !!this.deps.modelRef
  }

  async generate(
    workspaceId: string,
    input: FragmentBriefGeneratorInput,
  ): Promise<{ brief: string; model: string }> {
    const provider = await resolveScopedModelProvider({ workspaceId }, this.deps)
    const ref = this.deps.modelRef
    if (!provider || !ref) {
      throw new ValidationError('No model is configured for fragment-brief generation')
    }
    let text: string
    try {
      const result = await generateText({
        model: provider.resolve(ref),
        system: FRAGMENT_BRIEF_SYSTEM_PROMPT,
        prompt: renderFragmentBriefPrompt(input),
        temperature: 0,
        maxOutputTokens: MAX_BRIEF_OUTPUT_TOKENS,
        // Tag the workspace, not just the kind: it attributes the call on the trace AND is
        // what the inline body-recording gate consults, so an untagged call is one whose
        // workspace opt-out cannot be honoured.
        providerOptions: catFactoryObservability({
          agentKind: FRAGMENT_BRIEF_AGENT_KIND,
          workspaceId,
        }),
      })
      text = result.text
    } catch (e) {
      throw new ValidationError(
        `Fragment-brief generation (${ref.provider}:${ref.model}) failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
    }
    const brief = cleanBrief(text)
    if (!brief) {
      throw new ValidationError(
        `Fragment-brief generation (${ref.provider}:${ref.model}) returned an empty brief`,
      )
    }
    return { brief, model: `${ref.provider}:${ref.model}` }
  }
}

/**
 * Normalise the model's reply into a storable brief: strip a wrapping code fence and a
 * leading label, then clamp to {@link MAX_GENERATED_BRIEF_CHARS}.
 *
 * The clamp is a REFUSAL, not a truncation: a brief cut mid-sentence would be folded into an
 * implementer's prompt as a standard whose last rule trails off, which is worse than folding
 * the full body. An over-long reply means the condensation did not condense, so it is
 * rejected (empty ⇒ the caller falls back to the full body) rather than salvaged.
 */
export function cleanBrief(raw: string): string {
  let text = raw.trim()
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text)
  if (fenced?.[1]) text = fenced[1].trim()
  text = text.replace(/^(condensed standard|brief)\s*[:-]\s*/i, '').trim()
  return text.length > MAX_GENERATED_BRIEF_CHARS ? '' : text
}
