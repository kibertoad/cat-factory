import { describe, it, expect } from 'vitest'
import { buildSourceChoices, reconcileSource } from './taskSources'
import type { TaskSourceState } from '~/types/domain'

/**
 * The pure tracker-selection behind `<ContextIssuePicker>` and `<BugHuntModal>`. Pins what
 * the always-visible selector promises: the tracker in use is named even when it is the only
 * one, a tracker the workspace hasn't got yet is offered as something to ADD (worded for its
 * actual state), and the selection stays valid as the offered set changes underneath it.
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
