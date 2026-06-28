import type { PromptFragment } from '@cat-factory/contracts'

// Best-practice fragment for working from Claude Design context. Pairs with the
// Claude Design document source: when a Claude Design project/component is linked to a
// frontend task, the backend materialises its component inventory + design tokens into
// `.cat-context/*.md`, and this fragment tells the agent how to use them. Mirrors the
// Figma fragment — the normalised shape (`### Components`, `### Design tokens`) is the
// same regardless of which design tool authored it.

export const claudeDesignFragments: PromptFragment[] = [
  {
    id: 'design.claude-design-context',
    version: '1.0.0',
    title: 'Claude Design context',
    category: 'Design',
    summary:
      'Build UI from the linked Claude Design system, reusing its components and honouring its design tokens.',
    body: [
      'A Claude Design system for this task has been materialised into the `.cat-context/` directory',
      '(a `## <project>` heading, a grouped `### Components` inventory, and `### Design tokens`).',
      'When implementing UI, use it as the source of truth for the design system:',
      '- Treat the `### Components` inventory as the catalogue of intended components. Before creating a new',
      '  component, check it against the components that already exist in this repository and REUSE the',
      '  existing one when it matches; do not reinvent it.',
      '- Honour the `### Design tokens` values (CSS custom properties — colours, spacing, typography) instead',
      '  of hard-coding ad-hoc values; map them to the project’s existing token/theme system where one exists.',
      '- Any `### Content` text is the component’s copy/intent, not markup to paste verbatim.',
    ].join('\n'),
    appliesTo: { blockTypes: ['frontend'] },
  },
]
