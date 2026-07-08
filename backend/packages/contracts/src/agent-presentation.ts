import * as v from 'valibot'
import { agentKindSchema } from './primitives.js'
import { RESULT_VIEW_IDS } from './result-views.js'

// ---------------------------------------------------------------------------
// Presentation metadata for an agent kind — the display fields the SPA palette,
// timeline and result-view host render. A registered (custom) agent supplies this so
// it becomes a first-class palette block with the right icon/label/category instead of
// the generic fallback; the server serialises the registered kinds' presentation into
// the workspace snapshot so the frontend catalog stops being a hand-synced mirror.
// ---------------------------------------------------------------------------

/** The palette section an agent groups under. Mirrors the frontend `AGENT_CATEGORIES`. */
export const agentCategorySchema = v.picklist([
  'review',
  'design',
  'build',
  'test',
  'docs',
  'gates',
])
export type AgentCategory = v.InferOutput<typeof agentCategorySchema>

/** Display metadata for one agent kind (the wire shape sent to the SPA). */
export const agentPresentationSchema = v.object({
  /** Human label, e.g. `Security Auditor`. */
  label: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
  /** Icon id (e.g. an `i-lucide-*` name). */
  icon: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  /** Accent colour (CSS hex/keyword). */
  color: v.pipe(v.string(), v.minLength(1), v.maxLength(40)),
  /**
   * One-line description shown in the palette / inspector when the kind is selected. Required
   * and non-empty (like label/icon/color): the SPA renders it verbatim as the palette entry's
   * tooltip + inline text with no fallback, so a blank one would surface as an empty description
   * on a first-class palette block.
   */
  description: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
  /** Palette section; omitted ⇒ the kind is not a standalone palette block (e.g. a companion). */
  category: v.optional(agentCategorySchema),
  /**
   * Id of a dedicated result-view component to open instead of the generic prose panel
   * (e.g. `generic-structured` for a custom structured agent). One of the canonical
   * {@link RESULT_VIEW_IDS} — an unknown id fails validation here rather than silently
   * falling back to prose. Omitted ⇒ the generic step-detail panel.
   */
  resultView: v.optional(v.picklist(RESULT_VIEW_IDS)),
})
export type AgentPresentation = v.InferOutput<typeof agentPresentationSchema>

/** A registered agent kind's id + presentation + whether it runs in a container — the
 * snapshot entry the SPA merges into its palette catalog. */
export const customAgentKindSchema = v.object({
  kind: agentKindSchema,
  presentation: agentPresentationSchema,
  /** Whether the kind runs in a container (vs an inline LLM call). */
  container: v.boolean(),
})
export type CustomAgentKind = v.InferOutput<typeof customAgentKindSchema>
