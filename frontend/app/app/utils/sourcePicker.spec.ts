import { describe, it, expect, vi } from 'vitest'
import {
  buildConnectionSourceChoices,
  buildSourceChoices,
  connectableSources,
  menuIsPickable,
  reconcileSource,
  sourceMenuItems,
} from './sourcePicker'
import type { TaskSourceState } from '~/types/domain'

/**
 * The pure source-selection behind `<ContextIssuePicker>`, `<BugHuntModal>` and
 * `<ContextDocumentPicker>`. Pins what the always-visible selector promises: the source in use is
 * named even when it is the only one, a source the workspace hasn't got yet is offered as something
 * to ADD (worded for its actual state), a menu with nothing to decide is not dressed as a control,
 * and the selection stays valid as the offered set changes underneath it.
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

describe('connectableSources', () => {
  const sources = [
    { source: 'github', label: 'GitHub', icon: 'i-lucide-github' },
    { source: 'confluence', label: 'Confluence', icon: 'i-lucide-file-text' },
  ]
  const isConnected = (source: string) => source === 'github'

  it('offers only the sources the workspace has not connected', () => {
    const rows = connectableSources(sources, { isConnected, canConnect: true, available: true })
    expect(rows.map((s) => s.source)).toEqual(['confluence'])
  })

  // Connecting stores a workspace credential and stays admin-tier while attaching moved to the
  // member tier, so a member's add tier is withheld rather than rendered into a 403.
  it('withholds every source from a user who may not connect one', () => {
    expect(
      connectableSources(sources, { isConnected, canConnect: false, available: true }),
    ).toEqual([])
  })

  // The term the three former copies of this rule disagreed about. An integration the deployment
  // has not configured has nothing to connect TO, so it is not the same fact as "already connected"
  // and must not rest on the store happening to clear its source list.
  it('withholds every source when the integration is unavailable to the deployment', () => {
    expect(
      connectableSources(sources, { isConnected: () => false, canConnect: true, available: false }),
    ).toEqual([])
  })
})

describe('buildConnectionSourceChoices', () => {
  const sources = [
    { source: 'github', label: 'GitHub', icon: 'i-lucide-github' },
    { source: 'confluence', label: 'Confluence', icon: 'i-lucide-file-text' },
  ]
  const isConnected = (source: string) => source === 'github'
  const opts = { isConnected, canConnect: true, available: true, selected: 'github' }

  it('offers the connected source and the rest as something to add', () => {
    expect(buildConnectionSourceChoices(sources, opts)).toEqual([
      [
        {
          action: 'select',
          source: 'github',
          label: 'GitHub',
          icon: 'i-lucide-github',
          active: true,
        },
      ],
      [
        {
          action: 'connect',
          source: 'confluence',
          label: 'Confluence',
          icon: 'i-lucide-file-text',
        },
      ],
    ])
  })

  // No per-workspace toggle exists for these sources, so `enable` ("connected but switched off
  // here") is a state they cannot be in. It is unrepresentable in the return TYPE, which is what
  // stops a document surface wording an add entry as "Connect X" for a source already connected;
  // this asserts the runtime half of that.
  it('never words a document source as `enable`', () => {
    const choices = buildConnectionSourceChoices(sources, {
      ...opts,
      isConnected: () => false,
      selected: undefined,
    })
    expect(
      choices
        .flat()
        .map((c) => c.action)
        .every((action) => action === 'connect'),
    ).toBe(true)
  })

  it('yields the connected tier alone for a member, with no add group', () => {
    const choices = buildConnectionSourceChoices(sources, { ...opts, canConnect: false })
    expect(choices).toHaveLength(1)
    expect(choices[0]!.map((c) => c.source)).toEqual(['github'])
  })
})

describe('menuIsPickable', () => {
  // The papercut this exists for, and the one a member hits: a chevron opening a menu whose single
  // entry re-selects what is already selected promises a choice that isn't there.
  it('reports nothing to decide for a lone entry', () => {
    expect(menuIsPickable([[{}]])).toBe(false)
    expect(menuIsPickable([])).toBe(false)
  })

  it('counts across groups, so one source plus one to add IS a choice', () => {
    expect(menuIsPickable([[{}], [{}]])).toBe(true)
    expect(menuIsPickable([[{}, {}]])).toBe(true)
  })
})

describe('sourceMenuItems', () => {
  const onSelect = vi.fn()
  const onAdd = vi.fn()

  it('marks the selected source as CHECKED, not merely glyphed', () => {
    const [offered] = sourceMenuItems(
      buildSourceChoices([state('github'), state('jira')], 'jira'),
      {
        onSelect,
        onAdd,
        addLabel: { connect: (l) => `connect ${l}`, enable: (l) => `enable ${l}` },
      },
    )
    expect(offered!.map((i) => [i.label, i.type, i.checked])).toEqual([
      ['GITHUB', 'checkbox', false],
      ['JIRA', 'checkbox', true],
    ])
  })

  it('words each add entry for its own action and marks it with the plug icon', () => {
    const [, addable] = sourceMenuItems(
      buildSourceChoices(
        [state('github'), state('jira', { available: false }), state('linear', { enabled: false })],
        'github',
      ),
      {
        onSelect,
        onAdd,
        addLabel: { connect: (l) => `connect ${l}`, enable: (l) => `enable ${l}` },
      },
    )
    expect(addable!.map((i) => [i.label, i.icon])).toEqual([
      ['connect JIRA', 'i-lucide-plug'],
      ['enable LINEAR', 'i-lucide-plug'],
    ])
  })

  // A connection-only menu owes ONE wording, and the type says so: passing `enable` here would not
  // compile. That is the guard, and this pins the behaviour it guards.
  it('takes only the `connect` wording for a connection-only menu', () => {
    const items = sourceMenuItems(
      buildConnectionSourceChoices(
        [{ source: 'confluence', label: 'Confluence', icon: 'i-lucide-file-text' }],
        { isConnected: () => false, canConnect: true, available: true, selected: undefined },
      ),
      { onSelect, onAdd, addLabel: { connect: (l) => `Connect ${l}` } },
    )
    expect(items.flat().map((i) => i.label)).toEqual(['Connect Confluence'])
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
