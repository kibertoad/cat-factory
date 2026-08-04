import { describe, it, expect } from 'vitest'
import type { CustomTaskType } from '~/types/domain'
import { buildTaskTypePickerRows, type TaskTypePickerChoice } from './taskTypePicker'

const BUILT_INS: TaskTypePickerChoice[] = [
  { value: 'feature', label: 'Feature', icon: 'i-lucide-sparkles' },
  { value: 'bug', label: 'Bug', icon: 'i-lucide-bug' },
]

/** The localized chrome the caller passes in; the util never authors a display string itself. */
const CAPTIONS = { other: 'Other' }

const custom = (
  taskType: string,
  category?: string,
  description = `What ${taskType} does`,
): CustomTaskType =>
  ({
    taskType,
    presentation: {
      label: taskType.split(':')[1] ?? taskType,
      icon: 'i-lucide-plug',
      color: '#0ea5e9',
      description,
      ...(category === undefined ? {} : { category }),
    },
  }) as CustomTaskType

describe('buildTaskTypePickerRows', () => {
  it('puts the built-in types first, in one uncaptioned row', () => {
    const rows = buildTaskTypePickerRows(
      BUILT_INS,
      [custom('org:introduce-api', 'API delivery')],
      CAPTIONS,
    )

    expect(rows[0]).toEqual({ id: 'built-in', caption: null, choices: BUILT_INS })
    expect(rows[1]?.caption).toBe('API delivery')
  })

  it('groups custom types sharing a category under one caption, in first-appearance order', () => {
    const rows = buildTaskTypePickerRows(
      BUILT_INS,
      [
        custom('org:introduce-api', 'API delivery'),
        custom('org:onboard-tenant', 'Tenancy'),
        custom('org:retire-endpoint', 'API delivery'),
      ],
      CAPTIONS,
    )

    // Registration order is the only order the deployment expressed, so it is the caption order,
    // NOT alphabetical (which would put 'API delivery' first by accident here).
    expect(rows.slice(1).map((r) => r.caption)).toEqual(['API delivery', 'Tenancy'])
    expect(rows[1]?.choices.map((c) => c.value)).toEqual([
      'org:introduce-api',
      'org:retire-endpoint',
    ])
    expect(rows[2]?.choices.map((c) => c.value)).toEqual(['org:onboard-tenant'])
  })

  it('carries the verbatim wire presentation onto each custom choice', () => {
    const rows = buildTaskTypePickerRows(
      BUILT_INS,
      [custom('org:introduce-api', 'API delivery', 'Expose functionality over the standard API.')],
      CAPTIONS,
    )

    expect(rows[1]?.choices[0]).toEqual({
      value: 'org:introduce-api',
      label: 'introduce-api',
      icon: 'i-lucide-plug',
      description: 'Expose functionality over the standard API.',
    })
  })

  it('folds captions differing only in case or spacing into one row, keeping the first spelling', () => {
    const rows = buildTaskTypePickerRows(
      BUILT_INS,
      [custom('org:introduce-api', 'API delivery'), custom('org:retire-endpoint', 'api  DELIVERY')],
      CAPTIONS,
    )

    // One row, captioned as the deployment first wrote it: a second heading differing only in case
    // would read as a second category its author never declared.
    expect(rows).toHaveLength(2)
    expect(rows[1]?.caption).toBe('API delivery')
    expect(rows[1]?.id).toBe('category:api delivery')
    expect(rows[1]?.choices.map((c) => c.value)).toEqual([
      'org:introduce-api',
      'org:retire-endpoint',
    ])
  })

  it('keeps captions that differ beyond case and spacing apart, non-ASCII included', () => {
    const rows = buildTaskTypePickerRows(
      [],
      [custom('org:ambito', 'Ámbito'), custom('org:embito', 'Émbito')],
      CAPTIONS,
    )

    expect(rows.map((r) => r.caption)).toEqual(['Ámbito', 'Émbito'])
  })

  it('captions the trailing uncategorized row with the caller chrome string', () => {
    const rows = buildTaskTypePickerRows(
      BUILT_INS,
      [
        custom('acme:incident'),
        custom('org:introduce-api', 'API delivery'),
        custom('acme:pentest'),
      ],
      CAPTIONS,
    )

    expect(rows.map((r) => r.caption)).toEqual([null, 'API delivery', 'Other'])
    expect(rows[2]).toEqual({
      id: 'other',
      caption: 'Other',
      choices: [
        expect.objectContaining({ value: 'acme:incident' }),
        expect.objectContaining({ value: 'acme:pentest' }),
      ],
    })
  })

  it('leaves the uncategorized row uncaptioned when it is the only row', () => {
    // Nothing precedes it, so a heading would name a distinction the picker does not show.
    const rows = buildTaskTypePickerRows([], [custom('acme:incident')], CAPTIONS)

    expect(rows).toEqual([
      {
        id: 'other',
        caption: null,
        choices: [expect.objectContaining({ value: 'acme:incident' })],
      },
    ])
  })

  it('treats a blank category as no category rather than an empty caption', () => {
    // A CODE-shipped consumer type skips the wire schema's `v.trim()`, so this is reachable.
    const rows = buildTaskTypePickerRows(BUILT_INS, [custom('acme:incident', '   ')], CAPTIONS)

    expect(rows.map((r) => r.id)).toEqual(['built-in', 'other'])
  })

  it('emits no rows for empty inputs, and no custom rows when nothing is registered', () => {
    expect(buildTaskTypePickerRows([], [], CAPTIONS)).toEqual([])
    expect(buildTaskTypePickerRows(BUILT_INS, [], CAPTIONS).map((r) => r.id)).toEqual(['built-in'])
  })

  it('keeps a row per category even when only custom types are offered', () => {
    const rows = buildTaskTypePickerRows(
      [],
      [custom('org:introduce-api', 'API delivery')],
      CAPTIONS,
    )

    expect(rows.map((r) => r.caption)).toEqual(['API delivery'])
  })
})
