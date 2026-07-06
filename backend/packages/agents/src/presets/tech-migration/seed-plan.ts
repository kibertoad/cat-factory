import type {
  DocKind,
  InitiativeDraftItem,
  InitiativePlanDraft,
  InitiativePresetInputs,
} from '@cat-factory/contracts'
import { DOCUMENT_QUICK_PIPELINE_ID, joinRepoPath } from '@cat-factory/kernel'
import { migrationFragmentIdsFor } from '@cat-factory/prompt-fragments'
import { fileSlug, mergeGateOverride, strInput, uniqueDocPath } from '../plan-helpers.js'
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
//       DOCUMENTS (declared once in `DOC_PHASE_DECORATIONS`) get `taskType: 'document'` + a `.md`
//       `targetPath` under the frozen `migrationDocsDir` and the `pl_document_quick` pipeline; the
//       CODING items are left for the policy's estimate rules to route (no forced pipeline). Each
//       item gets the `migration.*` fragments that APPLY to its primary producer (`doc-writer` for
//       documents, `coder` for coding) — honouring each fragment's `appliesTo` (see `withFragments`).
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
 * The per-phase DOCUMENT archetype, declared as data (not a `switch`) so adding/altering a document
 * phase is a table row, mirroring docs-refresh's `PHASE_DECORATIONS`. A phase with no entry is
 * CODING (coverage / delivery / verify-decommission). The confidence case is NOT here — it is a
 * document injected/canonicalized within the coverage phase with its own always-gate.
 */
interface MigrationDocDecoration {
  docKind: DocKind
  /** The canonical filename the FIRST item of the phase writes; extras get a title-derived name. */
  canonicalDoc: string
  /**
   * `'always'` = an intrinsic coverage→delivery control point, human-gated regardless of the
   * `humanReview` input; `'humanReview'` = gated only when the user opted into human review.
   */
  gate: 'always' | 'humanReview'
}

const DOC_PHASE_DECORATIONS: Record<string, MigrationDocDecoration> = {
  // The blast-zone REPORT — informational, so its gate follows the `humanReview` opt-in.
  [MIGRATION_PHASE_IDS.blastZone]: {
    docKind: 'technical',
    canonicalDoc: BLAST_ZONE_DOC,
    gate: 'humanReview',
  },
  // The transition-design DOCUMENT(s) — always human-gated (the compat-posture control point).
  [MIGRATION_PHASE_IDS.transitionDesign]: {
    docKind: 'design',
    canonicalDoc: TRANSITION_DESIGN_DOC,
    gate: 'always',
  },
}

/**
 * Whether a phase-2 item is (already) the confidence case the planner was steered to author — the
 * closing coverage item. Matched on the title (the only signal that survives `coerceInitiativePlan`,
 * which drops planner-authored `spawn`), ANCHORED at the title start (after optional leading verbs /
 * articles) so a coverage CODING item that merely MENTIONS the confidence case (e.g. "Characterize
 * the orders API against the confidence case") is NOT misclassified and silently hijacked into the
 * single confidence document. The planner is steered to title it plainly ("Confidence case" /
 * "Author the confidence case"), which this still matches; a match is canonicalized rather than
 * duplicated, and when none matches `seedMigrationPlan` injects one.
 */
function isConfidenceCaseItem(item: InitiativeDraftItem): boolean {
  return /^(?:(?:author|write|compile|assemble|prepare|build|create|draft|the|a)\s+)*confidence[-\s]?case\b/i.test(
    item.title.trim(),
  )
}

/**
 * The per-run gate-override that human-gates the doc-quick pipeline at its merge step, kept as a
 * named export so T8's descriptor review mapping reuses the SAME derivation. Delegates to the shared
 * {@link mergeGateOverride} (single implementation across presets).
 */
export function migrationReviewGates(pipelineId: string): boolean[] | undefined {
  return mergeGateOverride(pipelineId)
}

/** Assign a unique id derived from `base`, suffixing `-2`, `-3`, … on collision (the coerce pattern). */
function uniqueId(base: string, taken: Set<string>): string {
  let candidate = base
  let n = 2
  while (taken.has(candidate)) candidate = `${base}-${n++}`
  taken.add(candidate)
  return candidate
}

