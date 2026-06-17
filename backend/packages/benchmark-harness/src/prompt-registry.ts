import { type PromptId, PROMPT_VERSIONS, promptVersionLabel } from '@cat-factory/core'
import type { PromptVariant } from './types'

// Resolves a PromptVariant to the concrete system prompt + its version label.
// The default variant for a prompt id uses the built-in, version-numbered
// cat-factory prompt from the core registry; an experimental variant supplies
// its own `system` text and `version` number so a report attributes the outcome
// to the exact prompt that produced it.

export interface ResolvedPrompt {
  /** Concrete system prompt text to use. */
  system: string
  /** Canonical `id@vN` label. */
  label: string
  temperature?: number
  maxOutputTokens?: number
}

function isKnownPrompt(id: string): id is PromptId {
  return id in PROMPT_VERSIONS
}

export function resolvePromptVariant(variant: PromptVariant): ResolvedPrompt {
  const builtin = isKnownPrompt(variant.promptId) ? PROMPT_VERSIONS[variant.promptId] : undefined
  const system = variant.system ?? builtin?.text
  if (!system) {
    throw new Error(
      `Prompt variant '${variant.promptId}' has no system text and is not a known built-in prompt`,
    )
  }
  const version = variant.version ?? builtin?.version ?? 1
  return {
    system,
    label: variant.label ?? promptVersionLabel(variant.promptId, version),
    temperature: variant.temperature,
    maxOutputTokens: variant.maxOutputTokens,
  }
}

/** The default (built-in) variant for a known prompt id. */
export function defaultVariant(promptId: PromptId): PromptVariant {
  return { promptId, version: PROMPT_VERSIONS[promptId].version }
}
