import type { PromptFragment } from '@cat-factory/contracts'

// Best-practice fragment for working from Figma design context. Pairs with the
// Figma document source: when a Figma file/frame is linked to a frontend task, the
// backend materialises its layout tree / text / components / design tokens into
// `.cat-context/*.md`, and this fragment tells the agent how to use them.

export const figmaFragments: PromptFragment[] = [
  {
    id: 'design.figma-context',
    version: '1.0.0',
    title: 'Figma design context',
    category: 'Design',
    summary:
      'Build UI from the linked Figma layout, reusing existing components and honouring design tokens.',
    body: [
      'A Figma design for this task has been materialised into the `.cat-context/` directory',
      '(a `## Frame` layout tree, `### Text content`, `### Components used`, and `### Design tokens`).',
      'When implementing UI, use it as the source of truth for structure and styling:',
      '- Read the `### Layout` tree as the component/element structure to build — follow its nesting and naming.',
      '- Before creating a new component, check `### Components used` against the components that already',
      '  exist in this repository and REUSE the existing one when it matches; do not reinvent it.',
      '- Honour the `### Design tokens` values (colours, spacing, typography) instead of hard-coding ad-hoc',
      '  values; map them to the project’s existing token/theme system where one exists.',
      '- A `Rendered preview:` URL, if present, is reference-only — do not depend on fetching it; the textual',
      '  layout/text/tokens above are the authoritative description.',
    ].join('\n'),
    appliesTo: { blockTypes: ['frontend'] },
  },
]
