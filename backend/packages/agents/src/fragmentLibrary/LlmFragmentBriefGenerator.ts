import type {
  FragmentBriefGeneration,
  FragmentBriefGenerator,
  FragmentBriefGeneratorInput,
  ModelProvider,
  ModelProviderResolver,
  ModelRef,
} from '@cat-factory/kernel'
import {
  getErrorMessage,
  isUsableBrief,
  resolveScopedModelProvider,
  ValidationError,
} from '@cat-factory/kernel'
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
//
// It distinguishes the two ways a condensation can come to nothing, because they need
// opposite handling: a provider/config failure THROWS (retried next dispatch), while a model
// that answered unusably returns `not-condensable` (recorded, never re-attempted for that
// body). Whether the answer is usable is the KERNEL's rule (`isUsableBrief`) — this file owns
// only how the model is called.

export interface LlmFragmentBriefGeneratorDependencies {
  /** Resolve a {@link ModelProvider} for the run's workspace scope (DB key pool). */
  modelProviderResolver?: ModelProviderResolver
  /** Static provider (e.g. a fake in tests); used when no resolver is set. */
  modelProvider?: ModelProvider
  /** The model ref the condensation runs on; absent ⇒ the generator is disabled. */
  modelRef?: ModelRef
}

/**
 * How much output one condensation may produce, reasoning channel included.
 *
 * This is a BUDGET, not a correctness bound — the bound on what may be stored is the kernel's
 * ratio rule. Sized so a standard at the 20k wire cap on `body` has room for a faithful
 * condensation well past the ~quarter the prompt aims for. A body large enough to exhaust it
 * (only a document-backed page can be) comes back `finishReason: 'length'` and is recorded
 * `not-condensable` rather than stored half-written.
 */
const MAX_BRIEF_OUTPUT_TOKENS = 4000

export class LlmFragmentBriefGenerator implements FragmentBriefGenerator {
  constructor(private readonly deps: LlmFragmentBriefGeneratorDependencies) {}

  get enabled(): boolean {
    return (!!this.deps.modelProviderResolver || !!this.deps.modelProvider) && !!this.deps.modelRef
  }

  async generate(
    workspaceId: string,
    input: FragmentBriefGeneratorInput,
  ): Promise<FragmentBriefGeneration> {
    // The run rides the scope so the condensation's model call is attributed to the step that
    // spent it. Deliberately NO `userId`: a condensation is platform bookkeeping the engine
    // triggers, not work a person asked for, so there is no initiator to name — and naming a
    // wrong one would scope the API-key pool lease to a user who never made this call. The
    // consequence is that a brief cannot run on an individual-usage subscription (the personal
    // per-run lease needs both halves and refuses on either) — the same refusal it gave before
    // the run was threaded here, and the right one: a developer's Claude login is not a budget
    // the platform may spend on its own housekeeping.
    const provider = await resolveScopedModelProvider(
      { workspaceId, ...(input.executionId ? { executionId: input.executionId } : {}) },
      this.deps,
    )
    const ref = this.deps.modelRef
    if (!provider || !ref) {
      throw new ValidationError('No model is configured for fragment-brief generation')
    }
    const model = `${ref.provider}:${ref.model}`
    let text: string
    let finishReason: string
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
      finishReason = result.finishReason
    } catch (e) {
      // Transient: the provider is what failed, not the standard. Throwing keeps it out of
      // the store so the next dispatch tries again.
      throw new ValidationError(
        `Fragment-brief generation (${model}) failed: ${getErrorMessage(e)}`,
      )
    }
    // A reply cut off by the output budget is a standard whose last rule trails off — and it
    // can land UNDER the size bound, so nothing downstream would catch it. Same disposition
    // the incorporation loop gives a length-truncated document (`IterativeReviewService`):
    // never persist a silently-incomplete text that later readers treat as authoritative.
    if (finishReason === 'length') {
      return {
        outcome: 'not-condensable',
        model,
        reason: 'the condensation was cut short by the output budget',
      }
    }
    const brief = cleanBrief(text)
    if (!isUsableBrief(brief, input.body)) {
      return {
        outcome: 'not-condensable',
        model,
        reason: brief
          ? 'the condensation was not materially shorter than the standard'
          : 'the model returned an empty condensation',
      }
    }
    return { outcome: 'brief', brief, model }
  }
}

/**
 * Normalise the model's reply into the candidate brief: strip a wrapping code fence and a
 * leading label. Whether what remains is USABLE is the kernel's call (`isUsableBrief`), not
 * this function's — it neither truncates nor rejects, so there is exactly one place the size
 * rule lives and no way for a caller to get a silently shortened standard back.
 */
export function cleanBrief(raw: string): string {
  let text = raw.trim()
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text)
  if (fenced?.[1]) text = fenced[1].trim()
  return text.replace(/^(condensed standard|brief)\s*[:-]\s*/i, '').trim()
}
