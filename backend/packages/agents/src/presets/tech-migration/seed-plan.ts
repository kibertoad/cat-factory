import type {
  DocKind,
  InitiativeDraftItem,
  InitiativePlanDraft,
  InitiativePresetInputs,
} from '@cat-factory/contracts'
import { DOCUMENT_QUICK_PIPELINE_ID, joinRepoPath, seedPipelines } from '@cat-factory/kernel'
import { MIGRATION_FRAGMENT_IDS } from '@cat-factory/prompt-fragments'
import { moduleSlug } from '../../repo-ops/render.js'
import { MIGRATION_PHASE_IDS } from './phases.js'

// ---------------------------------------------------------------------------
// `seedMigrationPlan` (tech-migration slice T7) — the `preset_tech_migration` plan POST-PROCESSOR.
//
// It runs at ingest AFTER the generic phase-template normalizer (T2 owns plan SHAPE — which phases,
// in what order) and stamps per-item spawn DECORATION only, exactly the T2-does-shape / T7-does-
// decoration split the parent's docs-refresh pilot established (see `../docs-refresh/preset.ts`).
// It NEVER touches phases: shape enforcement is the template's job, re-run after this hook.
//
// The migration methodology gives each phase a fixed archetype (see `phases.ts`):
//   1. `migration-blast-zone`       — a single blast-zone REPORT document.
//   2. `migration-coverage`         — coverage CODING items (characterization tests) closed by the
//                                     single human-gated CONFIDENCE-CASE document.
//   3. `migration-transition-design`— the human-gated transition-design DOCUMENT(s).
//   4. `migration-delivery`         — delivery CODING items (the swap itself).
//   5. `migration-verify-decommission` — parity / CI-flip / decommission CODING items.
//
// So `seedMigrationPlan`'s responsibilities are:
//   (a) stamp each item's spawn decoration keyed off its phase — the report/design/confidence
//       DOCUMENTS get `taskType: 'document'` + a `.md` `targetPath` under the frozen
//       `migrationDocsDir` and the `pl_document_quick` pipeline; the CODING items are left for the
//       policy's estimate rules to route (no forced pipeline). EVERY item gets the `migration.*`
//       fragments.
//   (b) wire the confidence case — ensure phase 2 closes with a single confidence-case document
//       that `dependsOn` every surviving phase-2 coverage item and is human-gated (injecting it if
//       the planner omitted it).
//   (c) apply the phase-2 coverage granularity cap (≤ 8 items), scrubbing dropped ids from every
//       surviving item's `dependsOn` so no dangling reference reaches `validatePlanDraft`.
//   (d) honour the `humanReview` input on the informational (blast-zone) document, while the
//       confidence-case + transition-design documents stay human-gated ALWAYS (they are the
//       methodology's coverage→delivery control points, per the tracker gotcha — never optional).
//
// Pure + total: a deterministic function of the (shaped) draft + frozen inputs, so it is
// replay-safe and its output is re-parsed + re-normalized at the ingest trust boundary (an unsafe
// `targetPath` a bug composed is rejected there by `isSafeDocPath`, exactly as in docs-refresh).
// Lands UNWIRED (no preset registration) — T8 registers `preset_tech_migration` and hooks this in.
// See `docs/initiatives/tech-migration-preset-and-mssql-postgres-pilot.md`.
// ---------------------------------------------------------------------------

/** Field key on the frozen `presetInputs`: where the migration's `.md` artifacts are committed. */
export const FIELD_MIGRATION_DOCS_DIR = 'migrationDocsDir'
/** Field key on the frozen `presetInputs`: the human-review opt-in (defaults ON for a migration). */
export const FIELD_HUMAN_REVIEW = 'humanReview'
/** The default in-repo directory the migration artifacts live under (the pilot value). */
export const DEFAULT_MIGRATION_DOCS_DIR = 'docs/migration'

/** The single canonical artifact filenames — one writer per file (the tracker's single-writer rule). */
const BLAST_ZONE_DOC = 'blast-zone.md'
const CONFIDENCE_CASE_DOC = 'confidence-case.md'
const TRANSITION_DESIGN_DOC = 'transition-design.md'

/** The maximum number of coverage items phase 2 keeps (the granularity cap; extras are dropped). */
const MAX_COVERAGE_ITEMS = 8

/** The base id the injected confidence-case item is derived from (made unique on collision). */
const CONFIDENCE_CASE_ITEM_BASE = 'confidence-case'

/**
 * Whether a phase-2 item is (already) the confidence case the planner was steered to author — the
 * closing coverage item. Matched on the title (the only signal that survives `coerceInitiativePlan`,
 * which drops planner-authored `spawn`), so a planner that emitted it is canonicalized rather than
 * duplicated; when none matches, `seedMigrationPlan` injects one.
 */
