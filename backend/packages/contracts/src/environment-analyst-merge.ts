import type {
  AnalystCitation,
  AnalystRecipeDraft,
  AnalystRecipeNote,
} from './environment-analyst.js'
import type {
  ProvisioningDetectionConfidence,
  ProvisioningDetectionNote,
  ProvisioningRecommendation,
} from './environments.js'
import type { StackRecipe } from './stack-recipes.js'

// ---------------------------------------------------------------------------
// ANALYST DRAFT MERGE — combine the DETERMINISTIC provisioning recommendation
// (`provisioningRecommendationSchema`, read checkout-free by the detector) with the opt-in
// environment analyst's `AnalystRecipeDraft` (the LLM's read of the imperative bring-up) into a
// single reviewable recipe, per field, WITH PROVENANCE. This is the "review recipe" input for
// the setup wizard (slice 7 of docs/initiatives/stack-recipes-and-shared-stacks.md).
//
// The rule the initiative fixes (see `environment-analyst.ts`): **deterministic detector facts
// WIN where both produce a field; analyst-only fields fill the gaps, editable + flagged with the
// analyst's rationale/citations.** The detector is authoritative because it read the actual
// compose truth; the analyst only translates the imperative parts a scan can't see (setup steps,
// health gate, prerequisites) — so it never overrides a mechanically-detected fact, it only adds
// what the detector couldn't know.
//
// PURE + no IO (both inputs are already-parsed contract types), so it lives in @cat-factory/contracts
// beside the types it merges and is directly consumable by BOTH the SPA wizard (client-side, no
// extra endpoint) and any backend caller — the same shared-pure-helper shape as
// `resolveFrontendBindings` / `buildFrontendRunNotes`. The output is a view model, not a wire type:
// nothing here crosses a boundary, and on save the wizard persists only the resulting `StackRecipe`
// (re-validated against the STRICT `stackRecipeSchema`) onto the service frame.
// ---------------------------------------------------------------------------

/** The top-level {@link StackRecipe} fields the merge tracks provenance for, in display order. */
export const MERGEABLE_RECIPE_FIELDS = [
  'composeFiles',
  'composeProfiles',
  'envFiles',
  'externalNetworks',
  'sharedStackRefs',
  'prerequisites',
  'setupSteps',
  'healthGate',
  'teardownSteps',
] as const satisfies readonly (keyof StackRecipe)[]

/** A {@link StackRecipe} field whose value + provenance the merge resolves. */
export type MergeableRecipeField = (typeof MERGEABLE_RECIPE_FIELDS)[number]

/**
 * Which source supplied the value that landed in the merged recipe for a field:
 * - `detector` — only the deterministic detector produced it (authoritative).
 * - `analyst`  — only the analyst produced it (a draft the human edits/confirms).
 * - `both`     — both produced it and the DETECTOR's value won (the analyst's is surfaced as a
 *   dissenting note via {@link MergedRecipeDraft.analystNotes}, not applied).
 */
export type RecipeFieldOrigin = 'detector' | 'analyst' | 'both'

/**
 * Provenance for one populated recipe field. Carries the WINNING source's rationale: the detector
 * confidence + note when a detected fact won (`detector`/`both`), or the analyst rationale +
 * citations when the analyst's draft won (`analyst`). The wizard renders this as the per-field
 * confidence / "suggested by analysis of …" chip.
 */
export interface MergedRecipeField {
  /** The recipe field this entry describes. */
  field: MergeableRecipeField
  /** Which source's value landed in the merged recipe. */
  origin: RecipeFieldOrigin
  /** Detector confidence, present when a detected fact won (`origin` `detector`/`both`). */
  confidence?: ProvisioningDetectionConfidence
  /** The detector's rationale message, present when a detected fact won. */
  detectorMessage?: string
  /** The analyst's rationale, present when the analyst's draft won (`origin` `analyst`). */
  analystRationale?: string
  /** Analyst source citations backing the field, present when the analyst's draft won. */
  citations?: AnalystCitation[]
}

/**
 * The merged, reviewable recipe: the detector-wins {@link StackRecipe} plus per-field provenance,
 * the analyst's summary + verbatim notes (so the wizard can render granular per-step provenance
 * such as `setupSteps[2]`), and whether the analyst contributed anything at all.
 */
export interface MergedRecipeDraft {
  /** The merged recipe (detector facts win on overlap; analyst-only fields fill the gaps). */
  recipe: StackRecipe
  /** Provenance for each populated recipe field, in {@link MERGEABLE_RECIPE_FIELDS} order. */
  fields: MergedRecipeField[]
  /** The analyst's one-paragraph environment summary, when it ran and returned one. */
  summary?: string
  /** Every analyst note verbatim (for per-step provenance the field-level view can't hold). */
  analystNotes: AnalystRecipeNote[]
  /** True when an analyst draft contributed a recipe field, a note, or a summary. */
  hasAnalystInput: boolean
}

/** A produced field = a defined non-array value, or a non-empty array (an empty array is "not produced"). */
function isProduced(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (Array.isArray(value)) return value.length > 0
  return true
}

