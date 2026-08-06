import type { PromptFragment } from '@cat-factory/contracts'

// Best-practice fragment for working from linked design context. Source-neutral: every
// design document source (Figma, Zeplin, …) materialises its frames/screens, component
// inventory and design tokens into `.cat-context/*.md` in the SAME shape (`## <block>`
// blocks, a global `### Components`, `### Design tokens`, optional `### References`), so
// one fragment serves them all — the agent doesn't need to know which tool authored it.

/**
 * The one fragment that tells an agent how to consume materialised design context.
 *
 * Named as a constant because the ENGINE folds it by presence rather than by selection: a run whose
 * resolved context carries a design-origin document gets it automatically
 * ({@link withDesignContextFragment}). Before that it was auto-selected by nothing — the `appliesTo`
 * selector below is a management-surface hint the run path never drove, the fragment is in no seed pin
 * set, and basic mode hides the per-task fragment picker — so the standard case (a designer links a
 * Figma frame and starts a run) executed with a design context file on disk and no instruction
 * anywhere to honour it.
 */
export const DESIGN_CONTEXT_FRAGMENT_ID = 'design.context'

/**
 * The applicable fragment ids for a run, plus `design.context` when that run actually carries a
 * design document. PURE, and the ONLY place the presence rule lives.
 *
 * A deterministic presence rule at prompt assembly, deliberately NOT a revival of the retired
 * `appliesTo` run-path selector: the trigger is the design document the run resolved, so it cannot
 * drift from what is on disk — whereas a `blockTypes: ['frontend']` selector both misses a design
 * linked to an unlabelled task and fires on a frontend task with no design at all.
 *
 * Appended LAST and only when not already present, so a workspace that pins the fragment explicitly
 * (or overrides it in its own catalog) keeps its position and its single entry.
 */
export function withDesignContextFragment(
  ids: readonly string[],
  hasDesignContext: boolean,
): string[] {
  if (!hasDesignContext || ids.includes(DESIGN_CONTEXT_FRAGMENT_ID)) return [...ids]
  return [...ids, DESIGN_CONTEXT_FRAGMENT_ID]
}

export const designFragments: PromptFragment[] = [
  {
    id: DESIGN_CONTEXT_FRAGMENT_ID,
    version: '1.0.0',
    title: 'Design context',
    category: 'Design',
    summary:
      'Build UI from the linked design (Figma, Zeplin, …): reuse existing components and honour design tokens.',
    body: [
      'A design for this task has been materialised into the `.cat-context/` directory: one or more',
      '`## <frame/screen>` blocks (each with a `### Layout` and/or `### Text content`), a global',
      '`### Components` inventory, and `### Design tokens`. When implementing UI, use it as the source of',
      'truth for structure and styling:',
      '- Read each block’s `### Layout` as the component/element structure to build — follow its nesting and naming.',
      '- Before creating a new component, check the `### Components` inventory against the components that already',
      '  exist in this repository and REUSE the existing one when it matches; do not reinvent it.',
      '- Honour the `### Design tokens` values (colours, spacing, typography) instead of hard-coding ad-hoc',
      '  values; map them to the project’s existing token/theme system where one exists.',
      '- `### Text content` is the screen’s copy/intent, not markup to paste verbatim.',
      '- Any `### References` URL (e.g. a rendered preview) is reference-only — do not depend on fetching it; the',
      '  textual layout/text/tokens above are the authoritative description.',
    ].join('\n'),
    brief:
      'Design context: build UI from the `.cat-context/` design — follow each block’s `### Layout` for structure; reuse an existing repo component before creating one from the `### Components` inventory; honour `### Design tokens` via the project’s theme system instead of ad-hoc values; `### Text content` is copy, not markup; `### References` URLs are reference-only.',
    // No `appliesTo`. The selector this fragment used to carry (`blockTypes: ['frontend']`) was
    // wrong in both directions — it missed a design linked to an unlabelled task and fired on a
    // frontend task with no design — and {@link withDesignContextFragment} replaced it. Leaving it
    // beside the presence rule would keep the old behaviour alive wherever `appliesTo` is still
    // read (the deterministic selector, the catalog gate, the management surface, which would go on
    // labelling this frontend-only while the engine folds it for any block type carrying a design).
  },
]
