import type { PromptFragment } from '@cat-factory/contracts'
import type { AgentKind, BlockType, FragmentTier } from '../../domain/types'
import type { FragmentSelectionContext, SelectableFragment } from '../../ports/fragment-selector'
import type { PromptFragmentRecord } from '../../ports/fragment-repositories'

// Pure tier-merge + deterministic-selection logic for the fragment library
// (ADR 0006 §1, §5). No I/O — the service hands in the three tiers and the
// candidate set; everything here is unit-testable.

/** A fragment after the three tiers are merged, carrying its winning tier. */
export interface ResolvedCatalogEntry {
  id: string
  version: string
  title: string
  category: string | null
  summary: string
  body: string
  appliesTo: { blockTypes?: BlockType[]; agentKinds?: AgentKind[] } | null
  tags: string[] | null
  source: { sourceId: string; path: string; sha: string } | null
  tier: FragmentTier
}

/** Built-in catalog fragment → resolved entry at the `builtin` tier. */
function builtinToEntry(fragment: PromptFragment): ResolvedCatalogEntry {
  return {
    id: fragment.id,
    version: fragment.version,
    title: fragment.title,
    category: fragment.category ?? null,
    summary: fragment.summary,
    body: fragment.body,
    appliesTo: fragment.appliesTo ?? null,
    tags: fragment.tags ?? null,
    source: fragment.source ?? null,
    tier: 'builtin',
  }
}

/** Managed record → resolved entry at its owner's tier. */
function recordToEntry(record: PromptFragmentRecord, tier: FragmentTier): ResolvedCatalogEntry {
  return {
    id: record.fragmentId,
    version: record.version,
    title: record.title,
    category: record.category,
    summary: record.summary,
    body: record.body,
    appliesTo: record.appliesTo,
    tags: record.tags,
    source:
      record.sourceId && record.sourcePath !== null && record.sourceSha !== null
        ? { sourceId: record.sourceId, path: record.sourcePath, sha: record.sourceSha }
        : null,
    tier,
  }
}

/**
 * Merge the three tiers into one catalog. Later tiers override earlier ones by
 * stable id (workspace > account > built-in); a tombstoned record at any tier
 * *suppresses* the id outright. Returns live entries sorted by id.
 */
export function mergeCatalog(
  builtins: PromptFragment[],
  accountRows: PromptFragmentRecord[],
  workspaceRows: PromptFragmentRecord[],
): ResolvedCatalogEntry[] {
  const byId = new Map<string, ResolvedCatalogEntry>()
  for (const b of builtins) byId.set(b.id, builtinToEntry(b))
  applyTier(byId, accountRows, 'account')
  applyTier(byId, workspaceRows, 'workspace')
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

function applyTier(
  byId: Map<string, ResolvedCatalogEntry>,
  rows: PromptFragmentRecord[],
  tier: FragmentTier,
): void {
  for (const row of rows) {
    if (row.deletedAt !== null) {
      byId.delete(row.fragmentId) // tombstone: suppress the inherited/own entry
    } else {
      byId.set(row.fragmentId, recordToEntry(row, tier))
    }
  }
}

/** Reduce a resolved entry to the metadata the selector reasons over (no body). */
export function toSelectable(entry: ResolvedCatalogEntry): SelectableFragment {
  const out: SelectableFragment = {
    id: entry.id,
    title: entry.title,
    summary: entry.summary,
  }
  if (entry.category) out.category = entry.category
  if (entry.tags && entry.tags.length) out.tags = entry.tags
  if (entry.appliesTo) out.appliesTo = entry.appliesTo
  return out
}

/** A resolved entry → the wire {@link PromptFragment} (+ tier handled by caller). */
export function entryToFragment(entry: ResolvedCatalogEntry): PromptFragment {
  const fragment: PromptFragment = {
    id: entry.id,
    version: entry.version,
    title: entry.title,
    category: entry.category ?? '',
    summary: entry.summary,
    body: entry.body,
  }
  if (entry.appliesTo) fragment.appliesTo = entry.appliesTo
  if (entry.tags && entry.tags.length) fragment.tags = entry.tags
  if (entry.source) fragment.source = entry.source
  return fragment
}

/** Whether a fragment's `appliesTo` gate admits this run's block type / agent kind. */
function passesAppliesTo(
  candidate: SelectableFragment,
  context: FragmentSelectionContext,
): boolean {
  const applies = candidate.appliesTo
  if (!applies) return true
  if (applies.blockTypes && !applies.blockTypes.includes(context.blockType)) return false
  if (applies.agentKinds && !applies.agentKinds.includes(context.agentKind)) return false
  return true
}

/**
 * The deterministic fallback selector (ADR 0006 §5): keep every candidate whose
 * `appliesTo` gate admits the run, then — when any candidate carries tags —
 * prefer those whose tags intersect the run's signals (block type, title,
 * description, prior outputs). With no tags anywhere, the gate alone decides, so
 * an offline/test run is fully deterministic and never blocks.
 */
export function selectDeterministic(
  candidates: SelectableFragment[],
  context: FragmentSelectionContext,
): string[] {
  const admitted = candidates.filter((c) => passesAppliesTo(c, context))
  const haystack = [
    context.blockType,
    context.blockTitle,
    context.blockDescription,
    ...context.signals,
  ]
    .join(' ')
    .toLowerCase()

  const anyTagged = admitted.some((c) => c.tags && c.tags.length > 0)
  if (!anyTagged) return admitted.map((c) => c.id)

  const tagMatched = admitted.filter((c) => {
    if (!c.tags || c.tags.length === 0) return true // untagged fragments stay broadly applicable
    return c.tags.some((tag) => haystack.includes(tag.toLowerCase()))
  })
  // If tag filtering excluded everything, fall back to the gate-admitted set so a
  // run still gets its applicable standards rather than nothing.
  return (tagMatched.length > 0 ? tagMatched : admitted).map((c) => c.id)
}