/**
 * The base field name a note targets, stripping any index/path suffix so a per-step analyst note
 * (`setupSteps[2]`, `healthGate.url`) still maps to the top-level field it explains.
 */
function baseNoteField(field: string): string {
  const trimmed = field.trim()
  let end = trimmed.length
  const bracket = trimmed.indexOf('[')
  if (bracket >= 0 && bracket < end) end = bracket
  const dot = trimmed.indexOf('.')
  if (dot >= 0 && dot < end) end = dot
  return trimmed.slice(0, end)
}

/** The detector note for a field (exact `field` match), if any. */
function detectorNoteFor(
  notes: readonly ProvisioningDetectionNote[],
  field: MergeableRecipeField,
): ProvisioningDetectionNote | undefined {
  return notes.find((note) => note.field === field)
}

/**
 * Deep-clone a JSON-shaped contract value (recipe fields + analyst notes are pure data — strings,
 * numbers, arrays, plain objects, no Date/Map/class instances). Used so the merged view model
 * shares NO mutable reference with the caller's recommendation/draft: the wizard edits the merged
 * recipe/notes in place, and an in-place edit must never reach back and mutate the deterministic
 * detector fact or the non-binding draft. (A `structuredClone` global isn't typed in this pure,
 * browser-shared package's `ES2022` lib, so this stays dependency-free.)
 */
function cloneData<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneData(item)) as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) out[key] = cloneData(nested)
    return out as T
  }
  return value
}

/**
 * The analyst note for a field: an exact `field` match wins over an indexed/path-suffixed one
 * (e.g. `setupSteps` is preferred over `setupSteps[0]` for the field-level chip).
 */
function analystNoteFor(
  notes: readonly AnalystRecipeNote[],
  field: MergeableRecipeField,
): AnalystRecipeNote | undefined {
  return (
    notes.find((note) => note.field.trim() === field) ??
    notes.find((note) => baseNoteField(note.field) === field)
  )
}

/**
 * Merge a deterministic {@link ProvisioningRecommendation} with an opt-in
 * {@link AnalystRecipeDraft} into a single {@link MergedRecipeDraft}: detector facts win where
 * both produce a field, analyst-only fields fill the gaps, and every populated field carries the
 * winning source's provenance. `draft` absent (the analyst never ran) ⇒ the detector's recipe
 * verbatim with detector provenance and no analyst input.
 */
export function mergeAnalystRecipeDraft(
  recommendation: ProvisioningRecommendation,
  draft?: AnalystRecipeDraft,
): MergedRecipeDraft {
  const detectorRecipe = recommendation.provisioning.recipe
  const analystRecipe = draft?.recipe
  // Clone the analyst notes up front so the returned view model shares no mutable reference with
  // the caller's `draft` — the wizard edits this recipe/notes in place, and an in-place edit must
  // never reach back and mutate the deterministic detector fact or the non-binding draft.
  const analystNotes: AnalystRecipeNote[] = draft?.notes ? cloneData(draft.notes) : []

  const recipe: StackRecipe = {}
  const fields: MergedRecipeField[] = []

  for (const field of MERGEABLE_RECIPE_FIELDS) {
    const detectorValue = detectorRecipe?.[field]
    const analystValue = analystRecipe?.[field]
    const detectorHas = isProduced(detectorValue)
    const analystHas = isProduced(analystValue)

    if (detectorHas) {
      // The detector read the compose truth — its fact wins even if the analyst also proposed one.
      // Clone the value so an edit to the merged recipe can't mutate the source recommendation.
      Object.assign(recipe, { [field]: cloneData(detectorValue) })
      const note = detectorNoteFor(recommendation.notes, field)
      fields.push({
        field,
        origin: analystHas ? 'both' : 'detector',
        ...(note ? { confidence: note.confidence, detectorMessage: note.message } : {}),
      })
    } else if (analystHas) {
      // Analyst-only field (setup steps, health gate, prerequisites the detector can't see).
      // Clone the value so an edit to the merged recipe can't mutate the source draft.
      Object.assign(recipe, { [field]: cloneData(analystValue) })
      const note = analystNoteFor(analystNotes, field)
      fields.push({
        field,
        origin: 'analyst',
        ...(note
          ? {
              analystRationale: note.rationale,
              ...(note.citations ? { citations: note.citations } : {}),
            }
          : {}),
      })
    }
  }

  const summary = draft?.summary
  // A blank summary (absent, empty, or whitespace-only — the lenient draft schema doesn't trim)
  // is "no summary": it neither counts as analyst input nor rides along in the output, so the
  // `summary` presence and `hasAnalystInput` signals can't disagree for the same draft.
  const hasSummary = summary !== undefined && summary.trim() !== ''
  const analystContributedRecipe = MERGEABLE_RECIPE_FIELDS.some((field) =>
    isProduced(analystRecipe?.[field]),
  )
  const hasAnalystInput = Boolean(
    draft && (analystContributedRecipe || analystNotes.length > 0 || hasSummary),
  )

  return {
    recipe,
    fields,
    ...(hasSummary ? { summary } : {}),
    analystNotes,
    hasAnalystInput,
  }
}