function isConfidenceCaseItem(item: InitiativeDraftItem): boolean {
  return /confidence[- ]?case/i.test(item.title)
}

/** Read a string input, falling back to `fallback` when absent/blank/non-string. */
function strInput(inputs: InitiativePresetInputs, key: string, fallback: string): string {
  const value = inputs[key]
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

/** A filesystem-safe, lower-kebab `.md` filename slug for a derived artifact path (capped length). */
function fileSlug(title: string): string {
  return moduleSlug(title).slice(0, 60)
}

/**
 * The per-run gate-override array that human-gates a spawned pipeline at its MERGE step — a FULL
 * boolean array parallel to the pipeline's own `agentKinds` (the parent's [S2] gate-override
 * contract: `ExecutionService.start` rejects a length mismatch), the single `true` on the last
 * `merger` step so the human reviews the CI-green PR right before it merges. DERIVED from the
 * pipeline's shape (never a hand-maintained parallel array). `undefined` when the pipeline has no
 * merge step (leaving its own gates untouched).
 */
export function migrationReviewGates(pipelineId: string): boolean[] | undefined {
  const kinds = seedPipelines().find((p) => p.id === pipelineId)?.agentKinds
  if (!kinds) return undefined
  const gateIdx = kinds.lastIndexOf('merger')
  if (gateIdx === -1) return undefined
  return kinds.map((_, i) => i === gateIdx)
}

/** Ensure a derived `.md` path is unique within one plan (insert `-2`, `-3`, … before the extension). */
function uniquePath(path: string, taken: Set<string>): string {
  if (!taken.has(path)) {
    taken.add(path)
    return path
  }
  const dot = path.lastIndexOf('.')
  const base = dot === -1 ? path : path.slice(0, dot)
  const ext = dot === -1 ? '' : path.slice(dot)
  let n = 2
  let candidate = `${base}-${n}${ext}`
  while (taken.has(candidate)) candidate = `${base}-${++n}${ext}`
  taken.add(candidate)
  return candidate
}

/** Assign a unique id derived from `base`, suffixing `-2`, `-3`, … on collision (the coerce pattern). */
function uniqueId(base: string, taken: Set<string>): string {
  let candidate = base
  let n = 2
  while (taken.has(candidate)) candidate = `${base}-${n++}`
  taken.add(candidate)
  return candidate
}

/** Stamp the shared migration fragments onto an item's spawn, preserving any other spawn fields. */
function withFragments(item: InitiativeDraftItem): InitiativeDraftItem {
  return { ...item, spawn: { ...item.spawn, fragmentIds: [...MIGRATION_FRAGMENT_IDS] } }
}

/**
 * Decorate an item as a committed migration DOCUMENT: `taskType: 'document'` + the doc-quick
 * pipeline + a `.md` `targetPath` under `docsDir` (the canonical filename for the first item of the
 * phase, a title-derived unique path for any extras), the given `docKind`, the migration fragments,
 * and the merge gate when `gated`. The path is de-duplicated across the whole plan so no two
 * documents ever target one file (the single-writer rule).
 */
function asDocument(
  item: InitiativeDraftItem,
  docKind: DocKind,
  targetPath: string,
  gated: boolean,
): InitiativeDraftItem {
  const gates = gated ? migrationReviewGates(DOCUMENT_QUICK_PIPELINE_ID) : undefined
  return {
    ...item,
    pipelineId: DOCUMENT_QUICK_PIPELINE_ID,
    spawn: {
      ...item.spawn,
      taskType: 'document',
      taskTypeFields: { docKind, targetPath },
      fragmentIds: [...MIGRATION_FRAGMENT_IDS],
      ...(gates ? { gates } : {}),
    },
  }
}

/**
 * The plan post-processor for `preset_tech_migration`. See the file header for the per-phase
 * archetypes and the four responsibilities. Pure + total; never mutates its input.
 */
export function seedMigrationPlan(
  draft: InitiativePlanDraft,
  inputs: InitiativePresetInputs,
): InitiativePlanDraft {
  const docsDir = strInput(inputs, FIELD_MIGRATION_DOCS_DIR, DEFAULT_MIGRATION_DOCS_DIR)
  // Human review defaults ON for a migration (a `false` value opts out); the confidence-case +
  // design gates below ignore this — they are intrinsic control points, gated regardless.
  const humanReview = inputs[FIELD_HUMAN_REVIEW] !== false

  // --- (c) Phase-2 coverage cap + confidence-case identification --------------------------------
  const coverageAll = draft.items.filter(
    (i) => i.phaseId === MIGRATION_PHASE_IDS.coverage && !isConfidenceCaseItem(i),
  )
  const coverageKept = coverageAll.slice(0, MAX_COVERAGE_ITEMS)
  const droppedIds = new Set(
    coverageAll
      .slice(MAX_COVERAGE_ITEMS)
      .map((i) => i.id)
      .filter((id): id is string => !!id),
  )
  const keptCoverageIds = coverageKept.map((i) => i.id).filter((id): id is string => !!id)

  // The existing planner-authored confidence case (if any); the FIRST match is canonicalized, any
  // further matches fall through to coverage decoration (harmless extra coding items).
  const existingConfidence = draft.items.find(
    (i) => i.phaseId === MIGRATION_PHASE_IDS.coverage && isConfidenceCaseItem(i),
  )

  const takenIds = new Set(draft.items.map((i) => i.id).filter((id): id is string => !!id))
  const confidenceId = existingConfidence?.id ?? uniqueId(CONFIDENCE_CASE_ITEM_BASE, takenIds)

  // De-dup derived artifact paths across the whole plan (first-of-phase gets the canonical name).
  const usedPaths = new Set<string>()
  let blastZoneNamed = false
  let transitionDesignNamed = false

  /** Scrub `dependsOn` of any capped-away coverage ids so no dangling reference reaches ingest. */
  const scrubDeps = (item: InitiativeDraftItem): InitiativeDraftItem =>
    item.dependsOn?.some((d) => droppedIds.has(d))
      ? { ...item, dependsOn: item.dependsOn.filter((d) => !droppedIds.has(d)) }
      : item

  const decorate = (raw: InitiativeDraftItem): InitiativeDraftItem => {
    const item = scrubDeps(raw)
    switch (item.phaseId) {
      case MIGRATION_PHASE_IDS.blastZone: {
        // The single blast-zone report (extras get a title-derived path — the prompt asks for one).
        const path = blastZoneNamed
          ? uniquePath(`${joinRepoPath(docsDir, fileSlug(item.title))}.md`, usedPaths)
          : uniquePath(joinRepoPath(docsDir, BLAST_ZONE_DOC), usedPaths)
        blastZoneNamed = true
        return asDocument(item, 'technical', path, humanReview)
      }
      case MIGRATION_PHASE_IDS.transitionDesign: {
        // The transition-design document(s) — always human-gated (the compat-posture control point).
        const path = transitionDesignNamed
          ? uniquePath(`${joinRepoPath(docsDir, fileSlug(item.title))}.md`, usedPaths)
          : uniquePath(joinRepoPath(docsDir, TRANSITION_DESIGN_DOC), usedPaths)
        transitionDesignNamed = true
        return asDocument(item, 'design', path, true)
      }
      // Coverage / delivery / verify-decommission are ordinary CODING items: no forced pipeline
      // (the policy's estimate rules route them), just the migration fragments. The coverage→
      // delivery human control is the confidence-case gate, not a per-PR gate.
      default:
        return withFragments(item)
    }
  }

  // Rebuild the item list: decorate in place, drop capped-away coverage, and hold the confidence
  // case out so it can be appended LAST (its `dependsOn` already orders it after coverage — the
  // append just makes it the last phase-2 item in document order too).
  const items: InitiativeDraftItem[] = []
  for (const item of draft.items) {
    if (item.id && droppedIds.has(item.id)) continue
    if (item === existingConfidence) continue
    items.push(decorate(item))
  }

  // --- (b) The confidence case: the single, human-gated coverage→delivery proof -----------------
  const confidenceBase: InitiativeDraftItem = existingConfidence
    ? { ...existingConfidence, id: confidenceId }
    : {
        id: confidenceId,
        phaseId: MIGRATION_PHASE_IDS.coverage,
        title: 'Confidence case',
        description:
          'Sweep the coverage over the blast zone and commit the evidence-backed confidence case (per-touchpoint named tests, gaps and waivers justified against the coverage bar, risk mitigations, safety nets) a human audits before delivery begins.',
        dependsOn: [],
      }
  // Depend on every surviving coverage item (deduped), preserving any planner-authored deps but
  // scrubbing references to capped-away items (an existing confidence case skips `decorate`).
  const confidenceDeps = [
    ...new Set([
      ...(confidenceBase.dependsOn ?? []).filter((d) => !droppedIds.has(d)),
      ...keptCoverageIds,
    ]),
  ]
  items.push(
    asDocument(
      { ...confidenceBase, dependsOn: confidenceDeps },
      'technical',
      uniquePath(joinRepoPath(docsDir, CONFIDENCE_CASE_DOC), usedPaths),
      true,
    ),
  )

  return { ...draft, items }
}
