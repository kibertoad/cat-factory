import { describe, it, expect } from 'vitest'
import { buildSourceChoices, connectionSourceRows, reconcileSource } from './sourcePicker'
import type { TaskSourceState } from '~/types/domain'

/**
 * The pure source-selection behind `<ContextIssuePicker>`, `<BugHuntModal>` and
 * `<ContextDocumentPicker>`. Pins what the always-visible selector promises: the source in use
 * is named even when it is the only one, a source the workspace hasn't got yet is offered as
 * something to ADD (worded for its actual state), and the selection stays valid as the offered
 * set changes underneath it.
 */
const state = (source: string, { available = true, enabled = true } = {}): TaskSourceState =>
  ({
    source,
    label: source.toUpperCase(),
    icon: `i-lucide-${source}`,
    available,
    enabled,
    credentialFields: [],
    refLabel: '',
    refPlaceholder: '',
  }) as unknown as TaskSourceState

describe('buildSourceChoices', () => {
  it('lists a single offered tracker, marked active (the selector is never hidden)', () => {
    const groups = buildSourceChoices([state('github')], 'github')
    expect(groups).toEqual([
      [
        {
          action: 'select',
          source: 'github',
          label: 'GITHUB',
          icon: 'i-lucide-github',
          active: true,
        },
      ],
    ])
  })

  it('marks only the selected tracker active', () => {
    const [offered] = buildSourceChoices([state('github'), state('jira')], 'jira')
    expect(offered!.map((c) => [c.source, 'active' in c && c.active])).toEqual([
      ['github', false],
      ['jira', true],
    ])
  })

  it('offers an unavailable tracker as `connect` and an available-but-off one as `enable`', () => {
    const [, addable] = buildSourceChoices(
      [state('github'), state('jira', { available: false }), state('linear', { enabled: false })],
      'github',
    )
    expect(addable).toEqual([
      { action: 'connect', source: 'jira', label: 'JIRA', icon: 'i-lucide-jira' },
      { action: 'enable', source: 'linear', label: 'LINEAR', icon: 'i-lucide-linear' },
    ])
  })

  // What a surface's "nothing connected yet" state renders its add buttons from: it flattens
  // the groups, so every choice there has to be addable. A `select` leaking through would
  // offer to connect a tracker the workspace already has.
  it('yields only addable choices when the workspace offers no tracker', () => {
    const choices = buildSourceChoices(
      [state('jira', { available: false }), state('linear', { enabled: false })],
      undefined,
    ).flat()
    expect(choices.map((c) => c.action)).toEqual(['connect', 'enable'])
  })

  it('drops empty groups so the menu renders no stray separator', () => {
    expect(buildSourceChoices([state('github')], 'github')).toHaveLength(1)
    expect(buildSourceChoices([state('jira', { available: false })], undefined)).toHaveLength(1)
    expect(buildSourceChoices([], undefined)).toEqual([])
  })
})

describe('connectionSourceRows', () => {
  const sources = [
    { source: 'github', label: 'GitHub', icon: 'i-lucide-github' },
    { source: 'confluence', label: 'Confluence', icon: 'i-lucide-file-text' },
  ]
  const isConnected = (source: string) => source === 'github'

  it('offers the connected source and the rest as something to add', () => {
    const rows = connectionSourceRows(sources, { isConnected, canConnect: true })
    const [offered, addable] = buildSourceChoices(rows, 'github')
    expect(offered).toEqual([
      {
        action: 'select',
        source: 'github',
        label: 'GitHub',
        icon: 'i-lucide-github',
        active: true,
      },
    ])
    expect(addable).toEqual([
      { action: 'connect', source: 'confluence', label: 'Confluence', icon: 'i-lucide-file-text' },
    ])
  })

  // A member can attach a document but not connect a source, so the add tier is withheld
  // rather than rendered into a 403.
  it('withholds the unconnected sources from a user who cannot connect one', () => {
    const rows = connectionSourceRows(sources, { isConnected, canConnect: false })
    expect(rows.map((r) => r.source)).toEqual(['github'])
    expect(buildSourceChoices(rows, 'github')).toHaveLength(1)
  })

  // No per-workspace toggle exists for these sources, so `enable` — "connected but switched
  // off here" — is a state they cannot be in, and the wording must never appear.
  it('never words a document source as `enable`', () => {
    const rows = connectionSourceRows(sources, { isConnected: () => false, canConnect: true })
    expect(
      buildSourceChoices(rows, undefined)
        .flat()
        .map((c) => c.action),
    ).toEqual(['connect', 'connect'])
  })
})

describe('reconcileSource', () => {
  it('selects the tracker the user just went off to connect, once it is offered', () => {
    expect(reconcileSource(['github', 'jira'], 'github', 'jira')).toBe('jira')
  })

  it('keeps the current selection while the connect is still pending', () => {
    expect(reconcileSource(['github'], 'github', 'jira')).toBe('github')
  })

  it('keeps a still-offered selection', () => {
    expect(reconcileSource(['github', 'jira'], 'jira', null)).toBe('jira')
  })

  it('falls back to the first offered tracker when the selection stopped being offered', () => {
    expect(reconcileSource(['github'], 'jira', null)).toBe('github')
  })

  it('selects the first offered tracker when nothing is selected yet', () => {
    expect(reconcileSource(['github'], undefined, null)).toBe('github')
  })

  it('resolves to nothing when the workspace offers no tracker at all', () => {
    expect(reconcileSource([], 'jira', 'jira')).toBeUndefined()
  })
})
