import type { Project } from '@cat-factory/contracts'
import { ProjectKindRegistry, registryProjectKindSource, type Block } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { canReparent, rootOf } from './board.logic.js'
import { createProjectTaskAdmission } from './projectTaskAdmission.js'

function block(id: string, level: Block['level'], parentId: string | null): Block {
  return {
    id,
    title: id,
    type: level === 'project' ? 'project' : 'service',
    description: '',
    position: { x: 0, y: 0 },
    status: 'planned',
    progress: 0,
    dependsOn: [],
    executionId: null,
    level,
    parentId,
  }
}

const project: Project = {
  id: 'prj_1',
  accountId: 'acc',
  kind: 'research',
  rootBlockId: 'root',
  serviceIds: [],
  createdAt: 0,
}

function admission(kinds: ProjectKindRegistry, projects: Project[] = [project]) {
  return createProjectTaskAdmission({
    projectRepository: {
      listByRootBlocks: async (ids) => projects.filter((p) => ids.includes(p.rootBlockId)),
    },
    projectKinds: registryProjectKindSource(kinds),
  })
}

function researchKinds(): ProjectKindRegistry {
  const kinds = new ProjectKindRegistry()
  kinds.register({
    id: 'research',
    label: 'Research',
    taskTypes: [{ taskType: 'spike', repoAccess: 'none', defaultPipelineId: 'pl_simple' }],
  })
  return kinds
}

describe('project task admission', () => {
  const root = block('root', 'project', null)

  it("admits a task type the kind offers, with the kind's default pipeline", async () => {
    await expect(admission(researchKinds()).admit(root, 'spike')).resolves.toEqual({
      project,
      defaultPipelineId: 'pl_simple',
    })
  })

  it('refuses a task type the kind does not offer', async () => {
    await expect(admission(researchKinds()).admit(root, 'feature')).rejects.toMatchObject({
      details: { reason: 'task_type_not_offered_by_project' },
    })
  })

  it('names a kind that is no longer registered rather than admitting against nothing', async () => {
    await expect(admission(new ProjectKindRegistry()).admit(root, 'spike')).rejects.toMatchObject({
      details: { reason: 'project_kind_unregistered', kind: 'research' },
    })
  })

  it('refuses a root no project owns', async () => {
    await expect(admission(researchKinds(), []).admit(root, 'spike')).rejects.toMatchObject({
      code: 'not_found',
    })
  })
})

describe('project roots on the board', () => {
  it('resolves a task to its project root, and lets a task but nothing else live under one', () => {
    const root = block('root', 'project', null)
    const task = block('task', 'task', 'root')
    expect(rootOf([root, task], task)?.id).toBe('root')
    expect(canReparent('task', root)).toBe(true)
    expect(canReparent('module', root)).toBe(false)
    expect(canReparent('initiative', root)).toBe(false)
  })
})
