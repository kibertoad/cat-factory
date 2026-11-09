import { describe, expect, it } from 'vitest'
import { ProjectKindRegistry, projectKindTaskType } from './project-kind-registry.js'

describe('ProjectKindRegistry', () => {
  it('serves registered kinds in order and finds a task type entry', () => {
    const registry = new ProjectKindRegistry()
    registry.register({
      id: 'research',
      label: 'Research',
      taskTypes: [{ taskType: 'spike', repoAccess: 'none' }],
    })
    expect(registry.all().map((k) => k.id)).toEqual(['research'])
    const kind = registry.get('research')!
    expect(projectKindTaskType(kind, 'spike')?.repoAccess).toBe('none')
    expect(projectKindTaskType(kind, 'feature')).toBeUndefined()
  })

  it('refuses a kind that offers no task type', () => {
    const registry = new ProjectKindRegistry()
    expect(() => registry.register({ id: 'empty', label: 'Empty', taskTypes: [] })).toThrow(
      /invalid project kind/,
    )
  })
})
