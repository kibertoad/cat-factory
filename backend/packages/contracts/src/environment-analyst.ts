import * as v from 'valibot'
import { stackRecipeSchema } from './stack-recipes.js'

// ---------------------------------------------------------------------------
// ENVIRONMENT ANALYST DRAFT — the structured output of the opt-in `environment-analyst`
// agent (slice 8 of docs/initiatives/stack-recipes-and-shared-stacks.md). Where the
// DETERMINISTIC detector (`provisioningRecommendationSchema`) reads a repo checkout-free and
// proposes the recipe fields it can see mechanically (compose layering, external networks,
// env-file pairs), the analyst is an LLM that CLONES the repo and reads the imperative parts a
// scan can't — README / Makefile / `bin/*` CLIs / setup scripts / seed dumps — to draft the
// SETUP STEPS + prerequisites + health gate, each grounded in a source CITATION. It returns
// this draft on `result.custom`; the setup wizard (slice 7) merges it as a NON-BINDING draft
// layer (deterministic detector facts win where both produce a field; analyst-only fields
// arrive editable + flagged with the provenance below). It is NEVER persisted or applied
// silently — the compose provider keys purely on the human-confirmed, persisted recipe.
//
// This is deliberately an LLM-OUTPUT contract, so the schema is LENIENT (`v.fallback`): a
// partially-malformed reply degrades to the fields that DID parse rather than discarding the
// whole draft (matching the `bugInvestigation` / `securityAssessment` structured-output
// shapes). The wizard re-validates the drafted `recipe` against the STRICT `stackRecipeSchema`
// when the human saves it onto the service frame.
// ---------------------------------------------------------------------------

/**
 * A source citation grounding a drafted field/step in the repo the analyst read — so the
 * wizard can show "suggested by analysis of `bin/dev-console:112`" (the tracker's rule: cite
 * files, never prose claims — READMEs drift from the compose truth).
 */
export const analystCitationSchema = v.object({
  /** Repo-relative path of the file the evidence came from. */
  path: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
  /** Optional line or line-range within the file (e.g. `112` or `112-140`). */
  lines: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(40))),
  /** Optional short excerpt quoting the grounding evidence. */
  excerpt: v.optional(v.pipe(v.string(), v.maxLength(300))),
})
export type AnalystCitation = v.InferOutput<typeof analystCitationSchema>

/**
 * One provenance note attaching rationale + citations to a drafted recipe aspect. `field`
 * mirrors the deterministic detector's note vocabulary (`composeFiles` | `composeProfiles` |
 * `envFiles` | `externalNetworks` | `prerequisites` | `setupSteps` | `healthGate` | …) and is
 * free-form so a note can target a specific step (e.g. `setupSteps[2]`).
 */
export const analystRecipeNoteSchema = v.object({
  /** Which recipe aspect this note explains (a recipe field name, optionally indexed). */
  field: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  /** Human-readable rationale the wizard surfaces next to the field. */
  rationale: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1000)),
  /** Source citations grounding the rationale in the repo. */
  citations: v.optional(v.array(analystCitationSchema)),
})
export type AnalystRecipeNote = v.InferOutput<typeof analystRecipeNoteSchema>

/**
 * The analyst's structured draft: a proposed {@link stackRecipeSchema | StackRecipe} plus
 * per-field provenance and an overall summary. Every field is fallback-wrapped so a noisy or
 * partially-malformed reply degrades field-by-field (a malformed `recipe` still leaves the
 * `summary` + `notes` intact) rather than dropping the whole draft — matching the other
 * structured-output shapes. NOT a persisted wire type: it rides `result.custom` and is
 * consumed only by the setup wizard.
 */
export const analystRecipeDraftSchema = v.object({
  /** One-paragraph summary of the repo's bring-up as the analyst understood it. */
  summary: v.fallback(v.optional(v.pipe(v.string(), v.maxLength(4000))), undefined),
  /**
   * The drafted recipe. Optional + fallback: a recipe the analyst couldn't shape into a valid
   * {@link stackRecipeSchema} degrades to `undefined` (the wizard then shows the summary/notes
   * and the human configures the recipe manually), instead of failing the whole draft.
   */
  recipe: v.fallback(v.optional(stackRecipeSchema), undefined),
  /** Per-field/step provenance (rationale + citations); dropped as a whole if malformed. */
  notes: v.fallback(v.optional(v.array(analystRecipeNoteSchema)), undefined),
})
export type AnalystRecipeDraft = v.InferOutput<typeof analystRecipeDraftSchema>
