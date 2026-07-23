import { describe, expect, it } from 'vitest'
import {
  createTaskPlanTracker,
  parseCreatedTaskId,
  pickProgress,
  todosToProgress,
} from '../src/progress.js'
import type { TodoProgress } from '../src/pi.js'

// The parent agent's plan, in both tool vocabularies the CLI ships (`TodoWrite` whole-list
// snapshots and the incremental `TaskCreate`/`TaskUpdate` pair), plus the reconciliation with
// the parallel-subagent view (ADR 0027 Defect B).

describe('todosToProgress', () => {
  it('counts a TodoWrite snapshot and keeps list order', () => {
    expect(
      todosToProgress([
        { content: 'Review DB slice', status: 'completed' },
        { content: 'Review auth slice', status: 'in_progress' },
        { content: 'Aggregate findings', status: 'pending' },
      ]),
    ).toEqual({
      completed: 1,
      inProgress: 1,
      total: 3,
      items: [
        { label: 'Review DB slice', status: 'completed' },
        { label: 'Review auth slice', status: 'in_progress' },
        { label: 'Aggregate findings', status: 'pending' },
      ],
    })
  })

  it('treats an unknown status as pending and a non-array as no signal', () => {
    expect(todosToProgress([{ content: 'x', status: 'blocked' }])).toMatchObject({
      completed: 0,
      inProgress: 0,
      total: 1,
    })
    expect(todosToProgress(undefined)).toBeUndefined()
    expect(todosToProgress('nope')).toBeUndefined()
  })
})

describe('parseCreatedTaskId', () => {
  it('reads the id from the rendered result string', () => {
    expect(parseCreatedTaskId('Task #1 created successfully: Track review slices')).toBe('1')
    expect(parseCreatedTaskId('Task #12 created successfully: x')).toBe('12')
  })

  it('reads the id from the structured TaskCreateOutput shape', () => {
    expect(parseCreatedTaskId({ task: { id: '7', subject: 'x' } })).toBe('7')
    expect(parseCreatedTaskId({ task: { id: 7 } })).toBe('7')
  })

  it('reads the id out of content blocks, and gives up cleanly on anything else', () => {
    expect(parseCreatedTaskId([{ type: 'text', text: 'Task #3 created successfully: y' }])).toBe(
      '3',
    )
    expect(parseCreatedTaskId('created, but no id here')).toBeUndefined()
    expect(parseCreatedTaskId(undefined)).toBeUndefined()
  })
})

describe('createTaskPlanTracker', () => {
  const create = (toolUseId: string, subject: string) => ({
    type: 'tool_use',
    name: 'TaskCreate',
    id: toolUseId,
    input: { subject, description: subject },
  })
  const created = (toolUseId: string, taskId: string, subject = 's') => ({
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: `Task #${taskId} created successfully: ${subject}`,
  })
  const update = (taskId: string, status: string, subject?: string) => ({
    type: 'tool_use',
    name: 'TaskUpdate',
    id: `u-${taskId}-${status}`,
    input: { taskId, status, ...(subject ? { subject } : {}) },
  })

  it('builds the plan from TaskCreate and advances it with TaskUpdate', () => {
    const t = createTaskPlanTracker()
    expect(t.progress()).toBeUndefined()

    t.onAssistant([create('c1', 'Review DB slice')])
    t.onUser([created('c1', '1', 'Review DB slice')])
    t.onAssistant([create('c2', 'Review auth slice')])
    t.onUser([created('c2', '2', 'Review auth slice')])
    expect(t.progress()).toEqual({
      completed: 0,
      inProgress: 0,
      total: 2,
      items: [
        { label: 'Review DB slice', status: 'pending' },
        { label: 'Review auth slice', status: 'pending' },
      ],
    })

    t.onAssistant([update('1', 'in_progress')])
    expect(t.progress()).toMatchObject({ completed: 0, inProgress: 1, total: 2 })

    t.onAssistant([update('1', 'completed'), update('2', 'in_progress')])
    expect(t.progress()).toMatchObject({ completed: 1, inProgress: 1, total: 2 })
  })

  it('keeps plan order across the id re-key, and takes a renamed subject', () => {
    const t = createTaskPlanTracker()
    t.onAssistant([create('c1', 'first'), create('c2', 'second')])
    t.onUser([created('c2', '2'), created('c1', '1')]) // results out of dispatch order
    t.onAssistant([update('1', 'completed', 'first (renamed)')])
    expect(t.progress()?.items).toEqual([
      { label: 'first (renamed)', status: 'completed' },
      { label: 'second', status: 'pending' },
    ])
  })

  it('applies an update that arrives before its create was bound', () => {
    const t = createTaskPlanTracker()
    t.onAssistant([create('c1', 'slice')])
    t.onAssistant([update('1', 'in_progress')]) // id not bound yet
    expect(t.progress()).toMatchObject({ inProgress: 0, total: 1 })
    t.onUser([created('c1', '1')])
    expect(t.progress()).toMatchObject({ inProgress: 1, total: 1 })
  })

  it('drops a deleted task from the live plan', () => {
    const t = createTaskPlanTracker()
    t.onAssistant([create('c1', 'keep'), create('c2', 'drop')])
    t.onUser([created('c1', '1'), created('c2', '2')])
    t.onAssistant([update('2', 'deleted')])
    expect(t.progress()).toMatchObject({ total: 1, items: [{ label: 'keep', status: 'pending' }] })
  })

  it('still counts a create whose id never resolves (it just can never advance)', () => {
    const t = createTaskPlanTracker()
    t.onAssistant([create('c1', 'unbound')])
    t.onUser([{ type: 'tool_result', tool_use_id: 'c1', content: 'created, no id in this text' }])
    expect(t.progress()).toMatchObject({ total: 1, completed: 0 })
    t.onAssistant([update('1', 'completed')]) // cannot match — total stays honest
    expect(t.progress()).toMatchObject({ total: 1, completed: 0 })
  })

  it('ignores unrelated tools and a subject-less create falls back to a positional label', () => {
    const t = createTaskPlanTracker()
    t.onAssistant([{ type: 'tool_use', name: 'Bash', id: 'b1', input: { command: 'ls' } }])
    expect(t.progress()).toBeUndefined()
    t.onAssistant([{ type: 'tool_use', name: 'TaskCreate', id: 'c1', input: {} }])
    expect(t.progress()?.items?.[0]?.label).toBe('Task 1')
  })
})

