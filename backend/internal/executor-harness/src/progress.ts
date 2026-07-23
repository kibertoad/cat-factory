import { isObject } from './claude-stream.js'
import type { TodoProgress } from './pi.js'

// The parent agent's own PLAN, as progress counts. This is one of the two redundant views a
// pr-reviewer run produces (the other is the parallel-subagent dispatch view in
// `subagents.ts`); {@link pickProgress} reconciles them.
//
// The Claude Code CLI exposes the plan through TWO different tool vocabularies, and which one
// a run uses depends on the CLI build, not on anything the harness controls:
//
//  - `TodoWrite` — one call carrying the WHOLE list (`todos[]`), each entry with its own
//    status. Every call is a complete snapshot, so the last one wins.
//  - `TaskCreate` / `TaskUpdate` — an incremental, id-keyed task list. `TaskCreate` appends a
//    task and the CLI assigns its id in the tool RESULT; `TaskUpdate` moves one task by id.
//
// Both are live in the shipped schema (`sdk-tools.d.ts` in `@anthropic-ai/claude-code` declares
// `TodoWriteInput` AND `TaskCreateInput`/`TaskUpdateInput`), so the harness tracks both rather
// than betting on one. Reading only `TodoWrite` is what pinned a CLI 2.1.x pr-review at 0%:
// the run planned entirely through `TaskCreate`/`TaskUpdate` and the harness saw nothing.
//
// Everything here is best-effort and defensive: an unknown status, a missing id, or a result
// string the CLI reworded degrades to "no progress from this signal" rather than throwing. The
// tool vocabulary is not a stable contract, so this module may only ever ADD signal.

/** Statuses a plan entry can carry; anything unrecognised is treated as not-yet-started. */
export function normalizeStatus(status: unknown): 'pending' | 'in_progress' | 'completed' {
  if (status === 'completed') return 'completed'
  if (status === 'in_progress') return 'in_progress'
  return 'pending'
}

/** Roll a label+status list up into the counts the board renders. Shared by every plan shape. */
export function toProgress(items: { label: string; status: ReturnType<typeof normalizeStatus> }[]) {
  return {
    completed: items.filter((i) => i.status === 'completed').length,
    inProgress: items.filter((i) => i.status === 'in_progress').length,
    total: items.length,
    items,
  }
}

/** Map a `TodoWrite` call's `todos` array onto subtask counts. Each call is a full snapshot. */
export function todosToProgress(todos: unknown): TodoProgress | undefined {
  if (!Array.isArray(todos)) return undefined
  return toProgress(
    todos.filter(isObject).map((t) => ({
      label: typeof t.content === 'string' ? t.content : String(t.content ?? ''),
      status: normalizeStatus(t.status),
    })),
  )
}

/**
 * The id the CLI assigned to a just-created task, read from `TaskCreate`'s tool RESULT.
 *
 * `TaskCreate`'s INPUT carries only `{subject, description}` — the id is minted by the CLI and
 * comes back on the result, so pairing a later `TaskUpdate({taskId})` to the task it created
 * requires reading the result text. The CLI's shipped `TaskCreateOutput` is
 * `{task: {id, subject}}`, but the parent stream's `tool_result` block carries the rendered
 * STRING (`"Task #1 created successfully: <subject>"`), so both shapes are accepted.
 */
export function parseCreatedTaskId(content: unknown): string | undefined {
  if (isObject(content)) {
    const task = isObject(content.task) ? content.task : undefined
    const id = task?.id
    if (typeof id === 'string' && id.trim()) return id.trim()
    if (typeof id === 'number') return String(id)
  }
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter(isObject)
            .map((b) => (typeof b.text === 'string' ? b.text : ''))
            .join('\n')
        : ''
  return /\bTask\s+#(\d+)\b/i.exec(text)?.[1]
}

interface PlannedTask {
  id: string
  label: string
  status: ReturnType<typeof normalizeStatus>
}

/**
 * Tracks the parent's incremental `TaskCreate` / `TaskUpdate` plan.
 *
 * A `TaskCreate` is registered as pending against its tool_use id, then bound to the CLI-assigned
 * task id when its result arrives; `TaskUpdate` moves the bound task. A create whose result is
 * never seen (or whose id can't be parsed) still counts toward `total` under a synthetic key, so
 * the plan size stays honest even when the pairing fails — it simply can never advance.
 *
 * `deleted` tombstones are dropped from the list entirely (matching `TodoWrite`'s live-tasks-only
 * shape), so a task the agent abandons doesn't hold the bar back forever.
 */
export interface TaskPlanTracker {
  /** Feed an `assistant` message's content blocks: registers creates + applies updates. */
  onAssistant(content: unknown[]): void
  /** Feed a `user` message's content blocks: binds each create to its CLI-assigned task id. */
  onUser(content: unknown[]): void
  /** The plan as progress counts, or undefined when nothing has been planned yet. */
  progress(): TodoProgress | undefined
}

