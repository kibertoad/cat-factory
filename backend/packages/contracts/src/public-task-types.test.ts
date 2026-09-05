import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import {
  BUILTIN_PUBLIC_TASK_FIELDS,
  builtinPublicTaskFields,
  isBuiltinCreateTaskType,
} from './public-task-types.js'
import { validateDescriptorFields } from './form-fields.js'
import type { DescriptorField, DescriptorFieldValue } from './form-fields.js'
import { BUILTIN_CREATE_TASK_TYPES, taskTypeFieldsSchema } from './primitives.js'

// `BUILTIN_PUBLIC_TASK_FIELDS` states as DESCRIPTORS what `taskTypeFieldsSchema` states as valibot
// pipes, because a descriptor is data a client READS (the discovery response tells a caller a limit
// before it sends) where a pipe is only a check. Two statements of one fact, and this is what stops
// them drifting: everything the public surface accepts must be something the internal schema also
// accepts, or a caller fills a field the create path then refuses with a raw schema error.
//
// Deliberately NOT a count or an equality: the public table is a documented SUBSET (the per-DocKind
// prose sections stay internal), so pinning "these are the same set" would fail on every legitimate
// internal addition and teach the next person to re-pin it unread. What is asserted is the
// structural relation that has to hold in the direction that matters.

/** One value each descriptor type accepts, for round-tripping a descriptor through the schema. */
function sampleValue(field: DescriptorField): DescriptorFieldValue {
  switch (field.type) {
    case 'number':
      return field.min ?? 1
    case 'checkbox':
      return true
    case 'checkbox-group':
      return field.options?.length ? [field.options[0]!.value] : []
    case 'select':
      return field.options?.[0]?.value ?? ''
    default:
      return 'x'
  }
}

const everyPublicField = Object.entries(BUILTIN_PUBLIC_TASK_FIELDS).flatMap(([taskType, fields]) =>
  fields.map((field) => ({ taskType, field })),
)

describe('BUILTIN_PUBLIC_TASK_FIELDS', () => {
  it('covers every built-in create type, so no type reads as unknown rather than field-less', () => {
    // Derived from the same picklist the wire schema uses, never a hand-listed count: adding a
    // built-in type must fail HERE (with a name) rather than silently serve an empty catalog entry.
    expect(Object.keys(BUILTIN_PUBLIC_TASK_FIELDS).sort()).toEqual(
      [...BUILTIN_CREATE_TASK_TYPES].sort(),
    )
    for (const taskType of BUILTIN_CREATE_TASK_TYPES) {
      expect(isBuiltinCreateTaskType(taskType)).toBe(true)
      expect(Array.isArray(builtinPublicTaskFields(taskType))).toBe(true)
    }
    expect(builtinPublicTaskFields('acme:incident')).toEqual([])
    expect(isBuiltinCreateTaskType('acme:incident')).toBe(false)
  })

  it.each(
    everyPublicField.map((entry) => [`${entry.taskType}.${entry.field.key}`, entry] as const),
  )(
    'declares %s as a field the internal task-field schema accepts the same values for',
    (_name, { field }) => {
      // The relation that must hold: a value this descriptor calls valid parses against
      // `taskTypeFieldsSchema`. A key the internal schema never declared is stripped by its
      // `v.object`, so the parsed result naming the key is what proves it exists there.
      const value = sampleValue(field)
      expect(validateDescriptorFields([field], { [field.key]: value })).toEqual([])
      const parsed = v.parse(taskTypeFieldsSchema, { [field.key]: value })
      expect(Object.keys(parsed)).toContain(field.key)
    },
  )

  it.each(
    everyPublicField
      .filter((entry) => entry.field.type === 'number')
      .map((entry) => [`${entry.taskType}.${entry.field.key}`, entry] as const),
  )('agrees with the internal schema about a FRACTIONAL %s', (_name, { field }) => {
    // The relation the sample value above structurally cannot see: it is drawn from `min`, which
    // is a whole number in every descriptor, so a public field that admits `4.5` where the
    // internal schema pipes `v.integer()` round-trips clean here and refuses the caller at
    // creation with a raw parse error naming nothing they can fix. What must hold is that the two
    // doors AGREE, in either direction: both admit a fraction, or both refuse it.
    const low = field.min ?? 1
    const fraction = field.max !== undefined && low + 0.5 > field.max ? field.max - 0.5 : low + 0.5
    const admittedByDescriptor =
      validateDescriptorFields([field], { [field.key]: fraction }).length === 0
    const admittedBySchema = v.safeParse(taskTypeFieldsSchema, { [field.key]: fraction }).success
    expect(admittedByDescriptor).toBe(admittedBySchema)
  })

  it('bounds a string field no wider than the internal schema does', () => {
    // The bound is RESTATED rather than derived, so the direction that matters is that the public
    // one never promises more than the internal one honours. `stepsToReproduce` is the widest
    // restatement (2000 against an internal 4000), which is the safe direction.
    const repro = BUILTIN_PUBLIC_TASK_FIELDS.bug!.find((f) => f.key === 'stepsToReproduce')!
    const atLimit = 'x'.repeat(repro.maxLength!)
    expect(validateDescriptorFields([repro], { stepsToReproduce: atLimit })).toEqual([])
    expect(() => v.parse(taskTypeFieldsSchema, { stepsToReproduce: atLimit })).not.toThrow()
    expect(validateDescriptorFields([repro], { stepsToReproduce: `${atLimit}x` })).toHaveLength(1)
  })

  it('draws a select’s options from the same closed vocabulary the schema enforces', () => {
    // A caption list that drifted from the picklist would advertise a choice creation refuses.
    const severity = BUILTIN_PUBLIC_TASK_FIELDS.bug!.find((f) => f.key === 'severity')!
    for (const option of severity.options ?? []) {
      expect(() => v.parse(taskTypeFieldsSchema, { severity: option.value })).not.toThrow()
    }
    expect(validateDescriptorFields([severity], { severity: 'apocalyptic' })).toHaveLength(1)
  })
})
