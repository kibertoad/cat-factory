import {
  type FragmentSelectionContext,
  type FragmentSelector,
  type ModelProvider,
  type ModelRef,
  type SelectableFragment,
} from '@cat-factory/kernel'
import { generateText } from 'ai'
import { catFactoryObservability } from '../providers/instrumented.js'
import { selectDeterministic } from './fragment-catalog.js'

// Runtime-neutral LLM-backed fragment selector (ADR 0006 §5). Promoted from the
// Worker infra into @cat-factory/agents so every facade composes the same selector.

export interface LlmFragmentSelectorDependencies {
  modelProvider: ModelProvider
  modelRef: ModelRef
}

const SYSTEM_PROMPT =
  'You select which best-practice guideline fragments are relevant to a coding task. ' +
  'You are given the task context and a list of candidate fragments (id, title, summary, tags). ' +
  'Return ONLY a JSON array of the ids that are relevant — no prose, no code fences. ' +
  'Prefer precision: a frontend-only task should not pull database or backend guidelines.'

function buildPrompt(candidates: SelectableFragment[], context: FragmentSelectionContext): string {
  const list = candidates.map((c) => ({
    id: c.id,
    title: c.title,
    summary: c.summary,
    tags: c.tags ?? [],
  }))
  return [
    `Agent role: ${context.agentKind}`,
    `Block type: ${context.blockType}`,
    `Block: ${context.blockTitle}`,
    context.blockDescription ? `Description: ${context.blockDescription}` : '',
    context.signals.length ? `Recent work / context:\n${context.signals.join('\n---\n')}` : '',
    '',
    'Candidate fragments:',
    JSON.stringify(list, null, 2),
    '',
    'Respond with a JSON array of the relevant fragment ids, e.g. ["node.performance"].',
  ]
    .filter(Boolean)
    .join('\n')
}

function extractIds(text: string, valid: Set<string>): string[] | null {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    if (!Array.isArray(parsed)) return null
    return parsed.filter((id): id is string => typeof id === 'string' && valid.has(id))
  } catch {
    return null
  }
}

/**
 * LLM-backed {@link FragmentSelector} (ADR 0006 §5): asks the configured model to
 * pick the relevant fragment ids from the candidates' summaries (bodies are never
 * sent — summaries keep the call cheap). Degrades gracefully to the deterministic
 * matcher if the model is unavailable or its response can't be parsed, so review
 * never blocks on the selector and offline/test runs stay deterministic.
 */
export class LlmFragmentSelector implements FragmentSelector {
  constructor(private readonly deps: LlmFragmentSelectorDependencies) {}

  async select(
    candidates: SelectableFragment[],
    context: FragmentSelectionContext,
  ): Promise<string[]> {
    if (candidates.length === 0) return []
    const fallback = () => selectDeterministic(candidates, context)
    try {
      const model = this.deps.modelProvider.resolve(this.deps.modelRef)
      const { text } = await generateText({
        model,
        system: SYSTEM_PROMPT,
        prompt: buildPrompt(candidates, context),
        temperature: 0,
        // Headroom for a reasoning model's `<think>` before the (small) id list —
        // a tight cap truncates the output before any ids are emitted.
        maxOutputTokens: 5000,
        providerOptions: catFactoryObservability({ agentKind: 'fragment-selector' }),
      })
      const ids = extractIds(text, new Set(candidates.map((c) => c.id)))
      return ids ?? fallback()
    } catch {
      return fallback()
    }
  }
}
