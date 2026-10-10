import { describe, expect, it } from 'vitest'
import { defaultTaskTypeRegistry } from './task-type-registry.js'
import type { CustomTaskType } from '@cat-factory/contracts'

// The registry a deployment's own task types live in. `defaultPipelineId` is the one that
// carries a run decision: it is consulted AFTER the built-in map, so what it answers for an
// unregistered type and for a type registered without a pipeline has to be `undefined` rather
// than any pipeline id.

const presentation = (label: string) => ({
  label,
  icon: 'siren',
  color: '#f00',
  description: label,
})

const taskType = (over: Partial<CustomTaskType> = {}): CustomTaskType =>
  ({ taskType: 'incident', presentation: presentation('Incident'), ...over }) as CustomTaskType

describe('TaskTypeRegistry', () => {
  it('starts EMPTY: the built-ins are a closed picklist, not registry entries', () => {
    const registry = defaultTaskTypeRegistry()
    expect(registry.all()).toEqual([])
    expect(registry.get('bug')).toBeUndefined()
    expect(registry.defaultPipelineId('bug')).toBeUndefined()
  })

  it('reads a registration back by its own `taskType`, in registration order', () => {
    const registry = defaultTaskTypeRegistry()
    const incident = taskType({ taskType: 'incident' })
    const audit = taskType({ taskType: 'audit' })
    registry.registerAll([incident, audit])
    expect(registry.all()).toEqual([incident, audit])
    expect(registry.get('incident')).toBe(incident)
    expect(registry.get('audit')).toBe(audit)
  })

  it('re-registering a task type replaces it rather than adding a second entry', () => {
    const registry = defaultTaskTypeRegistry()
    registry.register(taskType({ taskType: 'incident' }))
    registry.register(taskType({ taskType: 'incident', presentation: presentation('Sev-1') }))
    expect(registry.all()).toHaveLength(1)
    expect(registry.get('incident')?.presentation.label).toBe('Sev-1')
  })

  it('answers the registered default pipeline id for a type that pinned one', () => {
    const registry = defaultTaskTypeRegistry()
    registry.register(taskType({ taskType: 'incident', defaultPipelineId: 'pl_incident' }))
    expect(registry.defaultPipelineId('incident')).toBe('pl_incident')
  })

  it('answers undefined for a registered type that pinned NO pipeline', () => {
    // Distinct from "unregistered", and both must leave the caller on the built-in default: a
    // registration is not itself a statement about which pipeline the type runs.
    const registry = defaultTaskTypeRegistry()
    registry.register(taskType({ taskType: 'incident' }))
    expect(registry.get('incident')).toBeDefined()
    expect(registry.defaultPipelineId('incident')).toBeUndefined()
    expect(registry.defaultPipelineId('never-registered')).toBeUndefined()
  })
})