export function createTaskPlanTracker(): TaskPlanTracker {
  // Insertion-ordered so `items` render in plan order.
  const tasks = new Map<string, PlannedTask>()
  // tool_use id of an unresolved `TaskCreate` -> the synthetic key it was filed under, so the
  // task can be re-keyed to its real id once the result lands.
  const pendingCreates = new Map<string, string>()
  // Updates that arrived before their target was bound (the CLI can interleave), replayed on bind.
  const orphanUpdates = new Map<string, Partial<PlannedTask>>()
  // `deleted` tombstones for a task id whose create has not bound yet, replayed on bind — else a
  // delete that races ahead of its create leaves the task in the plan forever.
  const pendingDeletes = new Set<string>()

  const apply = (task: PlannedTask, patch: Partial<PlannedTask>): void => {
    if (patch.label) task.label = patch.label
    if (patch.status) task.status = patch.status
  }

  // Drop a tombstoned task. When it isn't present yet (its create hasn't bound), remember the
  // tombstone so the bind drops it rather than leaving it stuck in the plan forever.
  const markDeleted = (taskId: string): void => {
    if (!tasks.delete(taskId)) pendingDeletes.add(taskId)
    orphanUpdates.delete(taskId)
  }

  return {
    onAssistant(content) {
      if (!Array.isArray(content)) return
      for (const block of content) {
        if (!isObject(block) || block.type !== 'tool_use') continue
        const input = isObject(block.input) ? block.input : {}
        if (block.name === 'TaskCreate') {
          const toolUseId = typeof block.id === 'string' ? block.id : undefined
          if (!toolUseId || pendingCreates.has(toolUseId)) continue
          const label =
            (typeof input.subject === 'string' && input.subject.trim()) ||
            (typeof input.description === 'string' && input.description.trim()) ||
            `Task ${tasks.size + 1}`
          const key = `pending:${toolUseId}`
          tasks.set(key, { id: key, label, status: 'pending' })
          pendingCreates.set(toolUseId, key)
        } else if (block.name === 'TaskUpdate') {
          const taskId = typeof input.taskId === 'string' ? input.taskId : undefined
          if (!taskId) continue
          const patch: Partial<PlannedTask> = {}
          if (typeof input.subject === 'string' && input.subject.trim())
            patch.label = input.subject.trim()
          if (input.status === 'deleted') {
            // `deleted` is a tombstone, not a status — drop the task from the live list.
            markDeleted(taskId)
            continue
          }
          if (input.status !== undefined) patch.status = normalizeStatus(input.status)
          const task = tasks.get(taskId)
          if (task) apply(task, patch)
          else orphanUpdates.set(taskId, { ...orphanUpdates.get(taskId), ...patch })
        }
      }
    },
    onUser(content) {
      if (!Array.isArray(content)) return
      for (const block of content) {
        if (!isObject(block) || block.type !== 'tool_result') continue
        const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined
        const key = toolUseId ? pendingCreates.get(toolUseId) : undefined
        if (!key) continue
        const taskId = parseCreatedTaskId(block.content)
        pendingCreates.delete(toolUseId!)
        const task = tasks.get(key)
        // No parsable id ⇒ leave it filed under its synthetic key: it still counts toward the
        // plan total, it just can never be advanced by a later `TaskUpdate`. A parsed id that
        // already names a live task (a duplicate / misparse) is also left under the synthetic key
        // rather than overwriting that task — the rebuild below would otherwise drop a row and
        // undercount `total`.
        if (!taskId || !task || taskId === key || tasks.has(taskId)) continue
        // Re-key in place. Rebuilding the map preserves insertion order, which `items` relies on.
        const entries = [...tasks.entries()]
        tasks.clear()
        for (const [k, v] of entries) {
          if (k !== key) tasks.set(k, v)
          else tasks.set(taskId, { ...v, id: taskId })
        }
        // A tombstone that raced ahead of this bind drops the task now that it exists.
        if (pendingDeletes.delete(taskId)) {
          tasks.delete(taskId)
          orphanUpdates.delete(taskId)
          continue
        }
        const pendingPatch = orphanUpdates.get(taskId)
        if (pendingPatch) {
          const bound = tasks.get(taskId)
          if (bound) apply(bound, pendingPatch)
          orphanUpdates.delete(taskId)
        }
      }
    },
    progress() {
      if (tasks.size === 0) return undefined
      return toProgress([...tasks.values()].map((t) => ({ label: t.label, status: t.status })))
    },
  }
}

/**
 * Reconcile the redundant views of the same work into the one to surface (ADR 0027 Defect B).
 * A pr-reviewer run has BOTH a parent plan (`TodoWrite` or `TaskCreate`/`TaskUpdate`) and the
 * `SliceTracker`'s subagent-dispatch view. The sequential shape advances the plan; the parallel
 * shape advances ONLY the slice tracker (the reviewer writes its plan once and the parallel
 * subagents report in-flight/complete). Neither alone covers both shapes, and gating the slice
 * tracker off whenever a plan exists (the original behaviour) pinned parallel runs at 0%.
 *
 * So prefer whichever view is further along: more `completed`, then more `inProgress` (an
 * all-pending plan must not beat live in-flight slices), then more `total` (the richer view — a
 * plan can carry an extra "aggregate" entry), else the plan. Pure + total; returns whichever
 * single input is present when only one is.
 */
export function pickProgress(
  todo: TodoProgress | undefined,
  slice: TodoProgress | undefined,
): TodoProgress | undefined {
  if (!todo) return slice
  if (!slice) return todo
  if (slice.completed !== todo.completed) return slice.completed > todo.completed ? slice : todo
  if (slice.inProgress !== todo.inProgress) return slice.inProgress > todo.inProgress ? slice : todo
  if (slice.total !== todo.total) return slice.total > todo.total ? slice : todo
  return todo
}
