import { generateText } from 'ai'
import type { ModelProvider, ModelProviderResolver, ModelRef } from '@cat-factory/kernel'
import { resolveScopedModelProvider, ValidationError } from '@cat-factory/kernel'
import {
  catFactoryObservability,
  FRAGMENT_TITLE_AGENT_KIND,
  FRAGMENT_TITLE_SYSTEM_PROMPT,
  renderFragmentTitlePrompt,
} from '@cat-factory/agents'

// ---------------------------------------------------------------------------
// The prompt-fragment TITLE generator — the inline LLM call behind the fragment
// editor's "auto-generate title" button. A one-shot completion (no thread, no
// tools): resolve the workspace's model provider, run `generateText` over the
// fragment's body + optional summary, and return a short title. Deliberately
// STATELESS and workspace-scoped (a title has no block context). Mirrors
// `ForkChatService`'s inline-model resolution + observability. When no model is
// wired the service is `enabled === false` and the controller returns 503.
// ---------------------------------------------------------------------------

/** What the title generator needs to resolve its inline model and reach the provider. */
export interface FragmentTitleDeps {
  /** Resolve a ModelProvider for a workspace's credential scope (preferred). */
  modelProviderResolver?: ModelProviderResolver
  /** Static provider (e.g. a fake in tests) used when no resolver is set. */
  modelProvider?: ModelProvider
  /** The model ref the title generator runs on (a small, cheap default is fine). */
  modelRef?: ModelRef
}

export class FragmentTitleService {
  constructor(private readonly deps: FragmentTitleDeps) {}

  /** Whether the generator is available (a provider AND a model ref are wired). */
  get enabled(): boolean {
    return (!!this.deps.modelProviderResolver || !!this.deps.modelProvider) && !!this.deps.modelRef
  }

  /**
   * Suggest a concise title for a fragment from its body (+ optional summary), resolving the
   * model provider for `workspaceId`'s credential scope. Throws {@link ValidationError} on an
   * unresolved model or an empty/failed generation so the controller returns a clean error.
   */
  async generate(
    workspaceId: string,
    input: { body: string; summary?: string },
  ): Promise<{ title: string; model: string }> {
    const provider = await resolveScopedModelProvider({ workspaceId }, this.deps)
    const ref = this.deps.modelRef
    if (!provider || !ref) {
      throw new ValidationError('No model is configured for fragment-title generation')
    }
    let text: string
    try {
      const model = provider.resolve(ref)
      const result = await generateText({
        model,
        system: FRAGMENT_TITLE_SYSTEM_PROMPT,
        prompt: renderFragmentTitlePrompt(input),
        temperature: 0.2,
        maxOutputTokens: 40,
        providerOptions: catFactoryObservability({
          agentKind: FRAGMENT_TITLE_AGENT_KIND,
          workspaceId,
        }),
      })
      text = result.text
    } catch (e) {
      throw new ValidationError(
        `Fragment-title generation (${ref.provider}:${ref.model}) failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
    }
    const title = cleanTitle(text)
    if (!title) {
      throw new ValidationError(
        `Fragment-title generation (${ref.provider}:${ref.model}) returned an empty title`,
      )
    }
    return { title, model: `${ref.provider}:${ref.model}` }
  }
}

/**
 * Normalise the model's reply into a usable title: take the first non-empty line, strip wrapping
 * quotes / a leading "Title:" label / trailing punctuation, and clamp to the schema's 200-char cap.
 * The prompt asks for a bare title line, but a reasoning model can wrap or prefix it.
 */
function cleanTitle(raw: string): string {
  const firstLine = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!firstLine) return ''
  return firstLine
    .replace(/^title\s*[:-]\s*/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[.\s]+$/g, '')
    .trim()
    .slice(0, 200)
}
