// ---------------------------------------------------------------------------
// Model selection & best-practice prompt fragments. Mirrors the
// `@cat-factory/contracts` schemas served read-only by the backend.
// ---------------------------------------------------------------------------

import type { AgentKind, BlockType } from './domain'

/** Subscription vendors whose pooled tokens drive the Claude Code / Codex harnesses. */
export type SubscriptionVendor = 'claude' | 'codex' | 'glm' | 'kimi' | 'deepseek'

/** Informational list price (per 1M tokens) for a model flavour. */
export interface ModelCost {
  inputPerMillion: number
  outputPerMillion: number
  currency: string
}

/**
 * A selectable LLM model, resolved to the flavour in use for this deployment
 * (served by `GET /models`). Mirrors `ModelOption` in `@cat-factory/contracts`.
 * The base `flavor`/`provider`/`model` is the always-available fallback
 * (cloudflare/direct), or the subscription itself for subscription-only models.
 * `subscription` (when present) is the alternative the picker prefers once the
 * workspace has a token for its vendor.
 */
export interface ModelOption {
  id: string
  label: string
  description: string
  flavor: 'cloudflare' | 'direct' | 'subscription'
  providerLabel: string
  provider: string
  model: string
  vendor?: SubscriptionVendor
  cost?: ModelCost
  contextTokens?: number
  /** True when the effective flavour is flat-rate quota (not budget-metered). */
  quotaBased?: boolean
  /** The alternative subscription flavour for a dual-mode model (GLM/Kimi). */
  subscription?: {
    vendor: SubscriptionVendor
    providerLabel: string
    provider: string
    model: string
    cost?: ModelCost
    contextTokens?: number
  }
}

/**
 * Status of a user's personal (individual-usage) subscription — Claude consumer
 * subscriptions are licensed per individual, so they're stored per-user (not pooled)
 * and unlocked with a personal password. Metadata only; never the token.
 */
export interface PersonalSubscriptionStatus {
  vendor: SubscriptionVendor
  label: string
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
  /** Subscription's own expiry (null = no fixed end date). */
  expiresAt: number | null
  /** Whole days until `expiresAt` (negative once lapsed; null when no expiry). */
  expiresInDays: number | null
  expired: boolean
  /** Whether renewal should be surfaced now (expiry within the warning window). */
  renewSoon: boolean
}

/** Connect (or replace) the signed-in user's personal subscription for a vendor. */
export interface StorePersonalSubscriptionInput {
  vendor: SubscriptionVendor
  label: string
  token: string
  /** Personal password gating the second encryption layer; never stored. */
  password: string
  /** Epoch ms the subscription expires (for renewal warnings); optional. */
  expiresAt?: number | null
}

/** A connected subscription credential (metadata + usage), never the secret. */
export interface VendorCredential {
  id: string
  vendor: SubscriptionVendor
  label: string
  createdAt: number
  lastUsedAt: number | null
  inputTokens: number
  outputTokens: number
  requestCount: number
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
  /** Free-form tags the relevance selector uses (managed/sourced fragments only). */
  tags?: string[]
  /** Provenance when sourced from a repo; absent for built-in/hand-authored. */
  source?: {
    sourceId: string
    path: string
    sha: string
  }
}
