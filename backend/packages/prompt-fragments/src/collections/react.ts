import type { PromptFragment } from '@cat-factory/contracts'

// Best-practice fragments for React / frontend work.

export const reactFragments: PromptFragment[] = [
  {
    id: 'react.state-management',
    version: '1.0.0',
    title: 'React state management',
    category: 'React',
    summary: 'Keep state local, lift only when shared, derive instead of duplicating.',
    body: [
      'React state management standards:',
      '- Keep state as local as possible; lift it up only when two components genuinely share it.',
      '- Derive values during render instead of storing duplicated/denormalised state.',
      '- Reach for a global store only for truly cross-cutting state; prefer context/props otherwise.',
      '- Keep server state (fetched data) separate from UI state; use a data-fetching cache for it.',
      '- Make effects depend on exactly what they use, and clean them up to avoid leaks.',
    ].join('\n'),
    appliesTo: { blockTypes: ['frontend'] },
  },
]
