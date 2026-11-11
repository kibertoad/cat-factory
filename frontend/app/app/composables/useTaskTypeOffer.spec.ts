import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope, nextTick, ref, type EffectScope } from 'vue'
import type { Project, ProjectKindDescriptor } from '@cat-factory/contracts'
import type { Block } from '~/types/domain'
import { useBoardStore } from '~/stores/board'
import { useProjectsStore } from '~/stores/projects'
import { useTaskTypesStore } from '~/stores/taskTypes'
import { useTaskTypeOffer, type TaskTypeChoice } from '~/composables/useTaskTypeOffer'

function root(id: string, over: Partial<Block> = {}): Block {
  return {
    id,
    title: id,
    type: 'service',
    description: '',
    position: { x: 0, y: 0 },
    status: 'planned',
    progress: 0,
    dependsOn: [],
    executionId: null,
    level: 'frame',
    parentId: null,
    ...over,
  }
}

const project: Project = {
  id: 'prj_1',
  accountId: null,
  kind: 'research',
  rootBlockId: 'p1',
  serviceIds: [],
  createdAt: 0,
}

const researchKind: ProjectKindDescriptor = {
  id: 'research',
  label: 'Research',
  taskTypes: [
    // Not a create-form type, so the form cannot open on it.
    { taskType: 'resolve-conflicts', repoAccess: 'none' },
    { taskType: 'spike', defaultPipelineId: 'pl_research', repoAccess: 'linked-read-only' },
    { taskType: 'document', repoAccess: 'none' },
    { taskType: 'recurring', repoAccess: 'none' },
  ],
}

describe('useTaskTypeOffer', () => {
  let scope: EffectScope

  beforeEach(() => {
    const board = useBoardStore()
    const projects = useProjectsStore()
    const taskTypes = useTaskTypesStore()
    vi.stubGlobal('useBoardStore', () => board)
    vi.stubGlobal('useProjectsStore', () => projects)
    vi.stubGlobal('useTaskTypesStore', () => taskTypes)
    board.hydrate([
      root('svc'),
      root('docs', { type: 'document' }),
      root('p1', { level: 'project', type: 'project' }),
    ])
    projects.hydrate({ projectCatalog: [project], projectKinds: [researchKind] })
    scope = effectScope()
  })

  afterEach(() => scope.stop())

  async function offerFor(containerId: string, initial: TaskTypeChoice = 'feature') {
    const container = ref(useBoardStore().getBlock(containerId))
    const taskType = ref<TaskTypeChoice>(initial)
    const offer = scope.run(() => useTaskTypeOffer(container, taskType))!
    await nextTick()
    return { offer, taskType }
  }

  const values = (choices: { value: string }[]) => choices.map((c) => c.value)

  it('offers every type on a service frame and leaves the selection alone', async () => {
    const { offer, taskType } = await offerFor('svc', 'bug')
    expect(values(offer.taskTypeChoices.value)).toContain('recurring')
    expect(offer.defaultTaskType.value).toBe('feature')
    expect(offer.isProject.value).toBe(false)
    expect(taskType.value).toBe('bug')
  })

  it('never offers a research task outside a project, and offers it to a kind that takes it', async () => {
    const onService = await offerFor('svc')
    expect(values(onService.offer.taskTypeChoices.value)).not.toContain('research')
    useProjectsStore().hydrate({
      projectCatalog: [project],
      projectKinds: [
        { ...researchKind, taskTypes: [{ taskType: 'research', repoAccess: 'linked-read-only' }] },
      ],
    })
    const inProject = await offerFor('p1')
    expect(values(inProject.offer.taskTypeChoices.value)).toEqual(['research'])
    expect(inProject.offer.defaultTaskType.value).toBe('research')
  })

  it('narrows a document repository to documents and spikes', async () => {
    const { offer, taskType } = await offerFor('docs')
    expect(values(offer.taskTypeChoices.value)).toEqual(['document', 'spike'])
    expect(offer.defaultTaskType.value).toBe('document')
    expect(taskType.value).toBe('document')
  })

  it("offers a project root its kind's types, never a schedule", async () => {
    const { offer, taskType } = await offerFor('p1')
    expect(values(offer.taskTypeChoices.value)).toEqual(['document', 'spike'])
    expect(offer.isProject.value).toBe(true)
    // The kind's first type the form can show, in the kind's order.
    expect(offer.defaultTaskType.value).toBe('spike')
    expect(taskType.value).toBe('spike')
  })

  it("exposes the kind's default pipeline for a type, and nothing outside a project", async () => {
    const inProject = await offerFor('p1')
    expect(inProject.offer.projectEntry('spike')?.defaultPipelineId).toBe('pl_research')
    expect(inProject.offer.projectEntry('document')?.defaultPipelineId).toBeUndefined()
    const onService = await offerFor('svc')
    expect(onService.offer.projectEntry('spike')).toBeUndefined()
  })
})
