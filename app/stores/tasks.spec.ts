import { describe, it, expect, beforeEach } from 'vitest'
import type { SourceTask, TaskConnection, TaskSourceDescriptor } from '~/types/domain'
import { useTasksStore } from '~/stores/tasks'

/** Minimal SourceTask factory — only the fields the read getters care about. */
function sourceTask(externalId: string, over: Partial<SourceTask> = {}): SourceTask {
  return {
    source: 'jira',
    externalId,
    title: externalId,
    url: `https://acme.atlassian.net/browse/${externalId}`,
    status: 'To Do',
    type: 'Task',
    assignee: null,
    priority: null,
    labels: [],
    description: '',
    comments: [],
    excerpt: '',
    linkedBlockId: null,
    syncedAt: 0,
    ...over,
  }
}

const jiraDescriptor: TaskSourceDescriptor = {
  source: 'jira',
  label: 'Jira',
  icon: 'i-lucide-square-check',
  credentialFields: [],
  refLabel: 'Issue key or URL',
  refPlaceholder: 'PROJ-123',
}

const jiraConnection: TaskConnection = { source: 'jira', label: 'acme', connectedAt: 0 }

describe('tasks store read getters', () => {
  let store: ReturnType<typeof useTasksStore>
  beforeEach(() => {
    store = useTasksStore()
  })

  it('tasksForBlock returns only issues linked to the block', () => {
    store.tasks = [
      sourceTask('PROJ-1', { linkedBlockId: 'b1' }),
      sourceTask('PROJ-2', { linkedBlockId: 'b2' }),
      sourceTask('PROJ-3', { linkedBlockId: null }),
    ]
    expect(store.tasksForBlock('b1').map((t) => t.externalId)).toEqual(['PROJ-1'])
    expect(store.tasksForBlock('bX')).toEqual([])
  })

  it('isConnected / connectedSources / anyConnected reflect connections', () => {
    store.sources = [jiraDescriptor]
    expect(store.anyConnected).toBe(false)
    expect(store.isConnected('jira')).toBe(false)
    expect(store.connectedSources).toEqual([])

    store.connections = [jiraConnection]
    expect(store.anyConnected).toBe(true)
    expect(store.isConnected('jira')).toBe(true)
    expect(store.connectedSources.map((s) => s.source)).toEqual(['jira'])
  })

  it('descriptorFor / connectionFor resolve by source', () => {
    store.sources = [jiraDescriptor]
    store.connections = [jiraConnection]
    expect(store.descriptorFor('jira')?.label).toBe('Jira')
    expect(store.connectionFor('jira')?.label).toBe('acme')
  })
})