describe('pickProgress (ADR 0027 Defect B)', () => {
  const p = (completed: number, inProgress: number, total: number): TodoProgress => ({
    completed,
    inProgress,
    total,
    items: [],
  })

  it('returns whichever single source is present (or neither)', () => {
    expect(pickProgress(undefined, undefined)).toBeUndefined()
    expect(pickProgress(p(1, 0, 3), undefined)).toEqual(p(1, 0, 3))
    expect(pickProgress(undefined, p(0, 2, 2))).toEqual(p(0, 2, 2))
  })

  it('prefers the slice tracker when the once-written plan is stale', () => {
    // The pr-reviewer shape: the plan is written ONCE (5 slices + an aggregate entry), all
    // pending, and never marked done. The parallel subagent slices are what actually advance
    // — first in flight, then all returned — so the slice tracker must win in both states.
    const stalePlan = p(0, 0, 6)
    expect(pickProgress(stalePlan, p(0, 4, 4))).toEqual(p(0, 4, 4)) // in-flight beats all-pending
    expect(pickProgress(stalePlan, p(4, 0, 4))).toEqual(p(4, 0, 4)) // all returned beats 0 done
  })

  it('prefers the advancing plan for the sequential shape', () => {
    expect(pickProgress(p(3, 1, 6), undefined)).toEqual(p(3, 1, 6))
    expect(pickProgress(p(3, 1, 6), p(0, 2, 2))).toEqual(p(3, 1, 6)) // more completed wins
  })

  it('breaks a completed+inProgress tie toward the richer (more total) view, else the plan', () => {
    expect(pickProgress(p(1, 1, 6), p(1, 1, 4))).toEqual(p(1, 1, 6))
    const todo = p(2, 1, 5)
    expect(pickProgress(todo, p(2, 1, 5))).toBe(todo) // full tie keeps the plan
  })

  it('composes over both plan vocabularies, as the runner chains it', () => {
    // The runner reconciles TodoWrite -> TaskCreate/Update -> slices. A run that plans through
    // TaskCreate/Update (no TodoWrite at all) must still surface its plan.
    const chained = (
      todo: TodoProgress | undefined,
      plan: TodoProgress | undefined,
      slice: TodoProgress | undefined,
    ) => pickProgress(pickProgress(todo, plan), slice)
    expect(chained(undefined, p(1, 1, 3), undefined)).toEqual(p(1, 1, 3))
    expect(chained(undefined, p(0, 0, 6), p(0, 5, 5))).toEqual(p(0, 5, 5))
  })
})
