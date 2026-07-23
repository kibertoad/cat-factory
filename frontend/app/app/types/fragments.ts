// ---------------------------------------------------------------------------
// Prompt-fragment library (ADR 0006). Mirrors the `@cat-factory/contracts`
// fragment-library schemas: the managed, tenant-scoped catalog a workspace
// resolves (built-in ∪ account ∪ workspace), plus the repo sources that feed it.
// ---------------------------------------------------------------------------
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).

export type {
  FragmentOwnerKind,
  FragmentTier,
  CreatePromptFragmentInput,
  UpdatePromptFragmentInput,
  GenerateFragmentTitleInput,
  GeneratedFragmentTitle,
  CreateDocumentFragmentInput,
  ResolvedFragment,
  FragmentSource,
  LinkFragmentSourceInput,
  FragmentSyncResult,
  FragmentSourceStatus,
} from '@cat-factory/contracts'
