// ---------------------------------------------------------------------------
// Model selection & best-practice prompt fragments. Mirrors the
// `@cat-factory/contracts` schemas served read-only by the backend.
// ---------------------------------------------------------------------------

import type { AgentKind, BlockType } from './domain'

/**
 * A selectable LLM model, resolved to the flavour actually in use for this
 * deployment (served by `GET /models`). `flavor` is `direct` when the model's
 * own provider key is configured, else `cloudflare`. Mirrors `ModelOption` in
 * `@cat-factory/contracts`.
 */
export interface ModelOption {
  id: string
  label: string
  description: string
  flavor: 'cloudflare' | 'direct'
  providerLabel: string
  provider: string
  model: string
}

/**
 * A curated best-practice "prompt fragment" served read-only by the backend
 * (`GET /prompt-fragments`). Users pick which apply to a block; the backend folds
 * the selected fragments' bodies into the agent system prompt at run time.
 */
export interface PromptFragment {
  id: string
  version: string
  title: string
  category: string
  summary: string
  body: string
  appliesTo?: {
    blockTypes?: BlockType[]
    agentKinds?: AgentKind[]
  }
}
