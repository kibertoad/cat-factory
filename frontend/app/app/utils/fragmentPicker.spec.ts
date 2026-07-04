import { describe, it, expect } from 'vitest'
import type { PromptFragment } from '~/types/domain'
import { buildFragmentPickerGroups } from './fragmentPicker'

const frag = (id: string, category: string, title = id): PromptFragment =>
  ({ id, version: '1.0.0', title, category, summary: '', body: '' }) as PromptFragment

const pool: PromptFragment[] = [
  frag('node.best-practices', 'Node', 'Node best practices'),
  frag('node.performance', 'Node', 'Node performance'),
  frag('style.anti-llmisms', 'Writing style', 'Avoid LLM tells'),
  frag('style.concise-actionable', 'Writing style', 'Concise and actionable'),
]

describe('buildFragmentPickerGroups', () => {
  it('buckets fragments into one labelled group per category (technical + writing-style tracks)', () => {
    const groups = buildFragmentPickerGroups(
      pool,
      () => false,
      () => {},
    )
    // One group per category, each led by a non-interactive `type: 'label'` heading.
    expect(groups.map((g) => g[0])).toEqual([
      { type: 'label', label: 'Node' },
      { type: 'label', label: 'Writing style' },
    ])
    // The heading is followed by that category's item labels, in pool order.
    expect(groups[0]!.slice(1).map((i) => i.label)).toEqual([
      'Node best practices',
      'Node performance',
    ])
    expect(groups[1]!.slice(1).map((i) => i.label)).toEqual([
      'Avoid LLM tells',
      'Concise and actionable',
    ])
  })

  it('omits already-selected fragments, dropping a category that empties out', () => {
    const selected = new Set(['style.anti-llmisms', 'style.concise-actionable'])
    const groups = buildFragmentPickerGroups(
      pool,
      (id) => selected.has(id),
      () => {},
    )
    // Writing style fully selected → its category disappears entirely (no empty labelled group).
    expect(groups.map((g) => g[0])).toEqual([{ type: 'label', label: 'Node' }])
  })

  it('invokes onSelect with the fragment id when an item is chosen', () => {
    const picked: string[] = []
    const groups = buildFragmentPickerGroups(
      pool,
      () => false,
      (id) => picked.push(id),
    )
    // Fire the first real item under the first category (index 1, past the label heading).
    ;(groups[0]![1] as { onSelect: () => void }).onSelect()
    expect(picked).toEqual(['node.best-practices'])
  })
})
