import type { PromptFragment } from '@cat-factory/contracts'

// Best-practice fragment for working from linked design context. Source-neutral: every
// design document source (Figma, Zeplin, …) materialises its frames/screens, component
// inventory and design tokens into `.cat-context/*.md` in the SAME shape (`## <block>`
// blocks, a global `### Components`, `### Design tokens`, optional `### References`), so
// one fragment serves them all — the agent doesn't need to know which tool authored it.

export const designFragments: PromptFragment[] = [
  {
    id: 'design.context',
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
    appliesTo: { blockTypes: ['frontend'] },
  },
]