/** Stamp the migration fragments that apply to `agentKind` onto an item's spawn, preserving the rest. */
function withFragments(item: InitiativeDraftItem, agentKind: string): InitiativeDraftItem {
  return { ...item, spawn: { ...item.spawn, fragmentIds: migrationFragmentIdsFor(agentKind) } }
}

/**
 * Decorate an item as a committed migration DOCUMENT: `taskType: 'document'` + the doc-quick
 * pipeline + the given `.md` `targetPath` and `docKind`, the doc-writer migration fragments, and
 * the merge gate per the `gate` policy. An `'always'`-gated document whose pipeline has NO merge
 * step to place the review on is a misconfiguration that would silently ship the control point
 * unattended, so it THROWS rather than degrading to ungated (the invariant is enforced, not hoped).
 */
function asDocument(
  item: InitiativeDraftItem,
  docKind: DocKind,
  targetPath: string,
  gate: 'always' | 'humanReview',
  humanReview: boolean,
): InitiativeDraftItem {
  const gates =
    gate === 'always' || humanReview ? mergeGateOverride(DOCUMENT_QUICK_PIPELINE_ID) : undefined
  if (gate === 'always' && !gates) {
    throw new Error(
      `Migration document pipeline '${DOCUMENT_QUICK_PIPELINE_ID}' has no merge step to gate — the always-gated confidence-case / transition-design control point cannot be enforced.`,
    )
  }
  return {
    ...item,
    pipelineId: DOCUMENT_QUICK_PIPELINE_ID,
    spawn: {
      ...item.spawn,
      taskType: 'document',
      taskTypeFields: { docKind, targetPath },
      fragmentIds: migrationFragmentIdsFor('doc-writer'),
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

  // The items we will decorate (everything except the capped-away coverage and the confidence case,
  // which is held out to be appended LAST). Order is preserved from the draft.
  const keptItems = draft.items.filter(
    (item) => !(item.id && droppedIds.has(item.id)) && item !== existingConfidence,
  )

  // Pre-assign each document item's derived `.md` path: the first item of a document phase gets the
  // phase's canonical filename, extras a title-derived slug, all de-duplicated across the whole plan
  // so no two documents ever target one file (the single-writer rule). Derived up front (indexed by
  // position within the phase) rather than tracked with mutable "first seen" flags in the decorate
  // pass. The confidence-case path is allocated after, from the same `usedPaths` set.
  const usedPaths = new Set<string>()
  const docPaths = new Map<InitiativeDraftItem, string>()
  for (const [phaseId, deco] of Object.entries(DOC_PHASE_DECORATIONS)) {
    keptItems
      .filter((item) => item.phaseId === phaseId)
      .forEach((item, idx) => {
        const derived =
          idx === 0
            ? joinRepoPath(docsDir, deco.canonicalDoc)
            : `${joinRepoPath(docsDir, fileSlug(item.title))}.md`
        docPaths.set(item, uniqueDocPath(derived, usedPaths))
      })
  }

  /** Scrub `dependsOn` of any capped-away coverage ids so no dangling reference reaches ingest. */
  const scrubDeps = (item: InitiativeDraftItem): InitiativeDraftItem =>
    item.dependsOn?.some((d) => droppedIds.has(d))
      ? { ...item, dependsOn: item.dependsOn.filter((d) => !droppedIds.has(d)) }
      : item

  const decorate = (raw: InitiativeDraftItem): InitiativeDraftItem => {
    const item = scrubDeps(raw)
    const deco = DOC_PHASE_DECORATIONS[item.phaseId]
    if (deco) return asDocument(item, deco.docKind, docPaths.get(item)!, deco.gate, humanReview)
    // Coverage / delivery / verify-decommission are ordinary CODING items: no forced pipeline (the
    // policy's estimate rules route them), just the coder migration fragments. The coverage→delivery
    // human control is the confidence-case gate, not a per-PR gate.
    return withFragments(item, 'coder')
  }

  const items = keptItems.map(decorate)

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
      uniqueDocPath(joinRepoPath(docsDir, CONFIDENCE_CASE_DOC), usedPaths),
      'always',
      humanReview,
    ),
  )

  return { ...draft, items }
}
