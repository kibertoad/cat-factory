import { describe, expect, it } from 'vitest'
import type { CustomTaskType, TaskTypeSuppressionRepository } from '@cat-factory/kernel'
import { createRecordingLogger, defaultTaskTypeRegistry } from '@cat-factory/kernel'
import { suppressedTaskTypeIds, TaskTypeSuppressionService } from './TaskTypeSuppressionService.js'

// The join between a CODE catalog (the registry) and a DATA hide-list (the tombstone rows), plus
// the two failure postures the rest of the feature reads it through.

const presentation = {
  icon: 'i-lucide-plug',
  color: '#0ea5e9',
  description: 'A registered operation.',
}

function operation(taskType: string, label: string): CustomTaskType {
  return { taskType, presentation: { ...presentation, label } }
}

/** In-memory tombstone store; `fail` makes every read throw, for the posture assertions. */
function fakeStore(initial: string[] = [], fail = false) {
  const rows = new Set(initial)
  const repo: TaskTypeSuppressionRepository = {
    list: async () => {
      if (fail) throw new Error('store unreachable')
      return [...rows].sort()
    },
    suppress: async (_ws, taskType) => void rows.add(taskType),
    restore: async (_ws, taskType) => void rows.delete(taskType),
  }
  return { repo, rows }
}

function build(registered: CustomTaskType[], store = fakeStore()) {
  const taskTypeRegistry = defaultTaskTypeRegistry()
  for (const type of registered) taskTypeRegistry.register(type)
  const service = new TaskTypeSuppressionService({
    taskTypeSuppressionRepository: store.repo,
    workspaceRepository: { get: async () => ({ id: 'ws1' }) } as never,
    taskTypeRegistry,
    clock: { now: () => 1000 },
  })
  return { service, store }
}

describe('TaskTypeSuppressionService', () => {
  const HIDDEN = operation('org:hidden', 'Hidden')
  const KEPT = operation('org:kept', 'Kept')

  it('lists every registered operation with its state, in registration order', async () => {
    const { service } = build([HIDDEN, KEPT], fakeStore(['org:hidden']))
    const rows = await service.list('ws1')
    expect(rows.map((r) => [r.taskType.taskType, r.suppressed])).toEqual([
      ['org:hidden', true],
      ['org:kept', false],
    ])
  })

  it('suppresses and restores idempotently', async () => {
    const { service, store } = build([KEPT])
    await service.suppress('ws1', 'org:kept')
    await service.suppress('ws1', 'org:kept')
    expect([...store.rows]).toEqual(['org:kept'])
    await service.restore('ws1', 'org:kept')
    await service.restore('ws1', 'org:kept')
    expect([...store.rows]).toEqual([])
  })

  it('refuses suppressing an id the deployment does not register', async () => {
    // A typo must not leave a tombstone that hides nothing and appears on no screen: the settings
    // list renders the REGISTRY, so a row for an unregistered id is unreachable.
    const { service } = build([KEPT])
    await expect(service.suppress('ws1', 'org:typo')).rejects.toThrow(/not found/i)
  })

  it('allows RESTORING an id the deployment no longer registers', async () => {
    // The asymmetry is deliberate: a withdrawn registration must never strand a row that only a
    // database edit could clear.
    const { service, store } = build([], fakeStore(['org:withdrawn']))
    await service.restore('ws1', 'org:withdrawn')
    expect([...store.rows]).toEqual([])
  })

  it('omits a suppressed id whose registration is gone rather than dropping its row', async () => {
    // Nothing to render (no label, no fields), and deleting the tombstone as a tidy-up would
    // un-hide the operation for a deployment that later restores the registration.
    const { service, store } = build([KEPT], fakeStore(['org:withdrawn']))
    const rows = await service.list('ws1')
    expect(rows.map((r) => r.taskType.taskType)).toEqual(['org:kept'])
    expect([...store.rows]).toEqual(['org:withdrawn'])
  })
})

describe('suppressedTaskTypeIds (the board snapshot read)', () => {
  it('degrades an unreadable store to "nothing suppressed", loudly', async () => {
    // The best-effort half. A picker offering one operation too many is a visible surplus; failing
    // the board load over a cosmetic preference is not. The creation door takes the opposite
    // posture, which is asserted in `taskTypeCreationDefaults.test.ts`.
    const lines: Parameters<typeof createRecordingLogger>[0] = []
    const { service } = build([operation('org:kept', 'Kept')], fakeStore([], true))
    expect(await suppressedTaskTypeIds(service, 'ws1', createRecordingLogger(lines))).toEqual(
      new Set(),
    )
    expect(lines.some((line) => line.level === 'warn')).toBe(true)
  })

  it('is an empty set when the module is not wired at all', async () => {
    expect(await suppressedTaskTypeIds(undefined, 'ws1', createRecordingLogger([]))).toEqual(
      new Set(),
    )
  })
})
