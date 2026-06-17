// ---------------------------------------------------------------------------
// Prompt-fragment library (ADR 0006). Mirrors the `@cat-factory/contracts`
// fragment-library schemas: the managed, tenant-scoped catalog a workspace
// resolves (built-in ∪ account ∪ workspace), plus the repo sources that feed it.
// ---------------------------------------------------------------------------

import type { AgentKind, BlockType } from './domain'
import type { PromptFragment } from './models'

/** Which scope owns a managed fragment / source. */
export type FragmentOwnerKind = 'account' | 'workspace'

/** The tier a resolved fragment originates from after override-by-id. */
export type FragmentTier = 'builtin' | 'account' | 'workspace'

/** Inputs for creating a hand-authored fragment at a tier. */
export interface CreatePromptFragmentInput {
  id?: string
  title: string
  category?: string
  summary: string
  body: string
  tags?: string[]
  appliesTo?: { blockTypes?: BlockType[]; agentKinds?: AgentKind[] }
  version?: string
}

/** Partial patch for editing a fragment at a tier. */
export type UpdatePromptFragmentInput = Partial<CreatePromptFragmentInput>

/** A fragment after the three tiers are merged for a workspace. */
export interface ResolvedFragment extends PromptFragment {
  tier: FragmentTier
}

/** A repo directory linked as a source of Markdown guideline files. */
export interface FragmentSource {
  id: string
  ownerKind: FragmentOwnerKind
  ownerId: string
  repoOwner: string
  repoName: string
  gitRef: string
  dirPath: string
  lastSyncedSha: string | null
  lastSyncedAt: number | null
  createdAt: number
}

/** Inputs for linking a repo directory as a fragment source. */
export interface LinkFragmentSourceInput {
  repoOwner: string
  repoName: string
  gitRef?: string
  dirPath?: string
}

/** Outcome of resyncing a source. */
export interface FragmentSyncResult {
  upserted: number
  tombstoned: number
  unchanged: number
  lastSyncedSha: string | null
}

/** Cheap "check for changes" result (no writes); powers the resync badge. */
export interface FragmentSourceStatus {
  changed: boolean
  changedCount: number
  lastSyncedSha: string | null
  remoteSha: string | null
}
