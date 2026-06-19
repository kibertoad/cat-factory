import type { AgentKind, BlockType } from '../domain/types.js'

// ---------------------------------------------------------------------------
// Relevance-selection ports for the prompt-fragment library (ADR 0006 §5).
//
//  - FragmentSelector picks the relevant fragment ids for a run from the
//    catalog's summaries (bodies are not sent). The worker wires an LLM-backed
//    selector; the core ships a deterministic one as the fallback so review
//    never blocks on a model and tests stay deterministic.
//  - FragmentResolver is the single seam the execution engine consumes: it
//    merges the tenant catalog, runs selection, unions the manual pins, and
//    returns the fragment bodies to fold into the system prompt. Deliberately
//    agent-kind-agnostic — the same path serves reviewers, implementers and any
//    other agent kind.
// ---------------------------------------------------------------------------

/** A catalog entry as the selector sees it: metadata only, no body. */
export interface SelectableFragment {
  id: string
  title: string
  summary: string
  category?: string
  tags?: string[]
  appliesTo?: { blockTypes?: BlockType[]; agentKinds?: AgentKind[] }
}

/** What the selector knows about the run it is choosing fragments for. */
export interface FragmentSelectionContext {
  agentKind: AgentKind
  blockType: BlockType
  blockTitle: string
  blockDescription: string
  /**
   * Free-form signals the selector may reason over — e.g. the prior step's
   * output (a coder's summary), or changed file paths when available. Kept
   * generic so the engine need not fetch a diff to make selection useful.
   */
  signals: string[]
}

export interface FragmentSelector {
  /** Return the ids of `candidates` relevant to `context`. */
  select(candidates: SelectableFragment[], context: FragmentSelectionContext): Promise<string[]>
}

/** A fragment resolved for injection: just the id and the body to fold in. */
export interface ResolvedRunFragment {
  id: string
  body: string
}

export interface FragmentResolverInput {
  workspaceId: string
  agentKind: AgentKind
  blockType: BlockType
  blockTitle: string
  blockDescription: string
  /** Fragment ids pinned manually on the block (an authoritative override). */
  manualIds: string[]
  /** Free-form signals handed to the selector (see {@link FragmentSelectionContext}). */
  signals: string[]
}

export interface FragmentRunSelection {
  /** The fragments (id + body) to fold into the system prompt, in catalog order. */
  fragments: ResolvedRunFragment[]
  /** The ids that were selected (manual ∪ selector pick), for the execution step. */
  selectedIds: string[]
}

/**
 * The execution engine's view of the fragment library: resolve the fragments to
 * inject for one agent run. A no-op-safe optional dependency — when the library
 * module is not configured the engine never calls it and falls back to the
 * static built-in catalog via the block's manual `fragmentIds`.
 */
export interface FragmentResolver {
  resolveForRun(input: FragmentResolverInput): Promise<FragmentRunSelection>
}
